import fs from "node:fs";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Incremental JSONL indexer for raw chat messages.
 *
 * Reads session JSONL files and indexes new messages into chat_messages + FTS.
 * Uses watermarks to avoid re-scanning the full file on each update.
 *
 * ponytail: Phase 1 — append-oriented, INSERT OR IGNORE, deterministic stable_key.
 */

export type IndexResult = {
  indexed: number;
  skipped: number;
  errors: number;
};

type WatermarkRow = {
  source_file: string;
  size_bytes: number;
  mtime_ms: number;
  last_line: number;
  last_indexed_at_ms: number;
};

type JsonlRecord = {
  type?: string;
  id?: string;
  message?: {
    role?: string;
    content?: unknown;
    id?: string;
    timestamp?: number;
    idempotencyKey?: string;
    [key: string]: unknown;
  };
  timestamp?: number;
  [key: string]: unknown;
};

/**
 * Build a deterministic stable_key for a JSONL message record.
 * Priority: message.id → source_file + source_line + hash(raw_json).
 */
function buildStableKey(
  record: JsonlRecord,
  sourceFile: string,
  sourceLine: number,
  rawJson: string,
): string {
  const messageId = record.id || record.message?.id;
  if (messageId && typeof messageId === "string") {
    return `msg:${messageId}`;
  }
  const hash = createHash("sha256").update(rawJson).digest("hex").slice(0, 16);
  return `line:${sourceFile}:${sourceLine}:${hash}`;
}

/**
 * Extract searchable text from a JSONL message record's content field.
 * Strips large base64 payloads and media metadata.
 */
function extractText(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.replace(/\s+/g, " ").trim();
    return trimmed || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    // Skip large base64 payloads (media inline)
    if (record.text.length > 10_000 && /^data:[a-z]+\/[a-z]+;base64,/.test(record.text)) {
      parts.push("[media]");
      continue;
    }
    const normalized = record.text.replace(/\s+/g, " ").trim();
    if (normalized) {
      parts.push(normalized);
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Index a single session JSONL file incrementally.
 */
export function indexSessionFile(
  db: DatabaseSync,
  sourceFile: string,
  agentId: string,
  sessionKey?: string,
): IndexResult {
  const result: IndexResult = { indexed: 0, skipped: 0, errors: 0 };

  if (!fs.existsSync(sourceFile)) {
    return result;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourceFile);
  } catch {
    return result;
  }

  // Check watermark
  const watermark = getWatermark(db, sourceFile);
  const lastLine = watermark?.last_line ?? 0;

  // If file hasn't changed, skip
  if (
    watermark &&
    watermark.size_bytes === stat.size &&
    watermark.mtime_ms === stat.mtimeMs
  ) {
    return result;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sourceFile, "utf-8");
  } catch {
    return result;
  }

  const lines = raw.split(/\r?\n/);
  const now = Date.now();

  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO chat_messages (
      stable_key, session_id, session_key, agent_id, channel,
      message_id, parent_id, role, timestamp_ms, timestamp_iso,
      date_key, text, raw_json, source_file, source_line, indexed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Use manual transaction for atomicity (node:sqlite DatabaseSync doesn't have .transaction())
  try {
    db.exec(`BEGIN IMMEDIATE`);
    for (let i = lastLine; i < lines.length; i++) {
      const line = lines[i];
      if (!line?.trim()) {
        continue;
      }

      let record: JsonlRecord;
      try {
        record = JSON.parse(line);
      } catch {
        result.errors++;
        continue;
      }

      // Only index message records
      if (!record || record.type !== "message" || !record.message) {
        continue;
      }

      const msg = record.message;
      const role = typeof msg.role === "string" ? msg.role : null;
      if (!role) {
        result.errors++;
        continue;
      }

      const text = extractText(msg.content);
      if (!text) {
        result.skipped++;
        continue;
      }

      const stableKey = buildStableKey(record, sourceFile, i + 1, line);
      const timestampMs = typeof msg.timestamp === "number"
        ? msg.timestamp
        : typeof record.timestamp === "number"
          ? record.timestamp
          : now;
      const timestampIso = new Date(timestampMs).toISOString();
      const dateKey = timestampIso.slice(0, 10);

      // Parse sessionKey components if available
      const channel = sessionKey ? extractChannelFromSessionKey(sessionKey) : null;
      const messageId = typeof msg.id === "string" ? msg.id : null;
      const parentId = typeof msg.parentId === "string" ? msg.parentId : null;

      // Extract session_id from the JSONL header or file path
      const sessionId = extractSessionId(record, sourceFile);

      try {
        insertMsg.run(
          stableKey,
          sessionId,
          sessionKey ?? null,
          agentId,
          channel,
          messageId,
          parentId,
          role,
          timestampMs,
          timestampIso,
          dateKey,
          text,
          line,
          sourceFile,
          i + 1,
          now,
        );

        // Insert into FTS if the row was actually inserted (not ignored)
        const rowId = db.prepare(`SELECT last_insert_rowid() as id`).get() as { id: number };
        if (rowId.id > 0) {
          db.prepare(`
            INSERT INTO chat_messages_fts (rowid, text, role, session_id, timestamp_iso)
            VALUES (?, ?, ?, ?, ?)
          `).run(rowId.id, text, role, sessionId, timestampIso);
          result.indexed++;
        } else {
          result.skipped++;
        }
      } catch {
        result.errors++;
      }
    }

    // Update watermark
    updateWatermark(db, sourceFile, stat.size, stat.mtimeMs, lines.length, now);
    db.exec(`COMMIT`);
  } catch {
    try {
      db.exec(`ROLLBACK`);
    } catch {
      // Rollback also failed; best-effort.
    }
  }

  return result;
}

function getWatermark(db: DatabaseSync, sourceFile: string): WatermarkRow | null {
  try {
    return db.prepare(`SELECT * FROM chat_index_watermarks WHERE source_file = ?`).get(
      sourceFile,
    ) as WatermarkRow | undefined ?? null;
  } catch {
    return null;
  }
}

function updateWatermark(
  db: DatabaseSync,
  sourceFile: string,
  sizeBytes: number,
  mtimeMs: number,
  lastLine: number,
  nowMs: number,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO chat_index_watermarks
    (source_file, size_bytes, mtime_ms, last_line, last_indexed_at_ms)
    VALUES (?, ?, ?, ?, ?)
  `).run(sourceFile, sizeBytes, mtimeMs, lastLine, nowMs);
}

function extractSessionId(record: JsonlRecord, sourceFile: string): string {
  // Try to get session ID from the JSONL header
  if (record.id && typeof record.id === "string") {
    return record.id;
  }
  // Fall back to extracting from file path (e.g., .../sessions/abc123.jsonl)
  const match = sourceFile.match(/([a-z0-9][\w.-]*?)\.jsonl$/i);
  return match?.[1] ?? "unknown";
}

function extractChannelFromSessionKey(sessionKey: string): string | null {
  // Session keys are typically: agent:<agentId>:<channel>:<type>:<id>
  const parts = sessionKey.split(":");
  if (parts.length >= 3) {
    return parts[2] ?? null;
  }
  return null;
}

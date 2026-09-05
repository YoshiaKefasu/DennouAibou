import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { resolveStateDir } from "../../../src/plugin-sdk/state-paths.js";
import { getRawChatDatabase, type RawChatDatabase } from "./database.js";
import type {
  BackfillResult,
  ChatMessageRecord,
  IndexSessionResult,
  RawChatMessageInput,
} from "./types.js";

export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
      } else if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        parts.push(part.text);
      }
    }
    return parts.join("\n").trim();
  }
  if (
    content &&
    typeof content === "object" &&
    "text" in content &&
    typeof content.text === "string"
  ) {
    return content.text;
  }
  return "";
}

function resolveChannelFromKey(sessionKey?: string): string | null {
  if (!sessionKey) {
    return null;
  }
  const parts = sessionKey.split(":");
  if (parts.length >= 3 && parts[0] === "agent" && parts[2]) {
    return parts[2];
  }
  return null;
}

function computeLineHash(line: string): string {
  return crypto.createHash("sha256").update(line).digest("hex").slice(0, 16);
}

export function indexSessionFile(params: {
  db?: RawChatDatabase;
  sessionFile: string;
  agentId: string;
  sessionKey?: string;
}): IndexSessionResult {
  const { sessionFile, agentId, sessionKey } = params;
  if (!fs.existsSync(sessionFile)) {
    return { indexed: 0, skipped: 0, errors: 0 };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(sessionFile);
  } catch {
    return { indexed: 0, skipped: 0, errors: 1 };
  }

  const db = params.db ?? getRawChatDatabase(agentId);
  const wm = db.getWatermark(sessionFile);

  const mtimeMs = Math.round(stat.mtimeMs);
  const sizeBytes = stat.size;

  if (wm && wm.size_bytes === sizeBytes && wm.mtime_ms === mtimeMs) {
    return { indexed: 0, skipped: 0, errors: 0 };
  }

  const lastLine = wm ? wm.last_line : 0;
  let fileContent: string;
  try {
    fileContent = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return { indexed: 0, skipped: 0, errors: 1 };
  }

  const allLines = fileContent.split(/\r?\n/);
  const newLines = allLines.slice(lastLine);

  if (newLines.length === 0) {
    return { indexed: 0, skipped: 0, errors: 0 };
  }

  let defaultSessionId = path.basename(sessionFile, path.extname(sessionFile));
  const channel = resolveChannelFromKey(sessionKey);
  const now = Date.now();

  const recordsToInsert: ChatMessageRecord[] = [];
  let indexed = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < newLines.length; i++) {
    const rawLine = newLines[i];
    if (!rawLine || !rawLine.trim()) {
      continue;
    }

    const currentLineNumber = lastLine + i + 1;
    let parsed: RawChatMessageInput;
    try {
      parsed = JSON.parse(rawLine) as RawChatMessageInput;
    } catch {
      errors++;
      continue;
    }

    // Header record check
    if (parsed.type === "session" && typeof parsed.id === "string") {
      defaultSessionId = parsed.id;
      continue;
    }

    // Only process message records
    if (parsed.type !== "message" || !parsed.message) {
      continue;
    }

    const msg = parsed.message;
    const role = msg.role ?? "user";
    const text = extractTextFromContent(msg.content);

    if (!text.trim()) {
      skipped++;
      continue;
    }

    const messageId =
      typeof parsed.id === "string" ? parsed.id : typeof msg.id === "string" ? msg.id : undefined;
    const parentId =
      typeof parsed.parentId === "string"
        ? parsed.parentId
        : typeof msg.parentId === "string"
          ? msg.parentId
          : null;

    let timestampMs = 0;
    if (typeof msg.timestamp === "number" && msg.timestamp > 0) {
      timestampMs = msg.timestamp;
    } else if (typeof parsed.timestamp === "number" && parsed.timestamp > 0) {
      timestampMs = parsed.timestamp;
    } else if (typeof parsed.timestamp === "string") {
      const parsedTime = Date.parse(parsed.timestamp);
      if (!Number.isNaN(parsedTime)) {
        timestampMs = parsedTime;
      }
    }

    if (timestampMs === 0) {
      timestampMs = mtimeMs > 0 ? mtimeMs : now;
    }

    const timestampIso = new Date(timestampMs).toISOString();
    const dateKey = timestampIso.slice(0, 10);

    const stableKey = messageId
      ? `${defaultSessionId}:${messageId}`
      : `${sessionFile}:${currentLineNumber}:${computeLineHash(rawLine)}`;

    recordsToInsert.push({
      stable_key: stableKey,
      session_id: defaultSessionId,
      session_key: sessionKey ?? null,
      agent_id: agentId,
      channel: channel ?? null,
      message_id: messageId ?? null,
      parent_id: parentId ?? null,
      role,
      timestamp_ms: timestampMs,
      timestamp_iso: timestampIso,
      date_key: dateKey,
      text,
      raw_json: rawLine,
      source_file: sessionFile,
      source_line: currentLineNumber,
      metadata_json: msg.metadata ? JSON.stringify(msg.metadata) : null,
      indexed_at_ms: now,
    });
  }

  if (recordsToInsert.length > 0) {
    try {
      indexed = db.insertMessages(recordsToInsert);
    } catch {
      errors += recordsToInsert.length;
    }
  }

  db.setWatermark({
    source_file: sessionFile,
    size_bytes: sizeBytes,
    mtime_ms: mtimeMs,
    last_line: allLines.length,
    last_indexed_at_ms: now,
  });

  return { indexed, skipped, errors };
}

export async function backfillSessionFiles(
  agentId: string,
  options?: {
    sessionDir?: string;
    db?: RawChatDatabase;
    env?: NodeJS.ProcessEnv;
  },
): Promise<BackfillResult> {
  const env = options?.env ?? process.env;
  const targetDir =
    options?.sessionDir ?? path.join(resolveStateDir(env), "agents", agentId, "sessions");

  if (!fs.existsSync(targetDir)) {
    return {
      total_files: 0,
      indexed_files: 0,
      skipped_files: 0,
      total_messages: 0,
      errors: 0,
    };
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(targetDir);
  } catch {
    return {
      total_files: 0,
      indexed_files: 0,
      skipped_files: 0,
      total_messages: 0,
      errors: 1,
    };
  }

  const jsonlFiles = entries
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(targetDir, name));

  let totalMessages = 0;
  let indexedFiles = 0;
  let skippedFiles = 0;
  let totalErrors = 0;

  const db = options?.db ?? getRawChatDatabase(agentId, env);

  for (const file of jsonlFiles) {
    try {
      const result = indexSessionFile({
        db,
        sessionFile: file,
        agentId,
      });
      if (result.indexed > 0) {
        indexedFiles++;
        totalMessages += result.indexed;
      } else {
        skippedFiles++;
      }
      totalErrors += result.errors;
    } catch {
      totalErrors++;
    }
  }

  return {
    total_files: jsonlFiles.length,
    indexed_files: indexedFiles,
    skipped_files: skippedFiles,
    total_messages: totalMessages,
    errors: totalErrors,
  };
}

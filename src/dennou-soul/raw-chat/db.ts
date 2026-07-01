import fs from "node:fs";
import path from "node:path";
import { requireNodeSqlite } from "../../memory-host-sdk/host/sqlite.js";
import { ensureRawChatSchema, getSchemaVersion, RAW_CHAT_SCHEMA_VERSION } from "./schema.js";

/**
 * Open or create the raw chat SQLite DB for a given agent.
 *
 * ponytail: Follows per-agent DB path from plan §14: ~/.openclaw/agents/<agentId>/raw-chat.sqlite
 */

export type RawChatDb = {
  db: ReturnType<typeof import("node:sqlite").DatabaseSync.prototype>;
  dbPath: string;
};

export function resolveRawChatDbPath(agentId: string): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() ?? path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".openclaw",
  );
  return path.join(stateDir, "agents", agentId, "raw-chat.sqlite");
}

export function openRawChatDb(agentId: string): RawChatDb {
  const { DatabaseSync } = requireNodeSqlite();
  const dbPath = resolveRawChatDbPath(agentId);

  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // Enable WAL for concurrent read/write
  try {
    db.exec(`PRAGMA journal_mode=WAL;`);
  } catch {
    // Best-effort; fallback to default journal mode.
  }

  ensureRawChatSchema(db);

  return { db, dbPath };
}

export function openRawChatDbReadOnly(agentId: string): RawChatDb | null {
  const dbPath = resolveRawChatDbPath(agentId);
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true } as never);
  return { db, dbPath };
}

export function verifyRawChatSchema(db: ReturnType<typeof import("node:sqlite").DatabaseSync.prototype>): boolean {
  const version = getSchemaVersion(db);
  return version === RAW_CHAT_SCHEMA_VERSION;
}

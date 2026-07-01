import type { DatabaseSync } from "node:sqlite";

/**
 * Raw chat permanent DB schema.
 *
 * This schema indexes session JSONL messages into a searchable SQLite DB
 * with FTS5 keyword support. The session JSONL remains the source of truth;
 * this DB is a derived searchable index.
 *
 * ponytail: Phase 1 — no sqlite-vec, no LanceDB, no semantic search.
 */

export const RAW_CHAT_SCHEMA_VERSION = "1";

export function ensureRawChatSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY,
      stable_key TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      session_key TEXT,
      agent_id TEXT NOT NULL,
      channel TEXT,
      message_id TEXT,
      parent_id TEXT,
      role TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      timestamp_iso TEXT NOT NULL,
      date_key TEXT NOT NULL,
      text TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_line INTEGER NOT NULL,
      indexed_at_ms INTEGER NOT NULL
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp_ms);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_date ON chat_messages(date_key);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_channel ON chat_messages(agent_id, channel);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_message_id ON chat_messages(message_id);`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_role ON chat_messages(role);`);

  ensureFtsTable(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_index_watermarks (
      source_file TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      last_line INTEGER NOT NULL,
      last_indexed_at_ms INTEGER NOT NULL
    );
  `);

  setSchemaVersion(db, RAW_CHAT_SCHEMA_VERSION);
}

function ensureFtsTable(db: DatabaseSync): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
        text,
        role UNINDEXED,
        session_id UNINDEXED,
        timestamp_iso UNINDEXED,
        content='chat_messages',
        content_rowid='id',
        tokenize='unicode61'
      );
    `);
  } catch {
    // FTS5 may not be available in all Node builds; degrade gracefully.
  }
}

export function getSchemaVersion(db: DatabaseSync): string | null {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setSchemaVersion(db: DatabaseSync, version: string): void {
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
    version,
  );
}

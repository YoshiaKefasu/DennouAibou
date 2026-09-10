import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../../../src/infra/node-sqlite.js";
import { resolveStateDir } from "../../../src/plugin-sdk/state-paths.js";
import type {
  ChatMessageRecord,
  EmbeddingRecord,
  InsertEmbeddingParams,
  LoadedEmbeddings,
  SearchParams,
  SearchResult,
  SearchResults,
  WatermarkRecord,
} from "./types.js";
import { blobToVector, normalizeL2, vectorToBlob } from "./vector-math.js";

const DEFAULT_SNIPPET_MAX_LENGTH = 300;
const SCHEMA_VERSION = "1";

export function resolveRawChatDbPath(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env);
  const targetAgentId = agentId?.trim() ? agentId.trim() : "main";
  return path.join(stateDir, "agents", targetAgentId, "raw-chat.sqlite");
}

function truncateSnippet(text: string, maxLen = DEFAULT_SNIPPET_MAX_LENGTH): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLen)}...`;
}

function escapeFts5(value: string): string {
  const cleaned = value.replace(/['"()*^:]/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  // Split terms and wrap non-empty tokens in double quotes for safe matching
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return "";
  }
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" AND ");
}

function parseTimestampMs(value?: string): number {
  if (!value) {
    return 0;
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && numeric > 0) {
    return numeric;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export class RawChatDatabase {
  private db: DatabaseSync;
  private fts5Available = false;
  private readonly dbPath: string;

  constructor(dbPathOrDb: string | DatabaseSync) {
    if (typeof dbPathOrDb === "string") {
      this.dbPath = dbPathOrDb;
      if (dbPathOrDb !== ":memory:") {
        const dir = path.dirname(dbPathOrDb);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
      }
      const { DatabaseSync: DbClass } = requireNodeSqlite();
      this.db = new DbClass(dbPathOrDb);
    } else {
      this.dbPath = ":memory:";
      this.db = dbPathOrDb;
    }

    this.configurePragmas();
    this.ensureSchema();
  }

  private configurePragmas(): void {
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
    } catch {
      // Best-effort for memory DBs or environments with restricted pragmas
    }
  }

  private ensureSchema(): void {
    // Meta table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Main raw chat message ledger
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        metadata_json TEXT,
        indexed_at_ms INTEGER NOT NULL
      );
    `);

    // Secondary indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_date ON chat_messages(date_key);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_channel ON chat_messages(agent_id, channel);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_message_id ON chat_messages(message_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_parent_id ON chat_messages(parent_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_role ON chat_messages(role);
    `);

    // FTS5 Virtual Table & Triggers
    try {
      this.db.exec(`
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

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
          INSERT INTO chat_messages_fts(rowid, text, role, session_id, timestamp_iso)
          VALUES (new.id, new.text, new.role, new.session_id, new.timestamp_iso);
        END;
        CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
          INSERT INTO chat_messages_fts(chat_messages_fts, rowid, text, role, session_id, timestamp_iso)
          VALUES('delete', old.id, old.text, old.role, old.session_id, old.timestamp_iso);
        END;
        CREATE TRIGGER IF NOT EXISTS chat_messages_au AFTER UPDATE ON chat_messages BEGIN
          INSERT INTO chat_messages_fts(chat_messages_fts, rowid, text, role, session_id, timestamp_iso)
          VALUES('delete', old.id, old.text, old.role, old.session_id, old.timestamp_iso);
          INSERT INTO chat_messages_fts(rowid, text, role, session_id, timestamp_iso)
          VALUES (new.id, new.text, new.role, new.session_id, new.timestamp_iso);
        END;
      `);
      this.fts5Available = true;
    } catch {
      this.fts5Available = false;
    }

    // Vector embeddings for the two-stage recall pipeline (RAW_CHAT_SEARCH §4.1)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL DEFAULT 1280,
        embedding BLOB NOT NULL,
        text_snippet TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chat_embeddings_session ON chat_embeddings(session_id);
    `);

    // Watermarks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_index_watermarks (
        source_file TEXT PRIMARY KEY,
        size_bytes INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        last_line INTEGER NOT NULL,
        last_indexed_at_ms INTEGER NOT NULL
      );
    `);

    // Schema version
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?);",
    );
    stmt.run(SCHEMA_VERSION);
  }

  public isFts5Available(): boolean {
    return this.fts5Available;
  }

  public getRawDb(): DatabaseSync {
    return this.db;
  }

  /**
   * Inserts or replaces the embedding for `messageId`.
   *
   * The vector is L2-normalized before it is stored (RAW_CHAT_SEARCH §4.2), so a
   * recall query only needs an inner product to get a 0.0 - 1.0 similarity.
   * Normalizing here rather than at each call site keeps that invariant true for
   * every future caller; `normalizeL2` is idempotent for already-unit vectors.
   */
  public insertEmbedding(params: InsertEmbeddingParams): void {
    const dimensions = params.dimensions ?? params.embedding.length;
    if (params.embedding.length !== dimensions) {
      throw new Error(
        `raw-chat-search: embedding length ${params.embedding.length} does not match dimensions ${dimensions}`,
      );
    }

    const stmt = this.db.prepare(`
      INSERT INTO chat_embeddings (
        message_id, session_id, dimensions, embedding, text_snippet, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        session_id = excluded.session_id,
        dimensions = excluded.dimensions,
        embedding = excluded.embedding,
        text_snippet = excluded.text_snippet,
        created_at_ms = excluded.created_at_ms;
    `);

    stmt.run(
      params.messageId,
      params.sessionId,
      dimensions,
      vectorToBlob(normalizeL2(params.embedding)),
      params.textSnippet,
      Date.now(),
    );
  }

  public getEmbeddingByMessageId(messageId: number): EmbeddingRecord | null {
    const stmt = this.db.prepare(`
      SELECT id, message_id, dimensions, embedding, text_snippet
      FROM chat_embeddings
      WHERE message_id = ?
      LIMIT 1;
    `);
    const row = stmt.get(messageId) as
      | {
          id: number | bigint;
          message_id: number | bigint;
          dimensions: number | bigint;
          embedding: Uint8Array;
          text_snippet: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: Number(row.id),
      messageId: Number(row.message_id),
      embedding: blobToVector(row.embedding, Number(row.dimensions)),
      textSnippet: String(row.text_snippet),
    };
  }

  /**
   * Loads every stored embedding into one flat `Float32Array` for in-memory
   * similarity search (RAW_CHAT_SEARCH §6: load once, then query without disk I/O).
   *
   * Rows whose dimension differs from the dominant dimension are skipped; mixing
   * dimensions in one flat buffer would corrupt every score after the first row.
   * Returns an empty result when no embeddings are stored.
   */
  public loadAllEmbeddings(sessionId?: string): LoadedEmbeddings {
    const where = sessionId ? "WHERE session_id = ?" : "";
    const args: string[] = sessionId ? [sessionId] : [];

    const countStmt = this.db.prepare(`
      SELECT COUNT(*) AS total FROM chat_embeddings ${where};
    `);
    const countRow = countStmt.get(...args) as { total: number | bigint } | undefined;
    if (Number(countRow?.total ?? 0) === 0) {
      return { messageIds: [], vectors: new Float32Array(0), count: 0, dim: 0 };
    }

    // Dominant dimension wins; higher dimensions break ties so the production
    // 1280-dimension rows outrank accidental stragglers. Mixing dimensions in one
    // flat buffer would corrupt every score after the first row, so rows that do
    // not match the dominant dimension are dropped.
    const dimStmt = this.db.prepare(`
      SELECT dimensions, COUNT(*) AS total
      FROM chat_embeddings ${where}
      GROUP BY dimensions
      ORDER BY total DESC, dimensions DESC
      LIMIT 1;
    `);
    const dimRow = dimStmt.get(...args) as
      | { dimensions: number | bigint; total: number | bigint }
      | undefined;
    const dim = Number(dimRow?.dimensions ?? 0);
    const rowCount = Number(dimRow?.total ?? 0);
    if (dim <= 0 || rowCount === 0) {
      return { messageIds: [], vectors: new Float32Array(0), count: 0, dim: 0 };
    }

    const rowStmt = this.db.prepare(`
      SELECT message_id, embedding
      FROM chat_embeddings
      ${where ? `${where} AND` : "WHERE"} dimensions = ?
      ORDER BY id ASC;
    `);
    const rows = rowStmt.iterate(...args, dim);

    const messageIds: number[] = [];
    const vectors = new Float32Array(rowCount * dim);
    let offset = 0;
    for (const raw of rows) {
      const row = raw as { message_id: number | bigint; embedding: Uint8Array };
      const blob = row.embedding;
      if (blob.byteLength !== dim * 4) {
        continue;
      }
      // `iterate()` may reuse its row buffer and node:sqlite blobs are not
      // guaranteed to be 4-byte aligned, so copy through `blobToVector`.
      vectors.set(blobToVector(blob, dim), offset * dim);
      messageIds.push(Number(row.message_id));
      offset += 1;
    }

    if (offset !== rowCount) {
      // Defensive: a malformed row changed the element count mid-iteration.
      return {
        messageIds,
        vectors: vectors.subarray(0, offset * dim),
        count: offset,
        dim,
      };
    }

    return { messageIds, vectors, count: offset, dim };
  }

  public getPath(): string {
    return this.dbPath;
  }

  public getWatermark(sourceFile: string): WatermarkRecord | null {
    const stmt = this.db.prepare(`
      SELECT source_file, size_bytes, mtime_ms, last_line, last_indexed_at_ms
      FROM chat_index_watermarks
      WHERE source_file = ?
      LIMIT 1;
    `);
    const row = stmt.get(sourceFile) as
      | {
          source_file: string;
          size_bytes: number | bigint;
          mtime_ms: number | bigint;
          last_line: number | bigint;
          last_indexed_at_ms: number | bigint;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      source_file: String(row.source_file),
      size_bytes: Number(row.size_bytes),
      mtime_ms: Number(row.mtime_ms),
      last_line: Number(row.last_line),
      last_indexed_at_ms: Number(row.last_indexed_at_ms),
    };
  }

  public setWatermark(wm: WatermarkRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chat_index_watermarks (
        source_file, size_bytes, mtime_ms, last_line, last_indexed_at_ms
      ) VALUES (?, ?, ?, ?, ?);
    `);
    stmt.run(wm.source_file, wm.size_bytes, wm.mtime_ms, wm.last_line, wm.last_indexed_at_ms);
  }

  public insertMessage(msg: ChatMessageRecord): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO chat_messages (
        stable_key, session_id, session_key, agent_id, channel,
        message_id, parent_id, role, timestamp_ms, timestamp_iso,
        date_key, text, raw_json, source_file, source_line, metadata_json, indexed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    const result = stmt.run(
      msg.stable_key,
      msg.session_id,
      msg.session_key ?? null,
      msg.agent_id,
      msg.channel ?? null,
      msg.message_id ?? null,
      msg.parent_id ?? null,
      msg.role,
      msg.timestamp_ms,
      msg.timestamp_iso,
      msg.date_key,
      msg.text,
      msg.raw_json,
      msg.source_file,
      msg.source_line,
      msg.metadata_json ?? null,
      msg.indexed_at_ms,
    );

    return Number(result.changes) > 0;
  }

  public insertMessages(msgs: readonly ChatMessageRecord[]): number {
    if (msgs.length === 0) {
      return 0;
    }

    this.db.exec("BEGIN TRANSACTION;");
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO chat_messages (
          stable_key, session_id, session_key, agent_id, channel,
          message_id, parent_id, role, timestamp_ms, timestamp_iso,
          date_key, text, raw_json, source_file, source_line, metadata_json, indexed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);

      let insertedCount = 0;
      for (const msg of msgs) {
        const result = stmt.run(
          msg.stable_key,
          msg.session_id,
          msg.session_key ?? null,
          msg.agent_id,
          msg.channel ?? null,
          msg.message_id ?? null,
          msg.parent_id ?? null,
          msg.role,
          msg.timestamp_ms,
          msg.timestamp_iso,
          msg.date_key,
          msg.text,
          msg.raw_json,
          msg.source_file,
          msg.source_line,
          msg.metadata_json ?? null,
          msg.indexed_at_ms,
        );
        if (Number(result.changes) > 0) {
          insertedCount++;
        }
      }

      this.db.exec("COMMIT;");
      return insertedCount;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  public search(params: SearchParams): SearchResults {
    const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
    const contextBefore = Math.max(0, Math.min(params.context_before ?? 0, 10));
    const contextAfter = Math.max(0, Math.min(params.context_after ?? 0, 10));

    if (params.message_id?.trim()) {
      return this.searchByMessageId(
        params.message_id.trim(),
        contextBefore,
        contextAfter,
        params.agent_id,
      );
    }

    if (params.query?.trim()) {
      if (this.fts5Available) {
        try {
          return this.searchByFts(params, limit, contextBefore, contextAfter);
        } catch {
          // Gracefully degrade to LIKE on FTS syntax or execution error
          return this.searchByLike(params, limit, contextBefore, contextAfter);
        }
      }
      return this.searchByLike(params, limit, contextBefore, contextAfter);
    }

    return this.searchByFilters(params, limit, contextBefore, contextAfter);
  }

  private searchByMessageId(
    messageId: string,
    contextBefore: number,
    contextAfter: number,
    agentId?: string,
  ): SearchResults {
    const conditions = ["message_id = ?"];
    const args: (string | number)[] = [messageId];
    if (agentId) {
      conditions.push("agent_id = ?");
      args.push(agentId);
    }

    const stmt = this.db.prepare(`
      SELECT id, message_id, session_id, agent_id, channel, role, timestamp_iso, text,
             source_file, source_line, timestamp_ms
      FROM chat_messages
      WHERE ${conditions.join(" AND ")}
      LIMIT 1;
    `);

    const target = stmt.get(...args) as
      | {
          id: number | bigint;
          message_id: string;
          session_id: string;
          agent_id: string;
          channel: string | null;
          role: string;
          timestamp_iso: string;
          text: string;
          source_file: string;
          source_line: number | bigint;
          timestamp_ms: number | bigint;
        }
      | undefined;

    if (!target) {
      return { results: [], count: 0 };
    }

    const results: SearchResult[] = [];
    const targetId = Number(target.id);
    const targetSessionId = target.session_id;

    // Surrounding context before
    if (contextBefore > 0) {
      const beforeStmt = this.db.prepare(`
        SELECT message_id, session_id, agent_id, channel, role, timestamp_iso, text
        FROM chat_messages
        WHERE session_id = ? AND id < ?
        ORDER BY id DESC
        LIMIT ?;
      `);
      const beforeRows = beforeStmt.all(targetSessionId, targetId, contextBefore) as Array<{
        message_id: string | null;
        session_id: string;
        agent_id: string;
        channel: string | null;
        role: string;
        timestamp_iso: string;
        text: string;
      }>;

      // Reverse to chronological order
      for (let i = beforeRows.length - 1; i >= 0; i--) {
        const row = beforeRows[i];
        results.push({
          message_id: row.message_id ?? undefined,
          session_id: row.session_id,
          agent_id: row.agent_id,
          channel: row.channel ?? undefined,
          role: row.role,
          timestamp: row.timestamp_iso,
          snippet: truncateSnippet(row.text),
        });
      }
    }

    // Target message
    results.push({
      message_id: target.message_id,
      session_id: target.session_id,
      agent_id: target.agent_id,
      channel: target.channel ?? undefined,
      role: target.role,
      timestamp: target.timestamp_iso,
      snippet: truncateSnippet(target.text),
    });

    // Surrounding context after
    if (contextAfter > 0) {
      const afterStmt = this.db.prepare(`
        SELECT message_id, session_id, agent_id, channel, role, timestamp_iso, text
        FROM chat_messages
        WHERE session_id = ? AND id > ?
        ORDER BY id ASC
        LIMIT ?;
      `);
      const afterRows = afterStmt.all(targetSessionId, targetId, contextAfter) as Array<{
        message_id: string | null;
        session_id: string;
        agent_id: string;
        channel: string | null;
        role: string;
        timestamp_iso: string;
        text: string;
      }>;

      for (const row of afterRows) {
        results.push({
          message_id: row.message_id ?? undefined,
          session_id: row.session_id,
          agent_id: row.agent_id,
          channel: row.channel ?? undefined,
          role: row.role,
          timestamp: row.timestamp_iso,
          snippet: truncateSnippet(row.text),
        });
      }
    }

    return { results, count: results.length };
  }

  private searchByFts(
    params: SearchParams,
    limit: number,
    contextBefore: number,
    contextAfter: number,
  ): SearchResults {
    const escaped = escapeFts5(params.query ?? "");
    if (!escaped) {
      return { results: [], count: 0 };
    }

    const conditions: string[] = ["chat_messages_fts MATCH ?"];
    const args: (string | number)[] = [escaped];

    if (params.date) {
      conditions.push("m.date_key = ?");
      args.push(params.date);
    }
    if (params.from) {
      const ms = parseTimestampMs(params.from);
      if (ms > 0) {
        conditions.push("m.timestamp_ms >= ?");
        args.push(ms);
      }
    }
    if (params.to) {
      const ms = parseTimestampMs(params.to);
      if (ms > 0) {
        conditions.push("m.timestamp_ms <= ?");
        args.push(ms);
      }
    }
    if (params.role) {
      conditions.push("m.role = ?");
      args.push(params.role);
    }
    if (params.agent_id) {
      conditions.push("m.agent_id = ?");
      args.push(params.agent_id);
    }
    if (params.channel) {
      conditions.push("m.channel = ?");
      args.push(params.channel);
    }

    const query = `
      SELECT m.id, m.message_id, m.session_id, m.agent_id, m.channel, m.role, m.timestamp_iso, m.text
      FROM chat_messages m
      INNER JOIN chat_messages_fts f ON f.rowid = m.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY m.timestamp_ms DESC
      LIMIT ?;
    `;
    args.push(limit);

    return this.executeSearchWithContext(query, args, contextBefore, contextAfter);
  }

  private searchByLike(
    params: SearchParams,
    limit: number,
    contextBefore: number,
    contextAfter: number,
  ): SearchResults {
    const conditions: string[] = ["text LIKE ?"];
    const args: (string | number)[] = [`%${params.query}%`];

    if (params.date) {
      conditions.push("date_key = ?");
      args.push(params.date);
    }
    if (params.from) {
      const ms = parseTimestampMs(params.from);
      if (ms > 0) {
        conditions.push("timestamp_ms >= ?");
        args.push(ms);
      }
    }
    if (params.to) {
      const ms = parseTimestampMs(params.to);
      if (ms > 0) {
        conditions.push("timestamp_ms <= ?");
        args.push(ms);
      }
    }
    if (params.role) {
      conditions.push("role = ?");
      args.push(params.role);
    }
    if (params.agent_id) {
      conditions.push("agent_id = ?");
      args.push(params.agent_id);
    }
    if (params.channel) {
      conditions.push("channel = ?");
      args.push(params.channel);
    }

    const query = `
      SELECT id, message_id, session_id, agent_id, channel, role, timestamp_iso, text
      FROM chat_messages
      WHERE ${conditions.join(" AND ")}
      ORDER BY timestamp_ms DESC
      LIMIT ?;
    `;
    args.push(limit);

    return this.executeSearchWithContext(query, args, contextBefore, contextAfter);
  }

  private searchByFilters(
    params: SearchParams,
    limit: number,
    contextBefore: number,
    contextAfter: number,
  ): SearchResults {
    const conditions: string[] = [];
    const args: (string | number)[] = [];

    if (params.date) {
      conditions.push("date_key = ?");
      args.push(params.date);
    }
    if (params.from) {
      const ms = parseTimestampMs(params.from);
      if (ms > 0) {
        conditions.push("timestamp_ms >= ?");
        args.push(ms);
      }
    }
    if (params.to) {
      const ms = parseTimestampMs(params.to);
      if (ms > 0) {
        conditions.push("timestamp_ms <= ?");
        args.push(ms);
      }
    }
    if (params.role) {
      conditions.push("role = ?");
      args.push(params.role);
    }
    if (params.agent_id) {
      conditions.push("agent_id = ?");
      args.push(params.agent_id);
    }
    if (params.channel) {
      conditions.push("channel = ?");
      args.push(params.channel);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const query = `
      SELECT id, message_id, session_id, agent_id, channel, role, timestamp_iso, text
      FROM chat_messages
      ${where}
      ORDER BY timestamp_ms DESC
      LIMIT ?;
    `;
    args.push(limit);

    return this.executeSearchWithContext(query, args, contextBefore, contextAfter);
  }

  private executeSearchWithContext(
    query: string,
    args: readonly (string | number)[],
    contextBefore: number,
    contextAfter: number,
  ): SearchResults {
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...args) as Array<{
      id: number | bigint;
      message_id: string | null;
      session_id: string;
      agent_id: string;
      channel: string | null;
      role: string;
      timestamp_iso: string;
      text: string;
    }>;

    const results: SearchResult[] = [];
    for (const row of rows) {
      let context: string[] | undefined;
      if (contextBefore > 0 || contextAfter > 0) {
        context = this.fetchContextLines(
          row.session_id,
          Number(row.id),
          contextBefore,
          contextAfter,
        );
      }

      results.push({
        message_id: row.message_id ?? undefined,
        session_id: row.session_id,
        agent_id: row.agent_id,
        channel: row.channel ?? undefined,
        role: row.role,
        timestamp: row.timestamp_iso,
        snippet: truncateSnippet(row.text),
        ...(context && context.length > 0 ? { context } : {}),
      });
    }

    return { results, count: results.length };
  }

  private fetchContextLines(
    sessionId: string,
    targetId: number,
    contextBefore: number,
    contextAfter: number,
  ): string[] {
    const lines: string[] = [];

    if (contextBefore > 0) {
      const beforeStmt = this.db.prepare(`
        SELECT role, timestamp_iso, text
        FROM chat_messages
        WHERE session_id = ? AND id < ?
        ORDER BY id DESC
        LIMIT ?;
      `);
      const beforeRows = beforeStmt.all(sessionId, targetId, contextBefore) as Array<{
        role: string;
        timestamp_iso: string;
        text: string;
      }>;
      for (let i = beforeRows.length - 1; i >= 0; i--) {
        const r = beforeRows[i];
        lines.push(`[${r.timestamp_iso}] ${r.role}: ${truncateSnippet(r.text, 150)}`);
      }
    }

    if (contextAfter > 0) {
      const afterStmt = this.db.prepare(`
        SELECT role, timestamp_iso, text
        FROM chat_messages
        WHERE session_id = ? AND id > ?
        ORDER BY id ASC
        LIMIT ?;
      `);
      const afterRows = afterStmt.all(sessionId, targetId, contextAfter) as Array<{
        role: string;
        timestamp_iso: string;
        text: string;
      }>;
      for (const r of afterRows) {
        lines.push(`[${r.timestamp_iso}] ${r.role}: ${truncateSnippet(r.text, 150)}`);
      }
    }

    return lines;
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore if already closed
    }
  }
}

const dbCache = new Map<string, RawChatDatabase>();

export function getRawChatDatabase(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
): RawChatDatabase {
  const dbPath = resolveRawChatDbPath(agentId, env);
  let cached = dbCache.get(dbPath);
  if (!cached) {
    cached = new RawChatDatabase(dbPath);
    dbCache.set(dbPath, cached);
  }
  return cached;
}

export function closeAllRawChatDatabases(): void {
  for (const db of dbCache.values()) {
    db.close();
  }
  dbCache.clear();
}

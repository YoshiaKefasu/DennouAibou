import type { DatabaseSync } from "node:sqlite";

/**
 * Search operations for the raw chat DB.
 *
 * ponytail: Phase 1 — FTS5 keyword search + date/time range filters + context expansion.
 */

export type ChatSearchResult = {
  messageId: string | null;
  timestamp: string;
  role: string;
  sessionKey: string | null;
  channel: string | null;
  snippet: string;
  context?: string[];
};

export type ChatSearchParams = {
  query?: string;
  from?: string;
  to?: string;
  date?: string;
  messageId?: string;
  role?: string;
  agentId?: string;
  channel?: string;
  limit?: number;
  contextBefore?: number;
  contextAfter?: number;
};

function toTimestampMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function escapeFts5(value: string): string {
  // Escape special FTS5 characters for safe query construction
  return value.replace(/['"()*:^]/g, " ").trim();
}

/**
 * Search the raw chat DB with keyword, date, time range, and context modes.
 */
export function searchChatMessages(
  db: DatabaseSync,
  params: ChatSearchParams,
): ChatSearchResult[] {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const contextBefore = Math.min(Math.max(params.contextBefore ?? 0, 0), 10);
  const contextAfter = Math.min(Math.max(params.contextAfter ?? 0, 0), 10);

  // Mode: messageId context search
  if (params.messageId) {
    return searchByMessageId(db, params.messageId, contextBefore, contextAfter, limit);
  }

  // Build WHERE clauses
  const conditions: string[] = [];
  const args: unknown[] = [];

  if (params.query) {
    // FTS search mode
    return searchByFts(db, params, limit, contextBefore, contextAfter);
  }

  if (params.date) {
    conditions.push(`date_key = ?`);
    args.push(params.date);
  }

  if (params.from) {
    const fromMs = toTimestampMs(params.from);
    if (fromMs !== null) {
      conditions.push(`timestamp_ms >= ?`);
      args.push(fromMs);
    }
  }

  if (params.to) {
    const toMs = toTimestampMs(params.to);
    if (toMs !== null) {
      conditions.push(`timestamp_ms <= ?`);
      args.push(toMs);
    }
  }

  if (params.role) {
    conditions.push(`role = ?`);
    args.push(params.role);
  }

  if (params.agentId) {
    conditions.push(`agent_id = ?`);
    args.push(params.agentId);
  }

  if (params.channel) {
    conditions.push(`channel = ?`);
    args.push(params.channel);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT message_id, timestamp_iso, role, session_key, channel, text
    FROM chat_messages
    ${where}
    ORDER BY timestamp_ms DESC
    LIMIT ?
  `;
  args.push(limit);

  try {
    const rows = db.prepare(sql).all(...args) as Array<{
      message_id: string | null;
      timestamp_iso: string;
      role: string;
      session_key: string | null;
      channel: string | null;
      text: string;
    }>;

    return rows.map((row) => ({
      messageId: row.message_id,
      timestamp: row.timestamp_iso,
      role: row.role,
      sessionKey: row.session_key,
      channel: row.channel,
      snippet: truncateSnippet(row.text, 300),
    }));
  } catch {
    return [];
  }
}

function searchByFts(
  db: DatabaseSync,
  params: ChatSearchParams,
  limit: number,
  _contextBefore: number,
  _contextAfter: number,
): ChatSearchResult[] {
  const escapedQuery = escapeFts5(params.query!);
  if (!escapedQuery) {
    return [];
  }

  // Build FTS match condition
  const ftsConditions: string[] = [`chat_messages_fts MATCH ?`];
  const ftsArgs: unknown[] = [escapedQuery];

  // Join with chat_messages for metadata filters
  const metaConditions: string[] = [];
  const metaArgs: unknown[] = [];

  if (params.date) {
    metaConditions.push(`m.date_key = ?`);
    metaArgs.push(params.date);
  }

  if (params.from) {
    const fromMs = toTimestampMs(params.from);
    if (fromMs !== null) {
      metaConditions.push(`m.timestamp_ms >= ?`);
      metaArgs.push(fromMs);
    }
  }

  if (params.to) {
    const toMs = toTimestampMs(params.to);
    if (toMs !== null) {
      metaConditions.push(`m.timestamp_ms <= ?`);
      metaArgs.push(toMs);
    }
  }

  if (params.role) {
    metaConditions.push(`m.role = ?`);
    metaArgs.push(params.role);
  }

  if (params.agentId) {
    metaConditions.push(`m.agent_id = ?`);
    metaArgs.push(params.agentId);
  }

  if (params.channel) {
    metaConditions.push(`m.channel = ?`);
    metaArgs.push(params.channel);
  }

  const metaWhere = metaConditions.length > 0 ? `AND ${metaConditions.join(" AND ")}` : "";

  const sql = `
    SELECT m.message_id, m.timestamp_iso, m.role, m.session_key, m.channel, m.text
    FROM chat_messages m
    INNER JOIN chat_messages_fts f ON f.rowid = m.id
    WHERE ${ftsConditions.join(" AND ")} ${metaWhere}
    ORDER BY m.timestamp_ms DESC
    LIMIT ?
  `;
  const allArgs = [...ftsArgs, ...metaArgs, limit];

  try {
    const rows = db.prepare(sql).all(...allArgs) as Array<{
      message_id: string | null;
      timestamp_iso: string;
      role: string;
      session_key: string | null;
      channel: string | null;
      text: string;
    }>;

    return rows.map((row) => ({
      messageId: row.message_id,
      timestamp: row.timestamp_iso,
      role: row.role,
      sessionKey: row.session_key,
      channel: row.channel,
      snippet: truncateSnippet(row.text, 300),
    }));
  } catch {
    return [];
  }
}

function searchByMessageId(
  db: DatabaseSync,
  messageId: string,
  contextBefore: number,
  contextAfter: number,
  _limit: number,
): ChatSearchResult[] {
  // Find the target message
  const target = db.prepare(`
    SELECT id, message_id, timestamp_iso, role, session_key, channel, text,
           source_file, source_line, timestamp_ms
    FROM chat_messages
    WHERE message_id = ?
    LIMIT 1
  `).get(messageId) as {
    id: number;
    message_id: string | null;
    timestamp_iso: string;
    role: string;
    session_key: string | null;
    channel: string | null;
    text: string;
    source_file: string;
    source_line: number;
    timestamp_ms: number;
  } | undefined;

  if (!target) {
    return [];
  }

  const results: ChatSearchResult[] = [];

  // Get context before
  if (contextBefore > 0) {
    const beforeRows = db.prepare(`
      SELECT message_id, timestamp_iso, role, session_key, channel, text
      FROM chat_messages
      WHERE source_file = ? AND source_line < ? AND timestamp_ms <= ?
      ORDER BY source_line DESC
      LIMIT ?
    `).all(target.source_file, target.source_line, target.timestamp_ms, contextBefore) as Array<{
      message_id: string | null;
      timestamp_iso: string;
      role: string;
      session_key: string | null;
      channel: string | null;
      text: string;
    }>;
    results.unshift(
      ...beforeRows.toReversed().map((r) => ({
        messageId: r.message_id,
        timestamp: r.timestamp_iso,
        role: r.role,
        sessionKey: r.session_key,
        channel: r.channel,
        snippet: truncateSnippet(r.text, 300),
      })),
    );
  }

  // Add the target message
  results.push({
    messageId: target.message_id,
    timestamp: target.timestamp_iso,
    role: target.role,
    sessionKey: target.session_key,
    channel: target.channel,
    snippet: truncateSnippet(target.text, 300),
  });

  // Get context after
  if (contextAfter > 0) {
    const afterRows = db.prepare(`
      SELECT message_id, timestamp_iso, role, session_key, channel, text
      FROM chat_messages
      WHERE source_file = ? AND source_line > ? AND timestamp_ms >= ?
      ORDER BY source_line ASC
      LIMIT ?
    `).all(target.source_file, target.source_line, target.timestamp_ms, contextAfter) as Array<{
      message_id: string | null;
      timestamp_iso: string;
      role: string;
      session_key: string | null;
      channel: string | null;
      text: string;
    }>;
    results.push(
      ...afterRows.map((r) => ({
        messageId: r.message_id,
        timestamp: r.timestamp_iso,
        role: r.role,
        sessionKey: r.session_key,
        channel: r.channel,
        snippet: truncateSnippet(r.text, 300),
      })),
    );
  }

  return results;
}

function truncateSnippet(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen - 3) + "...";
}

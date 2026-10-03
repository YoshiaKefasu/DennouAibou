import { estimateStringChars, estimateTokensFromChars } from "../../../src/plugin-sdk/cjk-chars.js";
import type { RawChatDatabase } from "./database.js";

/**
 * Memo subsystem data layer (DENNOU_SHINKEI_MEMO Phase 1).
 *
 * Active short-term memory ("what Kasou promised / must keep in mind") backed
 * by the `memos` table in raw-chat.sqlite. Short promises expire after a few
 * days (lazy expiry); explicit `forever` rows are kept indefinitely.
 */

export const MEMO_CONTENT_MAX_LENGTH = 2_000;
export const DEFAULT_MEMO_TTL_DAYS = 3;
export const DEFAULT_MEMO_MAX_TOKENS = 4_000;
export const MS_PER_DAY = 86_400_000;

export const MEMO_CATEGORIES = ["User", "Project", "AgentHabits", "etc"] as const;
export type MemoCategory = (typeof MEMO_CATEGORIES)[number];

export const MEMO_STATUSES = ["active", "archived", "dismissed"] as const;
export type MemoStatus = (typeof MEMO_STATUSES)[number];

export type MemoRecord = {
  id: number;
  category: MemoCategory;
  content: string;
  tags: string[];
  days: number;
  forever: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  status: MemoStatus;
};

export type WriteMemoParams = {
  category: string;
  content: string;
  tags?: string[] | string;
  days?: number;
  forever?: boolean;
};

export type ReadMemosParams = {
  query?: string;
  category?: string;
  tag?: string;
  includeArchived?: boolean;
};

export type UpdateMemoParams = {
  category?: string;
  content?: string;
  tags?: string[] | string;
  days?: number;
  forever?: boolean;
};

export type MemoPromptOptions = {
  maxTokens?: number;
  timezone?: string;
  nowMs?: number;
};

/** Single Dream merge instruction (DENNOU_SHINKEI_MEMO §6.2). */
export type DreamConsolidationInput = {
  keepId: number;
  updateContent?: string;
  archiveIds: number[];
};

export type DreamApplyResult = {
  updated: number;
  archived: number;
};

/**
 * Applies Dream merge instructions atomically (DENNOU_SHINKEI_MEMO §6.2).
 *
 * `BEGIN IMMEDIATE` so a concurrent writer (memo tool, prompt expiry) either
 * waits or fails instead of interleaving half-applied merges. Unknown or
 * non-active ids are skipped silently; `keepId` is never archived even when it
 * appears in its own `archiveIds`. Only `content`/`updated_at` change on the
 * kept row — expiry stays as-is because a merge is not a refresh.
 * Archived rows' tags are merged into the kept row (deduped).
 */
export function applyDreamConsolidation(
  db: RawChatDatabase,
  consolidations: readonly DreamConsolidationInput[],
  nowMs = Date.now(),
): DreamApplyResult {
  const jobs = consolidations.filter(
    (job): job is DreamConsolidationInput =>
      Number.isInteger(job.keepId) && job.keepId > 0 && Array.isArray(job.archiveIds),
  );
  if (jobs.length === 0) {
    return { updated: 0, archived: 0 };
  }
  const now = Math.floor(nowMs);
  const raw = db.getRawDb();
  let updated = 0;
  let archived = 0;
  raw.exec("BEGIN IMMEDIATE;");
  try {
    const selectTagsStmt = raw.prepare(
      "SELECT tags_json FROM memos WHERE id = ? AND status = 'active';",
    );
    const updateContentStmt = raw.prepare(
      "UPDATE memos SET content = ?, updated_at = ? WHERE id = ? AND status = 'active';",
    );
    const updateContentTagsStmt = raw.prepare(
      "UPDATE memos SET content = ?, tags_json = ?, updated_at = ? WHERE id = ? AND status = 'active';",
    );
    const updateTagsStmt = raw.prepare(
      "UPDATE memos SET tags_json = ?, updated_at = ? WHERE id = ? AND status = 'active';",
    );
    const archiveStmt = raw.prepare(
      "UPDATE memos SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active';",
    );
    for (const job of jobs) {
      const content = job.updateContent?.trim();
      const seen = new Set<number>();
      const validArchiveIds: number[] = [];
      for (const archiveId of job.archiveIds) {
        if (!Number.isInteger(archiveId) || archiveId <= 0 || archiveId === job.keepId) {
          continue;
        }
        if (seen.has(archiveId)) {
          continue;
        }
        seen.add(archiveId);
        validArchiveIds.push(archiveId);
      }
      // Merge tags: keepId tags + tags of rows that will actually be archived.
      const keepRow = selectTagsStmt.get(job.keepId) as { tags_json?: unknown } | undefined;
      let mergedJson: string | null = null;
      if (keepRow) {
        const keepTags = parseTagsJson(keepRow.tags_json);
        const seenTags = new Set<string>(keepTags);
        const merged = [...keepTags];
        for (const archiveId of validArchiveIds) {
          const archiveRow = selectTagsStmt.get(archiveId) as { tags_json?: unknown } | undefined;
          if (!archiveRow) {
            continue;
          }
          for (const tag of parseTagsJson(archiveRow.tags_json)) {
            if (seenTags.has(tag)) {
              continue;
            }
            seenTags.add(tag);
            merged.push(tag);
          }
        }
        if (merged.length !== keepTags.length) {
          mergedJson = JSON.stringify(merged);
        }
      }
      if (content) {
        if (mergedJson !== null) {
          updated += Number(
            updateContentTagsStmt.run(content, mergedJson, now, job.keepId).changes,
          );
        } else {
          updated += Number(updateContentStmt.run(content, now, job.keepId).changes);
        }
      } else if (mergedJson !== null) {
        updated += Number(updateTagsStmt.run(mergedJson, now, job.keepId).changes);
      }
      for (const archiveId of validArchiveIds) {
        archived += Number(archiveStmt.run(now, archiveId).changes);
      }
    }
    raw.exec("COMMIT;");
  } catch (error) {
    try {
      raw.exec("ROLLBACK;");
    } catch {
      // Rollback is best-effort; surface the original failure.
    }
    throw error;
  }
  return { updated, archived };
}

/** `user` -> `User`, `agenthabits` -> `AgentHabits`, ... Returns undefined when unknown. */
export function normalizeMemoCategory(input: unknown): MemoCategory | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const key = input
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_-]/gu, "");
  switch (key) {
    case "user":
      return "User";
    case "project":
      return "Project";
    case "agenthabits":
      return "AgentHabits";
    case "etc":
      return "etc";
    default:
      return undefined;
  }
}

export function validateMemoDays(days: unknown): number {
  if (typeof days !== "number" || !Number.isFinite(days) || Math.floor(days) <= 0) {
    throw new Error("days must be a positive integer (retention days)");
  }
  return Math.floor(days);
}

/**
 * Normalizes `tags` input (string[] or comma-separated string) into a clean list.
 * Trims entries, drops empties, dedupes preserving first-seen order.
 * Returns undefined when input is undefined/null (no change), [] when empty.
 */
export function normalizeMemoTags(input: unknown): string[] | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  const parts: string[] = [];
  if (typeof input === "string") {
    parts.push(...input.split(","));
  } else if (Array.isArray(input)) {
    for (const entry of input) {
      if (typeof entry !== "string") {
        continue;
      }
      parts.push(...entry.split(","));
    }
  } else {
    return undefined;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const tag = part.trim();
    if (!tag || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function parseTagsJson(raw: unknown): string[] {
  if (typeof raw !== "string") {
    return [];
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "string") {
        continue;
      }
      const tag = entry.trim();
      if (!tag || seen.has(tag)) {
        continue;
      }
      seen.add(tag);
      out.push(tag);
    }
    return out;
  } catch {
    return [];
  }
}

function validateMemoContent(content: unknown): string {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("content required");
  }
  const trimmed = content.trim();
  if (trimmed.length > MEMO_CONTENT_MAX_LENGTH) {
    throw new Error(
      `content exceeds maximum length of ${MEMO_CONTENT_MAX_LENGTH.toLocaleString("en-US")} characters`,
    );
  }
  return trimmed;
}

type MemoRow = {
  id: number | bigint;
  category: string;
  content: string;
  tags_json?: unknown;
  days: number | bigint | null;
  forever: number | bigint;
  created_at: number | bigint;
  updated_at: number | bigint;
  expires_at: number | bigint | null;
  status: string;
};

function toMemoRecord(row: MemoRow): MemoRecord {
  return {
    id: Number(row.id),
    category: row.category as MemoCategory,
    content: String(row.content),
    tags: parseTagsJson(row.tags_json),
    days: row.days === null ? DEFAULT_MEMO_TTL_DAYS : Number(row.days),
    forever: Number(row.forever) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    status: row.status as MemoStatus,
  };
}

/**
 * Lazy expiry (DENNOU_SHINKEI_MEMO §5.1): archive every active memo whose
 * deadline has passed. Runs before reads and prompt injection so an expired
 * memo never leaks even when Dream is not running. Returns archived count.
 */
export function expireMemos(db: RawChatDatabase, nowMs = Date.now()): number {
  const result = db
    .getRawDb()
    .prepare(
      "UPDATE memos SET status = 'archived', updated_at = ? WHERE status = 'active' AND forever = 0 AND expires_at IS NOT NULL AND expires_at < ?;",
    )
    .run(Math.floor(nowMs), Math.floor(nowMs));
  return Number(result.changes);
}

export function writeMemo(
  db: RawChatDatabase,
  params: WriteMemoParams,
  nowMs = Date.now(),
): MemoRecord {
  const category = normalizeMemoCategory(params.category);
  if (!category) {
    throw new Error("category required: expected one of User, Project, AgentHabits, etc");
  }
  const content = validateMemoContent(params.content);
  const forever = params.forever === true;
  const days = params.days === undefined ? DEFAULT_MEMO_TTL_DAYS : validateMemoDays(params.days);
  const tags = normalizeMemoTags(params.tags) ?? [];
  const now = Math.floor(nowMs);
  const expiresAt = forever ? null : now + days * MS_PER_DAY;

  const result = db
    .getRawDb()
    .prepare(
      "INSERT INTO memos (category, content, tags_json, days, forever, created_at, updated_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active');",
    )
    .run(category, content, JSON.stringify(tags), days, forever ? 1 : 0, now, now, expiresAt);
  const id = Number(result.lastInsertRowid);
  const row = db.getRawDb().prepare("SELECT * FROM memos WHERE id = ?;").get(id) as MemoRow;
  return toMemoRecord(row);
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function readMemos(
  db: RawChatDatabase,
  params: ReadMemosParams = {},
  nowMs = Date.now(),
): MemoRecord[] {
  expireMemos(db, nowMs);

  const conditions: string[] = [];
  const args: (string | number)[] = [];
  if (params.includeArchived === true) {
    conditions.push("status IN ('active', 'archived')");
  } else {
    conditions.push("status = 'active'");
  }
  if (params.category !== undefined) {
    const category = normalizeMemoCategory(params.category);
    if (!category) {
      throw new Error("invalid category: expected one of User, Project, AgentHabits, etc");
    }
    conditions.push("category = ?");
    args.push(category);
  }
  const query = params.query?.trim();
  if (query) {
    conditions.push("content LIKE ? ESCAPE '\\'");
    args.push(`%${escapeLike(query)}%`);
  }

  // Deterministic order: prompt-cache stable (§5.2).
  const rows = db
    .getRawDb()
    .prepare(
      `SELECT * FROM memos WHERE ${conditions.join(" AND ")} ORDER BY forever DESC, category ASC, id ASC;`,
    )
    .all(...args) as MemoRow[];
  const memos = rows.map(toMemoRecord);
  const tagFilter = params.tag?.trim().toLowerCase();
  if (tagFilter) {
    return memos.filter((memo) => memo.tags.some((tag) => tag.toLowerCase().includes(tagFilter)));
  }
  return memos;
}

export function updateMemo(
  db: RawChatDatabase,
  id: number,
  patch: UpdateMemoParams,
  nowMs = Date.now(),
): MemoRecord {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("id required: update needs a memo id");
  }
  const current = db.getRawDb().prepare("SELECT * FROM memos WHERE id = ?;").get(id) as
    | MemoRow
    | undefined;
  if (!current || current.status === "dismissed") {
    throw new Error(`memo #${id} not found`);
  }

  let category = current.category;
  if (patch.category !== undefined) {
    const normalized = normalizeMemoCategory(patch.category);
    if (!normalized) {
      throw new Error("invalid category: expected one of User, Project, AgentHabits, etc");
    }
    category = normalized;
  }
  let content = String(current.content);
  if (patch.content !== undefined) {
    content = validateMemoContent(patch.content);
  }
  let tags = parseTagsJson((current as MemoRow).tags_json);
  if (patch.tags !== undefined) {
    tags = normalizeMemoTags(patch.tags) ?? [];
  }

  let forever = Number(current.forever) === 1;
  let days = current.days === null ? DEFAULT_MEMO_TTL_DAYS : Number(current.days);
  let expiresAt: number | null = current.expires_at === null ? null : Number(current.expires_at);

  if (patch.forever === true) {
    forever = true;
    expiresAt = null;
  } else if (patch.forever === false) {
    forever = false;
    if (patch.days !== undefined) {
      days = validateMemoDays(patch.days);
    }
    expiresAt = Math.floor(nowMs) + days * MS_PER_DAY;
  } else if (patch.days !== undefined) {
    days = validateMemoDays(patch.days);
    if (!forever) {
      expiresAt = Math.floor(nowMs) + days * MS_PER_DAY;
    }
  }

  if (
    patch.category === undefined &&
    patch.content === undefined &&
    patch.tags === undefined &&
    patch.days === undefined &&
    patch.forever === undefined
  ) {
    throw new Error("nothing to update: specify category, content, tags, days, or forever");
  }

  const now = Math.floor(nowMs);
  // Self-healing: an explicit refresh that lands in the future revives the row.
  const status = !forever && expiresAt !== null && expiresAt <= now ? "archived" : "active";
  db.getRawDb()
    .prepare(
      "UPDATE memos SET category = ?, content = ?, tags_json = ?, days = ?, forever = ?, updated_at = ?, expires_at = ?, status = ? WHERE id = ?;",
    )
    .run(
      category,
      content,
      JSON.stringify(tags),
      days,
      forever ? 1 : 0,
      now,
      expiresAt,
      status,
      id,
    );
  const row = db.getRawDb().prepare("SELECT * FROM memos WHERE id = ?;").get(id) as MemoRow;
  return toMemoRecord(row);
}

/** Logical delete (`status = 'dismissed'`). Returns false when missing/already gone. */
export function removeMemo(db: RawChatDatabase, id: number, nowMs = Date.now()): boolean {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("id required: remove needs a memo id");
  }
  const result = db
    .getRawDb()
    .prepare(
      "UPDATE memos SET status = 'dismissed', updated_at = ? WHERE id = ? AND status != 'dismissed';",
    )
    .run(Math.floor(nowMs), id);
  return Number(result.changes) > 0;
}

/**
 * Archive (`status = 'archived'`). Unlike `removeMemo` (gone / dismissed), an
 * archived memo stays visible via `readMemos({ includeArchived: true })`.
 * Returns false when missing or already archived/dismissed.
 */
export function archiveMemo(db: RawChatDatabase, id: number, nowMs = Date.now()): boolean {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("id required: archive needs a memo id");
  }
  const result = db
    .getRawDb()
    .prepare(
      "UPDATE memos SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active';",
    )
    .run(Math.floor(nowMs), id);
  return Number(result.changes) > 0;
}

/** `dream.timezone` -> `agents.defaults.userTimezone` -> host TZ (DENNOU_SHINKEI_MEMO §6.1). */
export function resolveMemoTimezone(
  explicit?: string,
  config?: { agents?: { defaults?: { userTimezone?: string } } },
): string {
  const trimmed = explicit?.trim();
  if (trimmed) {
    return trimmed;
  }
  const configured = config?.agents?.defaults?.userTimezone?.trim();
  if (configured) {
    return configured;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

export function resolveMemoMaxTokens(
  pluginConfig?: Record<string, unknown>,
  contextWindow?: number,
): number {
  const memo = pluginConfig?.["memo"];
  const raw =
    memo && typeof memo === "object" && !Array.isArray(memo)
      ? (memo as Record<string, unknown>)["maxTokens"]
      : undefined;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  // Dynamic scaling: 5% of the active model context window (floor 4,000).
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    return Math.max(DEFAULT_MEMO_MAX_TOKENS, Math.floor(contextWindow * 0.05));
  }
  return DEFAULT_MEMO_MAX_TOKENS;
}

function formatExpiryDate(expiresAtMs: number, timezone: string): string {
  const format = (timeZone: string): string =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(expiresAtMs));
  try {
    return format(timezone);
  } catch {
    return format("UTC");
  }
}

function escapeXmlText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function estimateLineTokens(line: string): number {
  return estimateTokensFromChars(estimateStringChars(line));
}

/**
 * Builds the `<active-memos>` system context (§5.2). Forever memos win the
 * token budget; dated memos fill newest-first. Selected rows render in the
 * deterministic `forever DESC, category ASC, id ASC` order so prompt caching
 * stays stable. Returns null when no memo fits.
 */
export function getActiveMemosForPrompt(
  db: RawChatDatabase,
  options: MemoPromptOptions = {},
): string | null {
  const maxTokens =
    options.maxTokens !== undefined && Number.isFinite(options.maxTokens)
      ? Math.floor(options.maxTokens)
      : DEFAULT_MEMO_MAX_TOKENS;
  if (maxTokens <= 0) {
    return null;
  }
  const nowMs = options.nowMs ?? Date.now();
  expireMemos(db, nowMs);
  const timezone = resolveMemoTimezone(options.timezone);

  const rows = db
    .getRawDb()
    .prepare(
      "SELECT * FROM memos WHERE status = 'active' ORDER BY forever DESC, category ASC, id ASC;",
    )
    .all() as MemoRow[];
  if (rows.length === 0) {
    return null;
  }
  const memos = rows.map(toMemoRecord);

  // Priority fill: forever rows (display order), then dated rows newest-first.
  const foreverRows = memos.filter((memo) => memo.forever);
  const datedRows = [...memos.filter((memo) => !memo.forever)].sort(
    (left, right) => right.createdAt - left.createdAt || right.id - left.id,
  );
  const candidates = [...foreverRows, ...datedRows];

  const headerTokens = new Map<MemoCategory, number>();
  for (const category of MEMO_CATEGORIES) {
    headerTokens.set(category, estimateLineTokens(`[${category}]`));
  }
  const selected = new Set<number>();
  const liveCategories = new Set<MemoCategory>();
  let used = estimateLineTokens("<active-memos>") + estimateLineTokens("</active-memos>");
  for (const memo of candidates) {
    const line = formatMemoLine(memo, timezone);
    let cost = estimateLineTokens(line);
    if (!liveCategories.has(memo.category)) {
      cost += headerTokens.get(memo.category) ?? 0;
    }
    if (used + cost > maxTokens) {
      continue;
    }
    used += cost;
    selected.add(memo.id);
    liveCategories.add(memo.category);
  }
  if (selected.size === 0) {
    return null;
  }

  // Render in deterministic display order with category headers.
  const lines: string[] = ["<active-memos>"];
  let openCategory: MemoCategory | null = null;
  for (const memo of memos) {
    if (!selected.has(memo.id)) {
      continue;
    }
    if (openCategory !== memo.category) {
      if (openCategory !== null) {
        lines.push("");
      }
      lines.push(`[${memo.category}]`);
      openCategory = memo.category;
    }
    lines.push(formatMemoLine(memo, timezone));
  }
  lines.push("</active-memos>");
  return lines.join("\n");
}

function formatMemoLine(memo: MemoRecord, timezone: string): string {
  const deadline =
    memo.forever || memo.expiresAt === null ? "無限" : formatExpiryDate(memo.expiresAt, timezone);
  const tagsPart =
    memo.tags.length > 0 ? ` [${memo.tags.map((tag) => escapeXmlText(tag)).join(", ")}]` : "";
  return `- #${memo.id}${tagsPart} (期限: ${deadline}): ${escapeXmlText(memo.content)}`;
}

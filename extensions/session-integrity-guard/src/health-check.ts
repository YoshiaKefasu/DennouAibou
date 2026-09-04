/**
 * Health check primitives for session JSONL integrity (Phase 2).
 *
 * Computes four independent integrity signals:
 *   - JSON parse errors (any malformed line)
 *   - Duplicate IDs (id set vs line count)
 *   - Orphan count (parentId !== null && parentId not present anywhere)
 *   - Leaf count (nodes never referenced as parentId), excluding the header row
 *
 * Definition alignment (DENNOU_DOCS/SESSION_INTEGRITY_GUARD.md §4.2, §4.5):
 *   - Orphan predicate: `parentId !== null && !byId.has(parentId)`
 *   - Header row (`type === "session"`) is excluded from leaf counting.
 *
 * Pure / side-effect free: callers receive a {@link HealthCheckResult} that
 * they can format / log themselves. The plugin shell (§cron-job.ts) is
 * responsible for emitting logs and (in Phase 3) notifications.
 */

export type SessionLineKind =
  | { kind: "header" }
  | { kind: "entry"; id: string; parentId: string | null; type: string }
  | { kind: "jsonError" }
  | { kind: "missingId" }
  | { kind: "missingParentId" };

export interface HealthCheckResult {
  totalLines: number;
  entryCount: number;
  jsonErrorCount: number;
  duplicateIdCount: number;
  orphanCount: number;
  leafCount: number;
  orphanEntries: Array<{ id: string; type: string }>;
  duplicateIds: string[];
}

export const EMPTY_HEALTH_CHECK_RESULT: HealthCheckResult = {
  totalLines: 0,
  entryCount: 0,
  jsonErrorCount: 0,
  duplicateIdCount: 0,
  orphanCount: 0,
  leafCount: 0,
  orphanEntries: [],
  duplicateIds: [],
};

function parseLine(rawLine: string): SessionLineKind {
  const line = rawLine.trim();
  if (line.length === 0) {
    // Whitespace-only lines are tolerated by SessionManager's loadEntriesFromFile.
    // They count as a parsed line but contribute nothing to integrity metrics.
    return { kind: "header" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "jsonError" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "jsonError" };
  }
  const record = parsed as Record<string, unknown>;
  const type = record.type;
  if (type === "session") {
    return { kind: "header" };
  }
  const id = record.id;
  if (typeof id !== "string" || id.length === 0) {
    return { kind: "missingId" };
  }
  const parentId = record.parentId;
  if (parentId !== null && typeof parentId !== "string") {
    return { kind: "missingParentId" };
  }
  return {
    kind: "entry",
    id,
    parentId: parentId === null ? null : parentId,
    type: typeof type === "string" ? type : "unknown",
  };
}

/**
 * Run the four-metric integrity scan over a JSONL payload.
 *
 * The header row (`type: "session"`) is excluded from leaf counting per the
 * design contract. Whitespace-only lines and structural lines with no parseable
 * id/parentId are counted as `jsonErrorCount` only when they fail JSON.parse;
 * rows with missing id / parentId are treated as soft entries and contribute
 * to `jsonErrorCount` so the metric stays monotonic in the failure surface.
 *
 * @param content Raw JSONL file body.
 */
export function runHealthCheck(content: string): HealthCheckResult {
  if (!content) {
    return { ...EMPTY_HEALTH_CHECK_RESULT };
  }
  const lines = content.split(/\r?\n/u);
  const result: HealthCheckResult = {
    totalLines: 0,
    entryCount: 0,
    jsonErrorCount: 0,
    duplicateIdCount: 0,
    orphanCount: 0,
    leafCount: 0,
    orphanEntries: [],
    duplicateIds: [],
  };

  const ids: string[] = [];
  const byId = new Map<string, { parentId: string | null; type: string }>();
  const parentIdSet = new Set<string>();

  for (const rawLine of lines) {
    result.totalLines += 1;
    const parsed = parseLine(rawLine);
    switch (parsed.kind) {
      case "header":
        continue;
      case "jsonError":
        result.jsonErrorCount += 1;
        continue;
      case "missingId":
        // Defensive: treat malformed entries (missing id) as parse-level damage.
        result.jsonErrorCount += 1;
        continue;
      case "missingParentId":
        // Has id but parentId is neither null nor string — counts as structural error.
        result.jsonErrorCount += 1;
        continue;
      case "entry":
        result.entryCount += 1;
        ids.push(parsed.id);
        byId.set(parsed.id, { parentId: parsed.parentId, type: parsed.type });
        if (parsed.parentId !== null) {
          parentIdSet.add(parsed.parentId);
        }
        continue;
    }
  }

  // Duplicates: id count vs unique id count.
  const uniqueIds = new Set(ids);
  const duplicateIds: string[] = [];
  for (const id of ids) {
    if (uniqueIds.has(id) && !duplicateIds.includes(id) && ids.filter((v) => v === id).length > 1) {
      duplicateIds.push(id);
    }
  }
  result.duplicateIdCount = duplicateIds.length;
  result.duplicateIds = duplicateIds;

  // Orphans: parentId !== null AND parentId not present in byId.
  // Header rows never appear here because parseLine short-circuits on type="session".
  for (const [id, info] of byId) {
    if (info.parentId !== null && !byId.has(info.parentId)) {
      result.orphanCount += 1;
      result.orphanEntries.push({ id, type: info.type });
    }
  }

  // Leaves: entry never referenced as parentId. Header excluded by construction.
  for (const [id] of byId) {
    if (!parentIdSet.has(id)) {
      result.leafCount += 1;
    }
  }

  return result;
}

/** Format a result for log output. Phase 2 emits one line per file. */
export function formatHealthCheckLine(sessionFile: string, result: HealthCheckResult): string {
  const filename = sessionFile.split(/[\\/]/u).pop() ?? sessionFile;
  const parts = [
    `file=${filename}`,
    `entries=${result.entryCount}`,
    `jsonErrors=${result.jsonErrorCount}`,
    `duplicates=${result.duplicateIdCount}`,
    `orphans=${result.orphanCount}`,
    `leaves=${result.leafCount}`,
  ];
  return `session-integrity-guard health: ${parts.join(" ")}`;
}

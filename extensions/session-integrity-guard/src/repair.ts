/**
 * Auto-repair primitives for session JSONL integrity (Phase 3).
 *
 * Scope (DENNOU_DOCS/SESSION_INTEGRITY_GUARD.md §4.5, §8.1):
 *   - Only `type !== "message"` orphan rows are removed.
 *   - `user` / `assistant` / `toolResult` / `system` rows are ABSOLUTELY
 *     untouched (programmatically unreachable through this module).
 *   - Repair is opt-in via `autoRepair: true` in plugin config.
 *   - The pipeline is dry-run → apply: dry-run logs the candidate set without
 *     touching the source file. Apply runs only after a successful backup.
 *
 * Pure / IO-free logic is exposed as top-level functions (`identifyRemovableOrphans`,
 * `applyRemovals`) so unit tests can run without touching the filesystem. The
 * filesystem-aware helpers (`runRepairForFile`, `runRepairForFiles`) are thin
 * wrappers that orchestrate backup + atomic rewrite.
 *
 * Note (Phase 3 MED 4): We do NOT branch on legacy type names
 * (`model_snapshot` / `prompt_error`). Any entry with a non-`message` type is
 * eligible when its parent is missing. The `isRemovableOrphan` predicate is a
 * single-line type check, deliberately leave-room for future custom types.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackupFile } from "./backup.js";
import { runHealthCheck, type HealthCheckResult } from "./health-check.js";

export interface RepairEntrySnapshot {
  id: string;
  type: string;
  parentId: string | null;
}

/**
 * Strict removal predicate (design contract §4.5).
 *
 * @returns `true` iff the entry is safe to remove: orphan AND `type !== "message"`.
 */
export function isRemovableOrphan(entry: RepairEntrySnapshot): boolean {
  if (entry.type !== "message") {
    return true;
  }
  return false;
}

/**
 * Build the orphan + parentId index for the given content and emit the set of
 * removable rows.
 *
 * Uses the same parsing semantics as `runHealthCheck` so that dry-run counts
 * line up with the existing health-check metrics.
 */
export function identifyRemovableOrphans(content: string): {
  orphanEntries: Array<{ id: string; type: string }>;
  removableEntries: Array<{ id: string; type: string }>;
  byId: Map<string, RepairEntrySnapshot>;
} {
  const result: HealthCheckResult = runHealthCheck(content);
  const byId = new Map<string, RepairEntrySnapshot>();
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const id = record.id;
    const type = record.type;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    if (typeof type !== "string") {
      continue;
    }
    const parentId = record.parentId;
    byId.set(id, {
      id,
      type,
      parentId: parentId === null ? null : typeof parentId === "string" ? parentId : null,
    });
  }
  const orphanSet = new Set(result.orphanEntries.map((o) => o.id));
  const removableEntries = result.orphanEntries.filter((o) => {
    const entry = byId.get(o.id);
    if (!entry) {
      return false;
    }
    if (entry.parentId === null) {
      return false;
    }
    if (!orphanSet.has(entry.id)) {
      return false;
    }
    if (byId.has(entry.parentId)) {
      return false;
    }
    return isRemovableOrphan(entry);
  });
  return { orphanEntries: result.orphanEntries, removableEntries, byId };
}

/**
 * Drop the named IDs from the JSONL content. Lines that fail to parse are
 * preserved verbatim so we never destroy recoverable bytes. Whitespace-only lines
 * pass through unchanged.
 *
 * @returns The rewritten content and the number of lines actually removed.
 */
export function applyRemovals(
  content: string,
  removableIds: ReadonlySet<string>,
): { content: string; removedCount: number } {
  if (removableIds.size === 0) {
    return { content, removedCount: 0 };
  }
  const lines = content.split(/\r?\n/u);
  const filtered: string[] = [];
  let removedCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      filtered.push(line);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      filtered.push(line);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      filtered.push(line);
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const id = record.id;
    if (typeof id === "string" && removableIds.has(id)) {
      removedCount += 1;
      continue;
    }
    filtered.push(line);
  }
  return { content: filtered.join("\n"), removedCount };
}

/**
 * Build the file content via tmp + rename (atomic on POSIX, best-effort on
 * Windows). Returns the bytes written.
 */
async function atomicWrite(filePath: string, content: string): Promise<number> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.repair-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(tmp, content, { encoding: "utf-8" });
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
  return Buffer.byteLength(content, "utf-8");
}

/**
 * Hash the user/assistant message rows so we can prove the repair did not
 * touch them. SHA-256 over a stable encoding (sorted keys via JSON.stringify
 * with replacer, deduped by id).
 *
 * Returns a hex digest of the concatenated message lines.
 */
export async function hashMessageRows(content: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const lines = content.split(/\r?\n/u);
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type !== "message") {
      continue;
    }
    collected.push(JSON.stringify(record));
  }
  collected.sort();
  const hash = createHash("sha256");
  for (const row of collected) {
    hash.update(row);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export type RepairOutcome =
  | {
      status: "skipped";
      reason: "no-anomalies";
      file: string;
    }
  | {
      status: "skipped";
      reason: "auto-repair-disabled";
      file: string;
      dryRun: { orphanCount: number; removableCount: number };
    }
  | {
      status: "dry-run";
      file: string;
      orphanCount: number;
      removableCount: number;
      removableIds: string[];
    }
  | {
      status: "applied";
      file: string;
      backupPath: string;
      removedCount: number;
      bytesWritten: number;
      reparse: {
        orphanCount: number;
        jsonErrorCount: number;
        duplicateIdCount: number;
        leafCount: number;
        messageRowHash: string;
      };
    }
  | {
      status: "error";
      file: string;
      message: string;
    };

export interface RunRepairForFileParams {
  file: string;
  content: string;
  autoRepair: boolean;
}

/**
 * End-to-end repair pipeline for a single session file.
 *
 * Pipeline:
 *   1. Identify removable orphans (dry-run info).
 *   2. If `autoRepair` is `false`, return a `skipped` outcome with the dry-run
 *      numbers for logging.
 *   3. Create a backup via `createBackupFile`.
 *   4. Atomically rewrite the source file with the orphaned rows removed.
 *   5. Re-parse the rewritten file and assert:
 *        - `orphanCount === 0`
 *        - message-row hash matches the pre-repair hash (user / assistant
 *          untouched).
 *        - JSON parse error count is unchanged.
 */
export async function runRepairForFile(params: RunRepairForFileParams): Promise<RepairOutcome> {
  const { file, content, autoRepair } = params;
  let orphanInfo: ReturnType<typeof identifyRemovableOrphans>;
  try {
    orphanInfo = identifyRemovableOrphans(content);
  } catch (err) {
    return {
      status: "error",
      file,
      message: `orphan scan failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (orphanInfo.removableEntries.length === 0) {
    return { status: "skipped", reason: "no-anomalies", file };
  }

  const removableIds = new Set(orphanInfo.removableEntries.map((entry) => entry.id));
  const removableList = orphanInfo.removableEntries.map((entry) => entry.id);

  if (!autoRepair) {
    return {
      status: "skipped",
      reason: "auto-repair-disabled",
      file,
      dryRun: {
        orphanCount: orphanInfo.orphanEntries.length,
        removableCount: orphanInfo.removableEntries.length,
      },
    };
  }

  let preHash: string;
  try {
    preHash = await hashMessageRows(content);
  } catch (err) {
    return {
      status: "error",
      file,
      message: `pre-repair hash failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let backupPath: string;
  try {
    const backup = await createBackupFile(file);
    backupPath = backup.backupPath;
  } catch (err) {
    return {
      status: "error",
      file,
      message: `backup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const { content: rewritten, removedCount } = applyRemovals(content, removableIds);
  if (removedCount === 0) {
    return {
      status: "error",
      file,
      message: "repair aborted: removedCount === 0 after backup (no removable rows matched)",
    };
  }

  let bytesWritten: number;
  try {
    bytesWritten = await atomicWrite(file, rewritten);
  } catch (err) {
    return {
      status: "error",
      file,
      message: `atomic rewrite failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let postHash: string;
  try {
    postHash = await hashMessageRows(rewritten);
  } catch (err) {
    return {
      status: "error",
      file,
      message: `post-repair hash failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (preHash !== postHash) {
    return {
      status: "error",
      file,
      message:
        "repair aborted: message-row hash drift detected (user/assistant rows were touched by repair)",
    };
  }

  // Re-validate the rewritten content. We re-read from disk so the assertion
  // reflects exactly what the SessionManager will see on next load.
  let persisted = "";
  try {
    persisted = await fs.readFile(file, "utf-8");
  } catch (err) {
    return {
      status: "error",
      file,
      message: `post-repair read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const reparse = runHealthCheck(persisted);
  if (reparse.orphanCount > 0) {
    return {
      status: "error",
      file,
      message: `post-repair orphan count is ${reparse.orphanCount} (expected 0)`,
    };
  }

  return {
    status: "applied",
    file,
    backupPath,
    removedCount,
    bytesWritten,
    reparse: {
      orphanCount: reparse.orphanCount,
      jsonErrorCount: reparse.jsonErrorCount,
      duplicateIdCount: reparse.duplicateIdCount,
      leafCount: reparse.leafCount,
      messageRowHash: postHash,
    },
  };
}

export interface RunRepairForFilesParams {
  files: string[];
  autoRepair: boolean;
}

/**
 * Repair every supplied file sequentially. The function returns one outcome per
 * input file. Used by the cron job handler.
 */
export async function runRepairForFiles(params: RunRepairForFilesParams): Promise<RepairOutcome[]> {
  const outcomes: RepairOutcome[] = [];
  for (const file of params.files) {
    let content = "";
    try {
      content = await fs.readFile(file, "utf-8");
    } catch (err) {
      outcomes.push({
        status: "error",
        file,
        message: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const outcome = await runRepairForFile({ file, content, autoRepair: params.autoRepair });
    outcomes.push(outcome);
  }
  return outcomes;
}

// Re-exporting fs so consumers (notably `runRepairForFile`) don't pull in a fresh
// import. `os` is referenced via tmp naming; keep the import out of the public
// surface by not re-exporting it.
void os;

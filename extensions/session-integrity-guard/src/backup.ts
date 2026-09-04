/**
 * Backup helpers for the session integrity guard repair flow (Phase 3).
 *
 * Design contract (DENNOU_DOCS/SESSION_INTEGRITY_GUARD.md §4.5):
 *   - Repair must NEVER begin before a backup is taken.
 *   - Backup filename: `<file>.bak.YYYYMMDD-HHmmss` (local time).
 *   - The backup is a byte-for-byte copy of the source content.
 *
 * The function is side-effect free on success: it writes the backup file
 * alongside the original and returns the backup path. The caller decides
 * whether to apply the repair afterwards. A failure during the write rolls
 * back any partial artifacts and surfaces the error so the caller can abort
 * the repair (fail-closed).
 */

import fs from "node:fs/promises";
import path from "node:path";

export type CreateBackupResult = {
  backupPath: string;
  bytes: number;
};

/**
 * Format a timestamp suitable for the `<file>.bak.YYYYMMDD-HHmmss` suffix.
 *
 * Local time is used on purpose so the suffix is human-readable in the same
 * timezone where the cron schedule resolves (`0 3 * * *` defaults to the host
 * local time).
 */
export function formatBackupTimestamp(now: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * Build the backup path for `sourceFile`. Pure / synchronous.
 */
export function buildBackupPath(sourceFile: string, now: Date = new Date()): string {
  const ts = formatBackupTimestamp(now);
  return `${sourceFile}.bak.${ts}`;
}

/**
 * Copy `sourceFile` to a sibling backup file. Returns the absolute path of the
 * backup. On failure, removes any partial file before re-throwing.
 */
export async function createBackupFile(
  sourceFile: string,
  now: Date = new Date(),
): Promise<CreateBackupResult> {
  const backupPath = buildBackupPath(sourceFile, now);
  const parentDir = path.dirname(sourceFile);
  const sourceName = path.basename(sourceFile);
  if (parentDir.length === 0) {
    throw new Error(
      `session-integrity-guard: cannot create backup for ${sourceName}: missing parent directory.`,
    );
  }
  let bytes = 0;
  let written = false;
  try {
    const buffer = await fs.readFile(sourceFile);
    bytes = buffer.byteLength;
    await fs.writeFile(backupPath, buffer, { flag: "wx" });
    written = true;
    return { backupPath, bytes };
  } catch (err) {
    if (written) {
      try {
        await fs.unlink(backupPath);
      } catch {
        // Best-effort cleanup; the original error is more useful for the caller.
      }
    }
    throw new Error(
      `session-integrity-guard: failed to create backup ${backupPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
}

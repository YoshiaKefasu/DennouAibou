/**
 * Session JSONL discovery (Phase 2 minimal).
 *
 * Walks the default session directory for `cwd` and returns every `.jsonl`
 * file (excluding `.bak-*` / `.repair-*` siblings so previously repaired
 * snapshots don't poison the scan). Returns an empty list when the directory
 * cannot be resolved or does not exist.
 */

import fs from "node:fs/promises";
import path from "node:path";

const SESSION_FILE_PATTERN = /\.jsonl$/u;
const SKIP_SUFFIXES = [".bak-", ".repair-", ".tmp-"];

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if ((err as { code?: string } | undefined)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/** True when the file name is a repair / backup artifact and should be ignored. */
function isSkippedArtifact(name: string): boolean {
  for (const suffix of SKIP_SUFFIXES) {
    if (name.includes(suffix)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the default session directory via the pi-coding-agent SDK.
 *
 * The function is exported from `dist/core/session-manager.js` but the package
 * `exports` field does not expose that subpath, so a dynamic import (with
 * fallbacks) keeps us inside the public surface.
 */
async function resolveSdkSessionDir(cwd: string): Promise<string | undefined> {
  const candidates: string[] = [
    "@earendil-works/pi-coding-agent/dist/core/session-manager.js",
    "@earendil-works/pi-coding-agent",
  ];
  for (const specifier of candidates) {
    try {
      const mod = (await import(specifier)) as {
        getDefaultSessionDir?: (cwd: string) => string;
      };
      if (typeof mod.getDefaultSessionDir === "function") {
        return mod.getDefaultSessionDir(cwd);
      }
    } catch {
      // Try next candidate.
    }
  }
  return undefined;
}

export interface DiscoverSessionFilesParams {
  cwd?: string;
}

export async function discoverSessionFiles(
  params: DiscoverSessionFilesParams = {},
): Promise<string[]> {
  const cwd = params.cwd ?? process.cwd();
  const sessionDir = await resolveSdkSessionDir(cwd);
  if (!sessionDir) {
    return [];
  }
  const entries = await safeReadDir(sessionDir);
  const files: string[] = [];
  for (const entry of entries) {
    if (!SESSION_FILE_PATTERN.test(entry)) {
      continue;
    }
    if (isSkippedArtifact(entry)) {
      continue;
    }
    files.push(path.join(sessionDir, entry));
  }
  files.sort();
  return files;
}

/** Read a session file body. Returns empty string when the file disappears mid-scan. */
export async function readSessionFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as { code?: string } | undefined)?.code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

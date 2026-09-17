import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBrewPathDirs } from "./brew.js";
import { isTruthyEnvValue } from "./env.js";

export type EnsureOpenClawPathFs = {
  accessSync: (filePath: string, mode?: number) => void;
  statSync: (dirPath: string) => { isDirectory: () => boolean };
  constants: { X_OK: number };
};

type EnsureOpenClawPathOpts = {
  execPath?: string;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  pathEnv?: string;
  allowProjectLocalBin?: boolean;
  env?: NodeJS.ProcessEnv;
  fs?: EnsureOpenClawPathFs;
};

const nodeFs: EnsureOpenClawPathFs = {
  accessSync: (filePath, mode) => {
    fs.accessSync(filePath, mode);
  },
  statSync: (dirPath) => fs.statSync(dirPath),
  constants: { X_OK: fs.constants.X_OK },
};

function isExecutable(filePath: string, pathFs: EnsureOpenClawPathFs): boolean {
  try {
    pathFs.accessSync(filePath, pathFs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string, pathFs: EnsureOpenClawPathFs): boolean {
  try {
    return pathFs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function mergePath(params: { existing: string; prepend?: string[]; append?: string[] }): string {
  const partsExisting = params.existing
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  const partsPrepend = (params.prepend ?? []).map((part) => part.trim()).filter(Boolean);
  const partsAppend = (params.append ?? []).map((part) => part.trim()).filter(Boolean);

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of [...partsPrepend, ...partsExisting, ...partsAppend]) {
    if (!seen.has(part)) {
      seen.add(part);
      merged.push(part);
    }
  }
  return merged.join(path.delimiter);
}

function candidateBinDirs(
  opts: EnsureOpenClawPathOpts,
  env: NodeJS.ProcessEnv,
  pathFs: EnsureOpenClawPathFs,
): { prepend: string[]; append: string[] } {
  const execPath = opts.execPath ?? process.execPath;
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const platform = opts.platform ?? process.platform;

  const prepend: string[] = [];
  const append: string[] = [];

  // Bundled macOS app: `openclaw` lives next to the executable (process.execPath).
  try {
    const execDir = path.dirname(execPath);
    const siblingCli = path.join(execDir, "openclaw");
    if (isExecutable(siblingCli, pathFs)) {
      prepend.push(execDir);
    }
  } catch {
    // ignore
  }

  // Project-local installs are a common repo-based attack vector (bin hijacking). Keep this
  // disabled by default; if an operator explicitly enables it, only append (never prepend).
  const allowProjectLocalBin =
    opts.allowProjectLocalBin === true || isTruthyEnvValue(env.DENNOU_ALLOW_PROJECT_LOCAL_BIN);
  if (allowProjectLocalBin) {
    const localBinDir = path.join(cwd, "node_modules", ".bin");
    if (isExecutable(path.join(localBinDir, "openclaw"), pathFs)) {
      append.push(localBinDir);
    }
  }

  // Only immutable OS directories go in prepend so they take priority over
  // user-writable locations, preventing PATH hijack of system binaries.
  prepend.push("/usr/bin", "/bin");

  // User-writable / package-manager directories are appended so they never
  // shadow trusted OS binaries.
  // This includes Brew/Homebrew dirs, which are useful for finding `openclaw`
  // in launchd/minimal environments but must not be treated as trusted.
  append.push(...resolveBrewPathDirs({ homeDir, env }));
  const miseDataDir = env.MISE_DATA_DIR ?? path.join(homeDir, ".local", "share", "mise");
  const miseShims = path.join(miseDataDir, "shims");
  if (isDirectory(miseShims, pathFs)) {
    append.push(miseShims);
  }
  if (platform === "darwin") {
    append.push(path.join(homeDir, "Library", "pnpm"));
  }
  if (env.XDG_BIN_HOME) {
    append.push(env.XDG_BIN_HOME);
  }
  append.push(path.join(homeDir, ".local", "bin"));
  append.push(path.join(homeDir, ".local", "share", "pnpm"));
  append.push(path.join(homeDir, ".bun", "bin"));
  append.push(path.join(homeDir, ".yarn", "bin"));

  return {
    prepend: prepend.filter((dir) => isDirectory(dir, pathFs)),
    append: append.filter((dir) => isDirectory(dir, pathFs)),
  };
}

/**
 * Best-effort PATH bootstrap so skills that require the `openclaw` CLI can run
 * under launchd/minimal environments (and inside the macOS app bundle).
 */
export function ensureOpenClawCliOnPath(opts: EnsureOpenClawPathOpts = {}) {
  const env = opts.env ?? process.env;
  const pathFs = opts.fs ?? nodeFs;

  if (isTruthyEnvValue(env.DENNOU_PATH_BOOTSTRAPPED)) {
    return;
  }
  env.DENNOU_PATH_BOOTSTRAPPED = "1";

  const existing = opts.pathEnv ?? env.PATH ?? "";
  const { prepend, append } = candidateBinDirs(opts, env, pathFs);
  if (prepend.length === 0 && append.length === 0) {
    return;
  }

  const merged = mergePath({ existing, prepend, append });
  if (merged) {
    env.PATH = merged;
  }
}

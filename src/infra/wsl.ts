import { readFileSync as nodeReadFileSync } from "node:fs";
import fs from "node:fs/promises";

export type WslDeps = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readFileSync?: (path: string, encoding: "utf8") => string;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
};

/**
 * WSL detection with injectable platform/env/fs so callers (and tests) can
 * exercise non-Linux hosts without touching global process state.
 */
export function createWslDetector(deps: WslDeps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const readFileSync =
    deps.readFileSync ??
    ((path: string, encoding: "utf8"): string => nodeReadFileSync(path, encoding));
  const readFile =
    deps.readFile ??
    (async (path: string, encoding: "utf8"): Promise<string> => await fs.readFile(path, encoding));

  let wslCached: boolean | null = null;

  function resetWSLStateForTests(): void {
    wslCached = null;
  }

  function isWSLEnv(): boolean {
    if (env.WSL_INTEROP || env.WSL_DISTRO_NAME || env.WSLENV) {
      return true;
    }
    return false;
  }

  /**
   * Synchronously check if running in WSL.
   * Checks env vars first, then /proc/version.
   */
  function isWSLSync(): boolean {
    if (platform !== "linux") {
      return false;
    }
    if (isWSLEnv()) {
      return true;
    }
    try {
      const release = readFileSync("/proc/version", "utf8").toLowerCase();
      return release.includes("microsoft") || release.includes("wsl");
    } catch {
      return false;
    }
  }

  /**
   * Synchronously check if running in WSL2.
   */
  function isWSL2Sync(): boolean {
    if (!isWSLSync()) {
      return false;
    }
    try {
      const version = readFileSync("/proc/version", "utf8").toLowerCase();
      return version.includes("wsl2") || version.includes("microsoft-standard");
    } catch {
      return false;
    }
  }

  async function isWSL(): Promise<boolean> {
    if (wslCached !== null) {
      return wslCached;
    }
    if (platform !== "linux") {
      wslCached = false;
      return wslCached;
    }
    if (isWSLEnv()) {
      wslCached = true;
      return wslCached;
    }
    try {
      const release = await readFile("/proc/sys/kernel/osrelease", "utf8");
      wslCached =
        release.toLowerCase().includes("microsoft") || release.toLowerCase().includes("wsl");
    } catch {
      wslCached = false;
    }
    return wslCached;
  }

  return { isWSLEnv, isWSLSync, isWSL2Sync, isWSL, resetWSLStateForTests };
}

const defaultWslDetector = createWslDetector();

export const isWSLEnv = defaultWslDetector.isWSLEnv;
export const isWSLSync = defaultWslDetector.isWSLSync;
export const isWSL2Sync = defaultWslDetector.isWSL2Sync;
export const isWSL = defaultWslDetector.isWSL;
export const resetWSLStateForTests = defaultWslDetector.resetWSLStateForTests;

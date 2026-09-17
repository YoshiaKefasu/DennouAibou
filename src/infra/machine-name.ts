import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type ScutilKey = "ComputerName" | "LocalHostName";
type ScutilRunner = (key: ScutilKey) => Promise<{ stdout?: string | Buffer }>;

export type MachineDisplayNameDeps = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  hostname?: () => string;
  runScutil?: ScutilRunner;
};

const defaultRunScutil: ScutilRunner = async (key) =>
  await execFileAsync("/usr/sbin/scutil", ["--get", key], {
    timeout: 1000,
    windowsHide: true,
  });

export function createMachineDisplayNameResolver(deps: MachineDisplayNameDeps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const hostname = deps.hostname ?? os.hostname;
  const runScutil = deps.runScutil ?? defaultRunScutil;
  let cachedPromise: Promise<string> | null = null;

  async function tryScutil(key: ScutilKey) {
    try {
      const { stdout } = await runScutil(key);
      const value = String(stdout ?? "").trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  function fallbackHostName() {
    const trimmed = hostname().trim();
    return trimmed.replace(/\.local$/i, "") || "openclaw";
  }

  return async function getMachineDisplayName(): Promise<string> {
    if (cachedPromise) {
      return cachedPromise;
    }
    cachedPromise = (async () => {
      if (env.VITEST || env.NODE_ENV === "test") {
        return fallbackHostName();
      }
      if (platform === "darwin") {
        const computerName = await tryScutil("ComputerName");
        if (computerName) {
          return computerName;
        }
        const localHostName = await tryScutil("LocalHostName");
        if (localHostName) {
          return localHostName;
        }
      }
      return fallbackHostName();
    })();
    return cachedPromise;
  };
}

export const getMachineDisplayName = createMachineDisplayNameResolver();

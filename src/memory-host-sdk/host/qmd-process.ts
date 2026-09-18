import { spawn } from "node:child_process";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../../plugin-sdk/windows-spawn.js";

export type CliSpawnInvocation = {
  command: string;
  argv: string[];
  shell?: boolean;
  windowsHide?: boolean;
};

export type QmdBinaryAvailability = {
  available: boolean;
  error?: string;
};

/**
 * Injectable seams for the OS/process boundaries this module touches. Tests
 * supply fixtures instead of mocking `node:child_process` and patching
 * `process.platform` at module level.
 */
export type QmdProcessDeps = {
  platform?: NodeJS.Platform;
  execPath?: string;
  spawn?: typeof spawn;
  cwd?: () => string;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
};

type ResolvedQmdProcessDeps = {
  platform: NodeJS.Platform;
  execPath: string;
  spawn: typeof spawn;
  cwd: () => string;
  setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
};

function resolveQmdProcessDeps(deps: QmdProcessDeps = {}): ResolvedQmdProcessDeps {
  return {
    platform: deps.platform ?? process.platform,
    execPath: deps.execPath ?? process.execPath,
    spawn: deps.spawn ?? spawn,
    cwd: deps.cwd ?? (() => process.cwd()),
    setTimer: deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms)),
    clearTimer: deps.clearTimer ?? ((handle) => clearTimeout(handle)),
  };
}

export function resolveCliSpawnInvocation(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  packageName: string;
  deps?: Pick<QmdProcessDeps, "platform" | "execPath">;
}): CliSpawnInvocation {
  const deps = resolveQmdProcessDeps(params.deps);
  const program = resolveWindowsSpawnProgram({
    command: params.command,
    platform: deps.platform,
    env: params.env,
    execPath: deps.execPath,
    packageName: params.packageName,
    allowShellFallback: false,
  });
  return materializeWindowsSpawnProgram(program, params.args);
}

export async function checkQmdBinaryAvailability(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  deps?: QmdProcessDeps;
}): Promise<QmdBinaryAvailability> {
  const deps = resolveQmdProcessDeps(params.deps);
  let spawnInvocation: CliSpawnInvocation;
  try {
    spawnInvocation = resolveCliSpawnInvocation({
      command: params.command,
      args: [],
      env: params.env,
      packageName: "qmd",
      deps,
    });
  } catch (err) {
    return { available: false, error: formatQmdAvailabilityError(err) };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let didSpawn = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: QmdBinaryAvailability) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        deps.clearTimer(timer);
      }
      resolve(result);
    };

    const child = deps.spawn(spawnInvocation.command, spawnInvocation.argv, {
      env: params.env,
      cwd: params.cwd ?? deps.cwd(),
      shell: spawnInvocation.shell,
      windowsHide: spawnInvocation.windowsHide,
      stdio: "ignore",
    });
    timer = deps.setTimer(() => {
      child.kill("SIGKILL");
      finish({
        available: false,
        error: `spawn ${params.command} timed out after ${params.timeoutMs ?? 2_000}ms`,
      });
    }, params.timeoutMs ?? 2_000);

    child.once("error", (err) => {
      finish({ available: false, error: formatQmdAvailabilityError(err) });
    });
    child.once("spawn", () => {
      didSpawn = true;
      child.kill();
      finish({ available: true });
    });
    child.once("close", () => {
      if (!didSpawn) {
        return;
      }
      finish({ available: true });
    });
  });
}

export async function runCliCommand(params: {
  commandSummary: string;
  spawnInvocation: CliSpawnInvocation;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
  maxOutputChars: number;
  discardStdout?: boolean;
}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.spawnInvocation.command, params.spawnInvocation.argv, {
      env: params.env,
      cwd: params.cwd,
      shell: params.spawnInvocation.shell,
      windowsHide: params.spawnInvocation.windowsHide,
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const discardStdout = params.discardStdout === true;
    const timer = params.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${params.commandSummary} timed out after ${params.timeoutMs}ms`));
        }, params.timeoutMs)
      : null;
    child.stdout.on("data", (data) => {
      if (discardStdout) {
        return;
      }
      const next = appendOutputWithCap(stdout, data.toString("utf8"), params.maxOutputChars);
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr.on("data", (data) => {
      const next = appendOutputWithCap(stderr, data.toString("utf8"), params.maxOutputChars);
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });
    child.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (!discardStdout && (stdoutTruncated || stderrTruncated)) {
        reject(
          new Error(
            `${params.commandSummary} produced too much output (limit ${params.maxOutputChars} chars)`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${params.commandSummary} failed (code ${code}): ${stderr || stdout}`));
      }
    });
  });
}

function appendOutputWithCap(
  current: string,
  chunk: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const appended = current + chunk;
  if (appended.length <= maxChars) {
    return { text: appended, truncated: false };
  }
  return { text: appended.slice(-maxChars), truncated: true };
}

function formatQmdAvailabilityError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

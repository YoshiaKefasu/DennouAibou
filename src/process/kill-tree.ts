import { spawn } from "node:child_process";

const DEFAULT_GRACE_MS = 3000;
const MAX_GRACE_MS = 60_000;

type TimerHandle = { unref?: () => void };

/**
 * Injectable seams for the OS/process boundaries this module touches. Tests
 * supply fixtures instead of mocking `node:child_process` and patching
 * `process.kill`, `process.platform`, and fake timers at module level.
 */
export type KillProcessTreeDeps = {
  spawn?: typeof spawn;
  kill?: typeof process.kill;
  platform?: NodeJS.Platform;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
};

type ResolvedDeps = {
  spawn: typeof spawn;
  kill: typeof process.kill;
  platform: NodeJS.Platform;
  setTimer: (callback: () => void, ms: number) => TimerHandle;
};

function resolveDeps(deps: KillProcessTreeDeps): ResolvedDeps {
  return {
    spawn: deps.spawn ?? spawn,
    kill: deps.kill ?? process.kill,
    platform: deps.platform ?? process.platform,
    setTimer: deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms)),
  };
}

export type KillProcessTreeOptions = {
  graceMs?: number;
  deps?: KillProcessTreeDeps;
};

/**
 * Best-effort process-tree termination with graceful shutdown.
 * - Windows: use taskkill /T to include descendants. Sends SIGTERM-equivalent
 *   first (without /F), then force-kills if process survives.
 * - Unix: send SIGTERM to process group first, wait grace period, then SIGKILL.
 *
 * This gives child processes a chance to clean up (close connections, remove
 * temp files, terminate their own children) before being hard-killed.
 */
export function killProcessTree(pid: number, opts?: KillProcessTreeOptions): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  const graceMs = normalizeGraceMs(opts?.graceMs);
  const deps = resolveDeps(opts?.deps ?? {});

  if (deps.platform === "win32") {
    killProcessTreeWindows(pid, graceMs, deps);
    return;
  }

  killProcessTreeUnix(pid, graceMs, deps);
}

function normalizeGraceMs(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GRACE_MS;
  }
  return Math.max(0, Math.min(MAX_GRACE_MS, Math.floor(value)));
}

function isProcessAlive(pid: number, deps: ResolvedDeps): boolean {
  try {
    deps.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTreeUnix(pid: number, graceMs: number, deps: ResolvedDeps): void {
  // Step 1: Try graceful SIGTERM to process group
  try {
    deps.kill(-pid, "SIGTERM");
  } catch {
    // Process group doesn't exist or we lack permission - try direct
    try {
      deps.kill(pid, "SIGTERM");
    } catch {
      // Already gone
      return;
    }
  }

  // Step 2: Wait grace period, then SIGKILL if still alive
  deps
    .setTimer(() => {
      if (isProcessAlive(-pid, deps)) {
        try {
          deps.kill(-pid, "SIGKILL");
          return;
        } catch {
          // Fall through to direct pid kill
        }
      }
      if (!isProcessAlive(pid, deps)) {
        return;
      }
      try {
        deps.kill(pid, "SIGKILL");
      } catch {
        // Process exited between liveness check and kill
      }
    }, graceMs)
    .unref?.(); // Don't block event loop exit
}

function runTaskkill(args: string[], deps: ResolvedDeps): void {
  try {
    deps.spawn("taskkill", args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
  } catch {
    // Ignore taskkill spawn failures
  }
}

function killProcessTreeWindows(pid: number, graceMs: number, deps: ResolvedDeps): void {
  // Step 1: Try graceful termination (taskkill without /F)
  runTaskkill(["/T", "/PID", String(pid)], deps);

  // Step 2: Wait grace period, then force kill only if pid still exists.
  // This avoids unconditional delayed /F kills after graceful shutdown.
  deps
    .setTimer(() => {
      if (!isProcessAlive(pid, deps)) {
        return;
      }
      runTaskkill(["/F", "/T", "/PID", String(pid)], deps);
    }, graceMs)
    .unref?.(); // Don't block event loop exit
}

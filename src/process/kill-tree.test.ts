import { describe, expect, it, vi } from "vitest";
import { killProcessTree, type KillProcessTreeDeps } from "./kill-tree.js";

type TimerEntry = { callback: () => void; ms: number; fired: boolean };

/**
 * Manual timer queue + fake kill/spawn so the grace-period behavior can be
 * asserted deterministically without `vi.useFakeTimers` (unsupported by Bun)
 * or patching `process.platform` / `process.kill` globally.
 */
function createHarness(params: { platform: NodeJS.Platform; alivePids?: number[] }) {
  const alivePids = new Set(params.alivePids ?? []);
  const spawnMock = vi.fn(() => ({ unref: vi.fn() }));
  const killCalls: Array<[number, NodeJS.Signals | number | undefined]> = [];
  const timers: TimerEntry[] = [];

  const kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    killCalls.push([pid, signal]);
    if (signal === 0 && !alivePids.has(pid)) {
      throw new Error("ESRCH");
    }
    return true;
  }) as unknown as typeof process.kill;

  const deps: KillProcessTreeDeps = {
    spawn: spawnMock as unknown as KillProcessTreeDeps["spawn"],
    kill,
    platform: params.platform,
    setTimer: (callback: () => void, ms: number) => {
      timers.push({ callback, ms, fired: false });
      return { unref: vi.fn() };
    },
  };

  const advanceTimers = (ms: number) => {
    for (const entry of timers.splice(0)) {
      if (entry.ms <= ms) {
        entry.callback();
      }
    }
  };

  return { spawnMock, killCalls, deps, advanceTimers };
}

describe("killProcessTree", () => {
  it("on Windows skips delayed force-kill when PID is already gone", () => {
    const { spawnMock, deps, advanceTimers } = createHarness({ platform: "win32" });

    killProcessTree(4242, { graceMs: 25, deps });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "taskkill",
      ["/T", "/PID", "4242"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );

    advanceTimers(25);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("on Windows force-kills after grace period only when PID still exists", () => {
    const { spawnMock, deps, advanceTimers } = createHarness({
      platform: "win32",
      alivePids: [5252],
    });

    killProcessTree(5252, { graceMs: 10, deps });

    advanceTimers(10);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "taskkill",
      ["/T", "/PID", "5252"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "taskkill",
      ["/F", "/T", "/PID", "5252"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it("on Unix sends SIGTERM first and skips SIGKILL when process exits", () => {
    const { killCalls, deps, advanceTimers } = createHarness({ platform: "linux" });

    killProcessTree(3333, { graceMs: 10, deps });

    advanceTimers(10);

    expect(killCalls).toContainEqual([-3333, "SIGTERM"]);
    expect(killCalls).not.toContainEqual([-3333, "SIGKILL"]);
    expect(killCalls).not.toContainEqual([3333, "SIGKILL"]);
  });

  it("on Unix sends SIGKILL after grace period when process is still alive", () => {
    const { killCalls, deps, advanceTimers } = createHarness({
      platform: "linux",
      alivePids: [-4444],
    });

    killProcessTree(4444, { graceMs: 5, deps });

    advanceTimers(5);

    expect(killCalls).toContainEqual([-4444, "SIGTERM"]);
    expect(killCalls).toContainEqual([-4444, "SIGKILL"]);
  });

  it("ignores non-positive or non-finite pids without touching OS boundaries", () => {
    const { spawnMock, killCalls, deps } = createHarness({ platform: "win32" });

    killProcessTree(0, { deps });
    killProcessTree(-1, { deps });
    killProcessTree(Number.NaN, { deps });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(killCalls).toEqual([]);
  });
});

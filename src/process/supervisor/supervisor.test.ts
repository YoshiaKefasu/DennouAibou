import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createChildAdapter } from "./adapters/child.js";
import type { createPtyAdapter } from "./adapters/pty.js";
import { createProcessSupervisor, type ProcessSupervisorDeps } from "./supervisor.js";
import type { SpawnProcessAdapter } from "./types.js";

const createChildAdapterMock = vi.fn<typeof createChildAdapter>();
const createPtyAdapterMock = vi.fn<typeof createPtyAdapter>();

type ProcessSupervisor = ReturnType<typeof createProcessSupervisor>;
type SpawnOptions = Parameters<ProcessSupervisor["spawn"]>[0];
type ChildSpawnOptions = Omit<Extract<SpawnOptions, { mode: "child" }>, "backendId" | "mode">;
type ChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null>;
type StubChildAdapter = ChildAdapter & {
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  settle: (code: number | null, signal?: NodeJS.Signals | null) => void;
  killMock: ReturnType<typeof vi.fn>;
  disposeMock: ReturnType<typeof vi.fn>;
};

/**
 * Manual timer seam so the supervisor's timeout paths can be driven without
 * fake timers (Bun does not expose `vi.advanceTimersByTimeAsync`).
 */
function createManualTimers() {
  let nextHandle = 1;
  let nowMs = 0;
  const pending = new Map<number, { callback: () => void; dueAtMs: number }>();

  return {
    deps: {
      setTimeout: (callback: () => void, delayMs: number) => {
        const handle = nextHandle++;
        pending.set(handle, { callback, dueAtMs: nowMs + delayMs });
        return handle as unknown as NodeJS.Timeout;
      },
      clearTimeout: (handle: NodeJS.Timeout) => {
        pending.delete(handle as unknown as number);
      },
      now: () => nowMs,
    },
    advance(ms: number) {
      nowMs += ms;
      // Snapshot so timers registered by a firing callback only run on the next advance.
      for (const [handle, timer] of Array.from(pending)) {
        if (timer.dueAtMs <= nowMs) {
          pending.delete(handle);
          timer.callback();
        }
      }
    },
  };
}

function createWriteStdoutArgv(output: string): string[] {
  if (process.platform === "win32") {
    return [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`];
  }
  return ["/usr/bin/printf", "%s", output];
}

function createSilentIdleArgv(): string[] {
  return [process.execPath, "-e", "setInterval(() => {}, 1_000)"];
}

function createStubChildAdapter(options?: {
  pid?: number;
  onKill?: (signal: NodeJS.Signals | undefined, adapter: StubChildAdapter) => void;
}): StubChildAdapter {
  const stdoutListeners: Array<(chunk: string) => void> = [];
  const stderrListeners: Array<(chunk: string) => void> = [];
  let resolveWait:
    | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;
  const waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      resolveWait = resolve;
    },
  );
  const killMock = vi.fn();
  const disposeMock = vi.fn();
  let adapter!: StubChildAdapter;

  adapter = {
    pid: options?.pid ?? 1234,
    stdin: undefined,
    onStdout: (listener) => {
      stdoutListeners.push(listener);
    },
    onStderr: (listener) => {
      stderrListeners.push(listener);
    },
    wait: async () => await waitPromise,
    kill: (signal) => {
      killMock(signal);
      options?.onKill?.(signal, adapter);
    },
    dispose: () => {
      disposeMock();
    },
    emitStdout: (chunk) => {
      for (const listener of stdoutListeners) {
        listener(chunk);
      }
    },
    emitStderr: (chunk) => {
      for (const listener of stderrListeners) {
        listener(chunk);
      }
    },
    settle: (code, signal = null) => {
      resolveWait?.({ code, signal });
      resolveWait = null;
    },
    killMock,
    disposeMock,
  };

  return adapter;
}

async function spawnChild(
  supervisor: ProcessSupervisor,
  options: ChildSpawnOptions,
): Promise<Awaited<ReturnType<ProcessSupervisor["spawn"]>>> {
  return supervisor.spawn({
    ...options,
    backendId: "test",
    mode: "child",
  });
}

function createTestSupervisor(extraDeps: Partial<ProcessSupervisorDeps> = {}) {
  const timers = createManualTimers();
  const deps: ProcessSupervisorDeps = {
    createChildAdapter: createChildAdapterMock,
    createPtyAdapter: createPtyAdapterMock,
    ...timers.deps,
    ...extraDeps,
  };
  return { supervisor: createProcessSupervisor(deps), timers };
}

describe("process supervisor", () => {
  beforeEach(() => {
    createChildAdapterMock.mockReset();
    createPtyAdapterMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns child runs and captures output", async () => {
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const { supervisor } = createTestSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createWriteStdoutArgv("ok"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    adapter.emitStdout("ok");
    adapter.settle(0);

    const exit = await run.wait();
    expect(exit.reason).toBe("exit");
    expect(exit.exitCode).toBe(0);
    expect(exit.stdout).toBe("ok");
    expect(adapter.disposeMock).toHaveBeenCalledTimes(1);
  });

  it("enforces no-output timeout for silent processes", async () => {
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGKILL");
      },
    });
    createChildAdapterMock.mockResolvedValue(adapter);

    const { supervisor, timers } = createTestSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createSilentIdleArgv(),
      timeoutMs: 300,
      noOutputTimeoutMs: 5,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    timers.advance(5);

    const exit = await exitPromise;
    expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(exit.reason).toBe("no-output-timeout");
    expect(exit.noOutputTimedOut).toBe(true);
    expect(exit.timedOut).toBe(true);
  });

  it("cancels prior scoped run when replaceExistingScope is enabled", async () => {
    const first = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGKILL");
      },
    });
    const second = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const { supervisor } = createTestSupervisor();
    const firstRun = await spawnChild(supervisor, {
      sessionId: "s1",
      scopeKey: "scope:a",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 80)"],
      timeoutMs: 1_000,
      stdinMode: "pipe-open",
    });

    const secondRun = await spawnChild(supervisor, {
      sessionId: "s1",
      scopeKey: "scope:a",
      replaceExistingScope: true,
      argv: createWriteStdoutArgv("new"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    second.emitStdout("new");
    second.settle(0);

    const firstExit = await firstRun.wait();
    const secondExit = await secondRun.wait();
    expect(first.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(firstExit.reason === "manual-cancel" || firstExit.reason === "signal").toBe(true);
    expect(secondExit.reason).toBe("exit");
    expect(secondExit.stdout).toBe("new");
  });

  it("applies overall timeout even for near-immediate timer firing", async () => {
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGKILL");
      },
    });
    createChildAdapterMock.mockResolvedValue(adapter);

    const { supervisor, timers } = createTestSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s-timeout",
      argv: createSilentIdleArgv(),
      timeoutMs: 1,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    timers.advance(1);

    const exit = await exitPromise;
    expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(exit.reason).toBe("overall-timeout");
    expect(exit.timedOut).toBe(true);
  });

  it("can stream output without retaining it in RunExit payload", async () => {
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const { supervisor } = createTestSupervisor();
    let streamed = "";
    const run = await spawnChild(supervisor, {
      sessionId: "s-capture",
      argv: createWriteStdoutArgv("streamed"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
      captureOutput: false,
      onStdout: (chunk) => {
        streamed += chunk;
      },
    });

    adapter.emitStdout("streamed");
    adapter.settle(0);

    const exit = await run.wait();
    expect(streamed).toBe("streamed");
    expect(exit.stdout).toBe("");
  });
});

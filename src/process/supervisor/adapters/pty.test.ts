import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyAdapterDeps } from "./pty.js";

type ManualTimer = {
  callback: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
  unref: () => void;
};

/**
 * Manual timer queue so the SIGKILL wait fallback is driven deterministically.
 * Bun's test runner does not expose `vi.advanceTimersByTimeAsync`.
 */
function createManualTimers() {
  let elapsedMs = 0;
  const timers: ManualTimer[] = [];
  return {
    deps: {
      setTimer: (callback: () => void, ms: number) => {
        const timer: ManualTimer = {
          callback,
          ms,
          cancelled: false,
          fired: false,
          unref: () => {},
        };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (handle: ReturnType<typeof setTimeout>) => {
        (handle as unknown as ManualTimer).cancelled = true;
      },
    } satisfies PtyAdapterDeps,
    advanceBy(ms: number) {
      elapsedMs += ms;
      for (const timer of timers) {
        if (!timer.cancelled && !timer.fired && timer.ms <= elapsedMs) {
          timer.fired = true;
          timer.callback();
        }
      }
    },
  };
}

const { spawnMock, ptyKillMock, killProcessTreeMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  ptyKillMock: vi.fn(),
  killProcessTreeMock: vi.fn(),
}));

vi.mock("@lydell/node-pty", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("../../kill-tree.js", () => ({
  killProcessTree: (...args: unknown[]) => killProcessTreeMock(...args),
}));

function createStubPty(pid = 1234) {
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  return {
    pid,
    write: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListener = listener;
      return { dispose: vi.fn() };
    }),
    kill: (signal?: string) => ptyKillMock(signal),
    emitExit: (event: { exitCode: number; signal?: number }) => {
      exitListener?.(event);
    },
  };
}

function expectSpawnEnv() {
  const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
  return spawnOptions?.env;
}

describe("createPtyAdapter", () => {
  let createPtyAdapter: typeof import("./pty.js").createPtyAdapter;

  beforeAll(async () => {
    ({ createPtyAdapter } = await import("./pty.js"));
  });

  beforeEach(() => {
    spawnMock.mockClear();
    ptyKillMock.mockClear();
    killProcessTreeMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards explicit signals to node-pty kill on non-Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      spawnMock.mockReturnValue(createStubPty());

      const adapter = await createPtyAdapter({
        shell: "bash",
        args: ["-lc", "sleep 10"],
      });

      adapter.kill("SIGTERM");
      expect(ptyKillMock).toHaveBeenCalledWith("SIGTERM");
      expect(killProcessTreeMock).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  it("uses process-tree kill for SIGKILL by default", async () => {
    spawnMock.mockReturnValue(createStubPty());

    const adapter = await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "sleep 10"],
    });

    adapter.kill();
    expect(killProcessTreeMock).toHaveBeenCalledWith(1234);
    expect(ptyKillMock).not.toHaveBeenCalled();
  });

  it("wait does not settle immediately on SIGKILL", async () => {
    const timers = createManualTimers();
    spawnMock.mockReturnValue(createStubPty());

    const adapter = await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "sleep 10"],
      deps: timers.deps,
    });

    const waitPromise = adapter.wait();
    const settled = vi.fn();
    void waitPromise.then(() => settled());

    adapter.kill();

    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    timers.advanceBy(3999);
    expect(settled).not.toHaveBeenCalled();

    timers.advanceBy(1);
    await expect(waitPromise).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  it("prefers real PTY exit over SIGKILL fallback settle", async () => {
    const timers = createManualTimers();
    const stub = createStubPty();
    spawnMock.mockReturnValue(stub);

    const adapter = await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "sleep 10"],
      deps: timers.deps,
    });

    const waitPromise = adapter.wait();
    adapter.kill();
    stub.emitExit({ exitCode: 0, signal: 9 });

    await expect(waitPromise).resolves.toEqual({ code: 0, signal: 9 });

    timers.advanceBy(4_001);
    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: 9 });
  });

  it("resolves wait when exit fires before wait is called", async () => {
    const stub = createStubPty();
    spawnMock.mockReturnValue(stub);

    const adapter = await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "exit 3"],
    });

    expect(stub.onExit).toHaveBeenCalledTimes(1);
    stub.emitExit({ exitCode: 3, signal: 0 });
    await expect(adapter.wait()).resolves.toEqual({ code: 3, signal: null });
  });

  it("keeps inherited env when no override env is provided", async () => {
    const stub = createStubPty();
    spawnMock.mockReturnValue(stub);

    await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "env"],
    });

    expect(expectSpawnEnv()).toBeUndefined();
  });

  it("passes explicit env overrides as strings", async () => {
    const stub = createStubPty();
    spawnMock.mockReturnValue(stub);

    await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "env"],
      env: { FOO: "bar", COUNT: "12", DROP_ME: undefined },
    });

    expect(expectSpawnEnv()).toEqual({ FOO: "bar", COUNT: "12" });
  });

  it("does not pass a signal to node-pty on Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      spawnMock.mockReturnValue(createStubPty());

      const adapter = await createPtyAdapter({
        shell: "powershell.exe",
        args: ["-NoLogo"],
      });

      adapter.kill("SIGTERM");
      expect(ptyKillMock).toHaveBeenCalledWith(undefined);
      expect(killProcessTreeMock).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  it("uses process-tree kill for SIGKILL on Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      spawnMock.mockReturnValue(createStubPty(4567));

      const adapter = await createPtyAdapter({
        shell: "powershell.exe",
        args: ["-NoLogo"],
      });

      adapter.kill("SIGKILL");
      expect(killProcessTreeMock).toHaveBeenCalledWith(4567);
      expect(ptyKillMock).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });
});

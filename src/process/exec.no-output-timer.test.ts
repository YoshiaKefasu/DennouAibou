import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "./exec.js";

const spawnMock = vi.fn();

function createFakeSpawnedChild() {
  const child = new EventEmitter() as EventEmitter & ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let killed = false;
  const kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => {
    killed = true;
    return true;
  });
  Object.defineProperty(child, "killed", {
    get: () => killed,
    configurable: true,
  });
  Object.defineProperty(child, "pid", {
    value: 12345,
    configurable: true,
  });
  child.stdout = stdout as ChildProcess["stdout"];
  child.stderr = stderr as ChildProcess["stderr"];
  child.stdin = null;
  child.kill = kill as ChildProcess["kill"];
  return { child, stdout, stderr, kill };
}

const noOutputTimerDeps = { spawn: spawnMock, platform: "linux" } as const;

function emitProcessExit(
  fake: ReturnType<typeof createFakeSpawnedChild>,
  params?: {
    code?: number | null;
    signal?: NodeJS.Signals | null;
  },
) {
  const code = params?.code ?? null;
  const signal = params?.signal ?? null;
  fake.child.emit("exit", code, signal);
  fake.child.emit("close", code, signal);
}

describe("runCommandWithTimeout no-output timer", () => {
  beforeEach(() => {
    spawnMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resets no-output timeout when spawned child keeps emitting stdout", async () => {
    vi.useFakeTimers();
    const fake = createFakeSpawnedChild();
    spawnMock.mockReturnValue(fake.child);

    const runPromise = runCommandWithTimeout(
      ["node", "-e", "ignored"],
      {
        timeoutMs: 1_000,
        noOutputTimeoutMs: 80,
      },
      noOutputTimerDeps,
    );

    fake.stdout.emit("data", Buffer.from("."));
    vi.advanceTimersByTime(40);
    fake.stdout.emit("data", Buffer.from("."));
    vi.advanceTimersByTime(40);
    fake.stdout.emit("data", Buffer.from("."));
    vi.advanceTimersByTime(20);

    fake.child.emit("close", 0, null);
    const result = await runPromise;

    expect(result.code ?? 0).toBe(0);
    expect(result.termination).toBe("exit");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.stdout).toBe("...");
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it("marks no-output timeout when the spawned child goes silent", async () => {
    vi.useFakeTimers();
    const fake = createFakeSpawnedChild();
    spawnMock.mockReturnValue(fake.child);

    const runPromise = runCommandWithTimeout(
      ["node", "-e", "ignored"],
      {
        timeoutMs: 1_000,
        noOutputTimeoutMs: 80,
      },
      noOutputTimerDeps,
    );

    vi.advanceTimersByTime(81);
    expect(fake.kill).toHaveBeenCalledWith("SIGKILL");

    emitProcessExit(fake, { signal: "SIGKILL" });
    const result = await runPromise;

    expect(result.termination).toBe("no-output-timeout");
    expect(result.noOutputTimedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("marks global timeout when overall timeout elapses", async () => {
    vi.useFakeTimers();
    const fake = createFakeSpawnedChild();
    spawnMock.mockReturnValue(fake.child);

    const runPromise = runCommandWithTimeout(
      ["node", "-e", "ignored"],
      {
        timeoutMs: 80,
      },
      noOutputTimerDeps,
    );

    vi.advanceTimersByTime(81);
    expect(fake.kill).toHaveBeenCalledWith("SIGKILL");

    emitProcessExit(fake, { signal: "SIGKILL" });
    const result = await runPromise;

    expect(result.termination).toBe("timeout");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.code).not.toBe(0);
  });
});

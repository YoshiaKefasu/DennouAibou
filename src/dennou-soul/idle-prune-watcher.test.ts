import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { startIdlePruneWatcher } from "./idle-prune-watcher.js";

type ManualTimer = { run: () => void; cancelled: boolean };

let timers: ManualTimer[] = [];

const scheduleTimeout = vi.fn((callback: () => void) => {
  const entry: ManualTimer = { run: callback, cancelled: false };
  timers.push(entry);
  return entry as unknown as ReturnType<typeof setTimeout>;
});
const cancelTimeout = vi.fn((timer: ReturnType<typeof setTimeout>) => {
  (timer as unknown as ManualTimer).cancelled = true;
});
const getDennouConfig = vi.fn(() => ({
  activeSessionToolsPrune: {
    enabled: true,
    minPrunableToolChars: 1200,
    keepLastAssistants: 12,
    placeholder: "[pruned]",
    dryRun: false,
    idleDelayMinutes: 0.001,
  },
}));

/** Runs the pending (non-cancelled) timers in creation order. */
function runPendingTimers() {
  for (const timer of timers.filter((entry) => !entry.cancelled)) {
    timer.run();
  }
}

describe("startIdlePruneWatcher", () => {
  let stop: (() => void) | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    timers = [];
    resetDiagnosticEventsForTest();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getDennouConfig.mockClear();
    scheduleTimeout.mockClear();
    cancelTimeout.mockClear();
    stop = startIdlePruneWatcher(
      {
        protectedContentKeywords: [],
        resolvedWorkspacePaths: [],
      },
      {
        getDennouConfig: getDennouConfig as never,
        setTimeout: scheduleTimeout as unknown as typeof setTimeout,
        clearTimeout: cancelTimeout as unknown as typeof clearTimeout,
      },
    );
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    warnSpy.mockRestore();
    resetDiagnosticEventsForTest();
  });

  it("does not replace a sessionId-backed idle timer with a sessionId-less idle event", () => {
    emitDiagnosticEvent({
      type: "session.state",
      sessionKey: "agent:main:telegram:slash:8000537189",
      sessionId: "session-for-prune",
      state: "idle",
      reason: "run_completed",
    });
    emitDiagnosticEvent({
      type: "session.state",
      sessionKey: "agent:main:telegram:slash:8000537189",
      state: "idle",
      reason: "message_completed",
    });

    runPendingTimers();

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("missing agentId or sessionId"),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("session-for-prune.jsonl"));
  });

  it("replaces an existing timer when a newer idle event has a different sessionId", () => {
    emitDiagnosticEvent({
      type: "session.state",
      sessionKey: "agent:main:telegram:slash:8000537189",
      sessionId: "old-session",
      state: "idle",
      reason: "run_completed",
    });
    emitDiagnosticEvent({
      type: "session.state",
      sessionKey: "agent:main:telegram:slash:8000537189",
      sessionId: "new-session",
      state: "idle",
      reason: "run_completed",
    });

    runPendingTimers();

    expect(cancelTimeout).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("old-session.jsonl"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("new-session.jsonl"));
  });

  it("skips prune when only a sessionId-less idle event is available", () => {
    emitDiagnosticEvent({
      type: "session.state",
      sessionKey: "agent:main:telegram:slash:8000537189",
      state: "idle",
      reason: "message_completed",
    });

    runPendingTimers();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("missing agentId or sessionId"));
  });
});

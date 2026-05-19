import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";

const configMocks = vi.hoisted(() => ({
  delayMs: 61,
  getDennouConfig: vi.fn(() => ({
    activeSessionToolsPrune: {
      enabled: true,
      minPrunableToolChars: 1200,
      keepLastTools: 12,
      placeholder: "[pruned]",
      dryRun: false,
      idleDelayMinutes: 0.001,
    },
  })),
}));

vi.mock("./config.js", () => ({
  getDennouConfig: configMocks.getDennouConfig,
}));

describe("startIdlePruneWatcher", () => {
  let stop: (() => void) | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    resetDiagnosticEventsForTest();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startIdlePruneWatcher } = await import("./idle-prune-watcher.js");
    stop = startIdlePruneWatcher({
      protectedContentKeywords: [],
      resolvedWorkspacePaths: [],
    });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    warnSpy.mockRestore();
    resetDiagnosticEventsForTest();
    vi.useRealTimers();
  });

  it("does not replace a sessionId-backed idle timer with a sessionId-less idle event", async () => {
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

    await vi.advanceTimersByTimeAsync(configMocks.delayMs);

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("missing agentId or sessionId"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("session-for-prune.jsonl"),
    );
  });

  it("replaces an existing timer when a newer idle event has a different sessionId", async () => {
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

    await vi.advanceTimersByTimeAsync(configMocks.delayMs);

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("old-session.jsonl"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("new-session.jsonl"));
  });

  it("skips prune when only a sessionId-less idle event is available", async () => {
    emitDiagnosticEvent({
      type: "session.state",
      sessionKey: "agent:main:telegram:slash:8000537189",
      state: "idle",
      reason: "message_completed",
    });

    await vi.advanceTimersByTimeAsync(configMocks.delayMs);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("missing agentId or sessionId"),
    );
  });
});

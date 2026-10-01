import { describe, expect, it, vi } from "vitest";
import { createAlarmFireHandler, formatAlarmFireText } from "../src/fire.js";
import type { FireEvent, StoredAlarm } from "../src/types.js";

function makeAlarm(): StoredAlarm {
  return {
    id: "alarm_1",
    label: "テスト",
    task: "Yosiaに3分経ったと伝える",
    timeExpression: "3m",
    kind: "once",
    targetTimeMs: 1_000,
    createdAtMs: 0,
    enabled: true,
  };
}

function makeEvent(): FireEvent {
  return { alarm: makeAlarm(), firedAtMs: 2_000, delayed: false };
}

describe("dennou-alarm Phase 2 fire handler", () => {
  it("formats the system-event text with alarm id and task", () => {
    expect(formatAlarmFireText(makeAlarm())).toBe(
      "【電脳アラーム発火 (ID: alarm_1)】タスク: Yosiaに3分経ったと伝える",
    );
  });

  it("enqueues a system event and runs the pump with heartbeat last", async () => {
    const enqueueSystemEvent = vi.fn();
    const runEventPumpOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    const fire = createAlarmFireHandler({
      enqueueSystemEvent: enqueueSystemEvent as never,
      runEventPumpOnce: runEventPumpOnce as never,
      resolveSessionKey: () => "agent:main:main",
    });
    await fire(makeEvent());

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "【電脳アラーム発火 (ID: alarm_1)】タスク: Yosiaに3分経ったと伝える",
      { sessionKey: "agent:main:main", contextKey: "alarm:alarm_1" },
    );
    expect(runEventPumpOnce).toHaveBeenCalledTimes(1);
    expect(runEventPumpOnce).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      reason: "alarm:alarm_1",
      heartbeat: { target: "last" },
    });
  });

  it("requests a wake when the pump skips the run", async () => {
    const enqueueSystemEvent = vi.fn();
    const runEventPumpOnce = vi.fn(async () => ({
      status: "skipped" as const,
      reason: "no-events",
    }));
    const requestWakeNow = vi.fn();
    const fire = createAlarmFireHandler({
      enqueueSystemEvent: enqueueSystemEvent as never,
      runEventPumpOnce: runEventPumpOnce as never,
      resolveSessionKey: () => "agent:main:main",
      requestWakeNow: requestWakeNow as never,
    });

    await fire(makeEvent());

    expect(requestWakeNow).toHaveBeenCalledTimes(1);
    expect(requestWakeNow).toHaveBeenCalledWith({ reason: "alarm:alarm_1" });
  });

  it("resolves the session key with the configured session scope", async () => {
    const enqueueSystemEvent = vi.fn();
    const runEventPumpOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    const requestWakeNow = vi.fn();
    const fire = createAlarmFireHandler({
      enqueueSystemEvent: enqueueSystemEvent as never,
      runEventPumpOnce: runEventPumpOnce as never,
      requestWakeNow: requestWakeNow as never,
    });

    await fire(makeEvent(), { session: { scope: "global" } } as never);

    expect(enqueueSystemEvent).toHaveBeenCalledWith(expect.any(String), {
      sessionKey: "global",
      contextKey: "alarm:alarm_1",
    });
    expect(requestWakeNow).not.toHaveBeenCalled();
  });
});

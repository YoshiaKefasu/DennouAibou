import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AlarmStore,
  CATCH_UP_DELAYED_MS,
  CATCH_UP_PROMPT_MS,
  applyCatchUpToStore,
  computeRepeatingNextFireMs,
  decideCatchUp,
  nextFireDueMs,
  resolveAlarmStorePath,
} from "../src/storage.js";
import { zonedTimeToMs } from "../src/time-parser.js";
import type { StoredAlarm } from "../src/types.js";

const TZ = "Asia/Jakarta";
const NOW_MS = zonedTimeToMs(TZ, 2026, 10, 1, 12, 0);

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
  }
});

function tempStorePath(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dennou-alarm-")), "alarms.json");
  tempFiles.push(file);
  return file;
}

function oneShot(targetTimeMs: number): StoredAlarm {
  return {
    id: "alarm_1",
    label: "test",
    task: "test task",
    timeExpression: "18:30",
    kind: "once",
    targetTimeMs,
    timezone: TZ,
    createdAtMs: NOW_MS - 60_000,
    enabled: true,
  };
}

describe("storage: save and load", () => {
  it("persists alarms across store instances", () => {
    const file = tempStorePath();
    const store = new AlarmStore(file);
    store.upsert(oneShot(NOW_MS + 60_000));

    const reopened = new AlarmStore(file);
    const alarms = reopened.list();
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.id).toBe("alarm_1");
    expect(alarms[0]!.task).toBe("test task");
  });

  it("allocates increasing ids", () => {
    const store = new AlarmStore(tempStorePath());
    expect(store.allocateId()).toBe("alarm_1");
    expect(store.allocateId()).toBe("alarm_2");
  });

  it("updates and removes alarms", () => {
    const store = new AlarmStore(tempStorePath());
    store.upsert(oneShot(NOW_MS + 60_000));
    const updated = store.update("alarm_1", { task: "updated" });
    expect(updated!.task).toBe("updated");
    expect(store.get("alarm_1")!.task).toBe("updated");
    expect(store.remove("alarm_1")).toBe(true);
    expect(store.remove("alarm_1")).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it("starts empty on corrupt files", () => {
    const file = tempStorePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json", "utf-8");
    const store = new AlarmStore(file);
    expect(store.list()).toHaveLength(0);
  });
});

describe("storage: catch-up policy", () => {
  it("fires immediately when overdue within 5 minutes", () => {
    const alarm = oneShot(NOW_MS - (CATCH_UP_PROMPT_MS - 1_000));
    const decision = decideCatchUp(alarm, NOW_MS);
    expect(decision).toEqual({ action: "fire-now", delayed: false });
  });

  it("fires with delay flag when overdue 5min–1h", () => {
    const alarm = oneShot(NOW_MS - (CATCH_UP_PROMPT_MS + 60_000));
    const decision = decideCatchUp(alarm, NOW_MS);
    expect(decision).toEqual({ action: "fire-now", delayed: true });
    expect(NOW_MS - (CATCH_UP_PROMPT_MS + 60_000)).toBeGreaterThan(NOW_MS - CATCH_UP_DELAYED_MS);
  });

  it("skips one-shot alarms overdue more than 1 hour", () => {
    const alarm = oneShot(NOW_MS - (CATCH_UP_DELAYED_MS + 60_000));
    expect(decideCatchUp(alarm, NOW_MS)).toEqual({ action: "skip" });
  });

  it("reschedules repeating alarms to the next future slot", () => {
    const alarm: StoredAlarm = {
      id: "alarm_9",
      label: "hourly",
      task: "hourly task",
      timeExpression: "every 1h",
      kind: "interval",
      intervalMs: 3_600_000,
      timezone: TZ,
      createdAtMs: NOW_MS - 4_500_000,
      lastFiredAtMs: NOW_MS - 4_500_000,
      targetTimeMs: NOW_MS + 2_700_000,
      enabled: true,
    };
    const decision = decideCatchUp(alarm, NOW_MS);
    expect(decision.action).toBe("reschedule");
    if (decision.action === "reschedule") {
      expect(decision.nextFireMs).toBeGreaterThan(NOW_MS);
    }
    const recomputed = computeRepeatingNextFireMs(alarm, NOW_MS);
    expect(recomputed).toBeGreaterThan(NOW_MS);
  });

  it("reschedules future alarms without firing", () => {
    const alarm = oneShot(NOW_MS + 60_000);
    expect(decideCatchUp(alarm, NOW_MS)).toEqual({
      action: "reschedule",
      nextFireMs: NOW_MS + 60_000,
    });
    expect(nextFireDueMs(alarm, NOW_MS)).toBe(NOW_MS + 60_000);
  });

  it("ignores disabled alarms", () => {
    const alarm: StoredAlarm = { ...oneShot(NOW_MS + 60_000), enabled: false };
    expect(nextFireDueMs(alarm, NOW_MS)).toBeUndefined();
  });

  it("leaves disabled alarms untouched", () => {
    const alarm: StoredAlarm = { ...oneShot(NOW_MS + 60_000), enabled: false };
    expect(decideCatchUp(alarm, NOW_MS)).toEqual({ action: "leave" });
  });
});

describe("storage: applyCatchUpToStore", () => {
  it("keeps disabled long-overdue alarms and drops expired one-shots", () => {
    const file = tempStorePath();
    const store = new AlarmStore(file);
    const disabled: StoredAlarm = {
      ...oneShot(NOW_MS - (CATCH_UP_DELAYED_MS + 60_000)),
      id: "alarm_1",
      enabled: false,
    };
    const expired: StoredAlarm = {
      ...oneShot(NOW_MS - (CATCH_UP_DELAYED_MS + 60_000)),
      id: "alarm_2",
      enabled: true,
    };
    const future: StoredAlarm = {
      ...oneShot(NOW_MS + 60_000),
      id: "alarm_3",
      enabled: true,
    };
    store.upsert(disabled);
    store.upsert(expired);
    store.upsert(future);

    const messages: string[] = [];
    const summary = applyCatchUpToStore(store, NOW_MS, {
      info: (message: string) => {
        messages.push(message);
      },
    });

    expect(summary.removed).toBe(1);
    expect(summary.left).toBe(2);
    // Disabled long-overdue alarm is kept, not removed.
    expect(store.get("alarm_1")).toBeDefined();
    expect(store.get("alarm_2")).toBeUndefined();
    expect(store.get("alarm_3")).toBeDefined();
    expect(messages).toEqual(["dennou-alarm: dropped long-overdue one-shot alarm_2."]);
  });

  it("reschedules repeating alarms to a future slot", () => {
    const file = tempStorePath();
    const store = new AlarmStore(file);
    const repeating: StoredAlarm = {
      id: "alarm_9",
      label: "hourly",
      task: "hourly task",
      timeExpression: "every 1h",
      kind: "interval",
      intervalMs: 3_600_000,
      timezone: TZ,
      createdAtMs: NOW_MS - 4_500_000,
      lastFiredAtMs: NOW_MS - 4_500_000,
      targetTimeMs: NOW_MS - (CATCH_UP_DELAYED_MS + 60_000),
      enabled: true,
    };
    store.upsert(repeating);

    const summary = applyCatchUpToStore(store, NOW_MS);
    expect(summary.rescheduled).toBe(1);
    const updated = store.get("alarm_9");
    expect(updated?.targetTimeMs).toBeGreaterThan(NOW_MS);
  });
});

describe("storage: path resolution", () => {
  it("resolves under the state dir agents/main", () => {
    const resolved = resolveAlarmStorePath({
      DENNOU_STATE_DIR: "/tmp/alarm-state",
    } as NodeJS.ProcessEnv);
    // Windows resolves "/tmp/..." against the current drive; assert the tail.
    expect(resolved.endsWith(path.join("agents", "main", "dennou-alarm.json"))).toBe(true);
    expect(resolved).toContain("alarm-state");
  });
});

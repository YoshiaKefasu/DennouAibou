import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlarmScheduler } from "../src/scheduler.js";
import { AlarmStore } from "../src/storage.js";
import { zonedTimeToMs } from "../src/time-parser.js";
import type { FireEvent, StoredAlarm } from "../src/types.js";

const TZ = "Asia/Jakarta";
const NOW_MS = zonedTimeToMs(TZ, 2026, 10, 1, 12, 0);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures.
    }
  }
});

function memoryStore(): AlarmStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dennou-alarm-sched-"));
  tempDirs.push(dir);
  return new AlarmStore(path.join(dir, "alarms.json"));
}

function oneShot(id: string, targetTimeMs: number): StoredAlarm {
  return {
    id,
    label: id,
    task: `task ${id}`,
    timeExpression: "15m",
    kind: "once",
    targetTimeMs,
    timezone: TZ,
    createdAtMs: NOW_MS - 60_000,
    enabled: true,
  };
}

describe("scheduler: timer firing", () => {
  it("fires due one-shot alarms via the callback", async () => {
    const store = memoryStore();
    store.upsert(oneShot("alarm_1", NOW_MS - 1_000));
    store.upsert(oneShot("alarm_2", NOW_MS + 3_600_000));

    const events: FireEvent[] = [];
    const scheduler = new AlarmScheduler({
      store,
      onFire: (event) => {
        events.push(event);
      },
      now: () => NOW_MS,
    });

    const fired = await scheduler.checkOnce(NOW_MS);
    expect(fired.map((alarm) => alarm.id)).toEqual(["alarm_1"]);
    expect(events).toHaveLength(1);
    expect(events[0]!.alarm.id).toBe("alarm_1");
    expect(events[0]!.firedAtMs).toBe(NOW_MS);
  });

  it("removes one-shot alarms after firing", async () => {
    const store = memoryStore();
    store.upsert(oneShot("alarm_1", NOW_MS - 1_000));

    const scheduler = new AlarmScheduler({
      store,
      onFire: () => {},
      now: () => NOW_MS,
    });
    await scheduler.checkOnce(NOW_MS);
    expect(store.list()).toHaveLength(0);
  });

  it("keeps repeating alarms and advances their next fire time", async () => {
    const store = memoryStore();
    store.upsert({
      id: "alarm_7",
      label: "hourly",
      task: "hourly task",
      timeExpression: "every 1h",
      kind: "interval",
      intervalMs: 3_600_000,
      targetTimeMs: NOW_MS - 1_000,
      timezone: TZ,
      createdAtMs: NOW_MS - 3_600_000,
      enabled: true,
    });

    const scheduler = new AlarmScheduler({
      store,
      onFire: () => {},
      now: () => NOW_MS,
    });
    await scheduler.checkOnce(NOW_MS);
    const remaining = store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.targetTimeMs).toBe(NOW_MS + 3_600_000);
    expect(remaining[0]!.lastFiredAtMs).toBe(NOW_MS);
  });

  it("does not fire future alarms", async () => {
    const store = memoryStore();
    store.upsert(oneShot("alarm_1", NOW_MS + 60_000));

    const onFire = vi.fn();
    const scheduler = new AlarmScheduler({ store, onFire, now: () => NOW_MS });
    const fired = await scheduler.checkOnce(NOW_MS);
    expect(fired).toHaveLength(0);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("continues past a failing handler and reports the error", async () => {
    const store = memoryStore();
    store.upsert(oneShot("alarm_1", NOW_MS - 1_000));
    store.upsert(oneShot("alarm_2", NOW_MS - 500));

    const errors: unknown[] = [];
    const seen: string[] = [];
    const scheduler = new AlarmScheduler({
      store,
      onFire: (event) => {
        if (event.alarm.id === "alarm_1") {
          throw new Error("boom");
        }
        seen.push(event.alarm.id);
      },
      now: () => NOW_MS,
      onError: (error) => {
        errors.push(error);
      },
    });
    await scheduler.checkOnce(NOW_MS);
    expect(seen).toEqual(["alarm_2"]);
    expect(errors).toHaveLength(1);
    // Failed alarm stays queued; the successful one-shot is removed.
    expect(store.get("alarm_1")).toBeDefined();
    expect(store.get("alarm_2")).toBeUndefined();
  });

  it("starts and stops the interval timer", () => {
    const store = memoryStore();
    let cleared: unknown;
    const scheduler = new AlarmScheduler({
      store,
      onFire: () => {},
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: (handle) => {
        cleared = handle;
      },
    });
    expect(scheduler.isRunning).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
    expect(cleared).toBeDefined();
  });
});

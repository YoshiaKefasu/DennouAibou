import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAlarmTool } from "../src/alarm-tool.js";
import { AlarmScheduler } from "../src/scheduler.js";
import { AlarmStore, getSharedAlarmStore, resetSharedAlarmStoresForTests } from "../src/storage.js";
import { zonedTimeToMs } from "../src/time-parser.js";
import type { FireEvent } from "../src/types.js";

const TZ = "Asia/Jakarta";
const NOW_MS = zonedTimeToMs(TZ, 2026, 10, 1, 12, 0);

const tempDirs: string[] = [];

afterEach(() => {
  resetSharedAlarmStoresForTests();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures.
    }
  }
});

function tempStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dennou-alarm-integration-"));
  tempDirs.push(dir);
  return path.join(dir, "alarms.json");
}

describe("dennou-alarm integration: tool set -> scheduler fire", () => {
  it("fires an alarm saved via the tool using the same shared store", async () => {
    // Shared-instance path: the tool writes to the store, and the scheduler
    // observing the SAME store instance detects and fires it.
    const store = new AlarmStore(tempStorePath());
    const tool = createAlarmTool({ store, now: () => NOW_MS });
    await tool.execute!("call_1", { action: "set", time: "30s", task: "統合テスト発火" });
    expect(store.list()).toHaveLength(1);

    const events: FireEvent[] = [];
    const scheduler = new AlarmScheduler({
      store,
      onFire: (event) => {
        events.push(event);
      },
      now: () => NOW_MS + 31_000,
    });
    const fired = await scheduler.checkOnce(NOW_MS + 31_000);
    expect(fired.map((alarm) => alarm.id)).toEqual(["alarm_1"]);
    expect(events).toHaveLength(1);
    expect(events[0]!.alarm.task).toBe("統合テスト発火");
    expect(events[0]!.delayed).toBe(false);
    // One-shot alarms are removed after firing.
    expect(store.list()).toHaveLength(0);
  });

  it("shares state across store instances via the same file path", async () => {
    // File-backed path: `getSharedAlarmStore` equivalent — two instances on
    // the same path observe the same persisted alarm.
    const file = tempStorePath();
    const writer = new AlarmStore(file);
    const tool = createAlarmTool({ store: writer, now: () => NOW_MS });
    await tool.execute!("call_1", { action: "set", time: "30s", task: "ファイル共有テスト" });

    const reader = new AlarmStore(file);
    expect(reader.list()).toHaveLength(1);

    const events: FireEvent[] = [];
    const scheduler = new AlarmScheduler({
      store: reader,
      onFire: (event) => {
        events.push(event);
      },
      now: () => NOW_MS + 31_000,
    });
    const fired = await scheduler.checkOnce(NOW_MS + 31_000);
    expect(fired).toHaveLength(1);
    expect(events[0]!.alarm.task).toBe("ファイル共有テスト");
  });
});

describe("dennou-alarm integration: shared store", () => {
  it("returns the same store instance for the same path", () => {
    const file = tempStorePath();
    expect(getSharedAlarmStore(file)).toBe(getSharedAlarmStore(file));
    expect(getSharedAlarmStore(tempStorePath())).not.toBe(getSharedAlarmStore(file));
  });

  it("exposes tool writes through the shared store", async () => {
    const file = tempStorePath();
    const tool = createAlarmTool({ storePath: file, now: () => NOW_MS });
    await tool.execute!("call_1", { action: "set", time: "30s", task: "共有ストア回帰" });
    const shared = getSharedAlarmStore(file);
    expect(shared.list().map((alarm) => alarm.task)).toEqual(["共有ストア回帰"]);
  });
});

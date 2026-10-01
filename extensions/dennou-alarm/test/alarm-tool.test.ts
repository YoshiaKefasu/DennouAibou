import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAlarmTool, formatAlarmList } from "../src/alarm-tool.js";
import { AlarmStore } from "../src/storage.js";
import { zonedTimeToMs } from "../src/time-parser.js";

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

function testSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dennou-alarm-tool-"));
  tempDirs.push(dir);
  const store = new AlarmStore(path.join(dir, "alarms.json"));
  const tool = createAlarmTool({ store, now: () => NOW_MS });
  return { store, tool };
}

function toolText(result: unknown): string {
  const record = result as {
    content?: Array<{ type?: string; text?: string }>;
  };
  return record.content?.map((entry) => entry.text ?? "").join("\n") ?? "";
}

describe("alarm-tool: set", () => {
  it("sets a relative timer alarm", async () => {
    const { tool, store } = testSetup();
    const result = await tool.execute!("call_1", {
      action: "set",
      time: "15m",
      task: "声をかける",
    });
    const text = toolText(result);
    expect(text).toMatch(/\[alarm_1\] をセットしました/);
    expect(text).toContain("15m");
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.kind).toBe("once");
  });

  it("sets a daily repeating alarm", async () => {
    const { tool, store } = testSetup();
    await tool.execute!("call_1", { action: "set", time: "daily 08:30", task: "朝の挨拶" });
    expect(store.list()[0]!.kind).toBe("cron");
    expect(store.list()[0]!.cronExpression).toBe("30 8 * * *");
  });

  it("rejects set without time and task", async () => {
    const { tool } = testSetup();
    await expect(tool.execute!("call_1", { action: "set", task: "only task" })).rejects.toThrow(
      /requires both 'time' and 'task'/,
    );
    await expect(tool.execute!("call_1", { action: "set", time: "15m" })).rejects.toThrow(
      /requires both 'time' and 'task'/,
    );
  });

  it("rejects unparsable time expressions", async () => {
    const { tool } = testSetup();
    await expect(
      tool.execute!("call_1", { action: "set", time: "someday", task: "x" }),
    ).rejects.toThrow(/Cannot parse/);
  });
});

describe("alarm-tool: list", () => {
  it("returns the empty message when no alarms exist", async () => {
    const { tool } = testSetup();
    const result = await tool.execute!("call_1", { action: "list" });
    expect(toolText(result)).toBe("現在セットされているアラームはありません。");
  });

  it("formats set alarms in list form", async () => {
    const { tool } = testSetup();
    await tool.execute!("call_1", { action: "set", time: "15m", task: "声をかける" });
    await tool.execute!("call_2", { action: "set", time: "daily 09:00", task: "朝の挨拶" });
    const result = await tool.execute!("call_3", { action: "list" });
    const text = toolText(result);
    expect(text).toMatch(/電脳アラーム \(2件\)/);
    expect(text).toContain("[alarm_1]");
    expect(text).toContain("[alarm_2]");
  });

  it("formats a raw list via formatAlarmList", () => {
    const text = formatAlarmList([], NOW_MS);
    expect(text).toBe("現在セットされているアラームはありません。");
  });
});

describe("alarm-tool: cancel", () => {
  it("cancels an existing alarm", async () => {
    const { tool, store } = testSetup();
    await tool.execute!("call_1", { action: "set", time: "15m", task: "声をかける" });
    const result = await tool.execute!("call_2", { action: "cancel", id: "alarm_1" });
    expect(toolText(result)).toMatch(/\[alarm_1\] をキャンセルしました/);
    expect(store.list()).toHaveLength(0);
  });

  it("requires id for cancel", async () => {
    const { tool } = testSetup();
    await expect(tool.execute!("call_1", { action: "cancel" })).rejects.toThrow(/requires 'id'/);
  });

  it("rejects unknown alarm ids", async () => {
    const { tool } = testSetup();
    await expect(tool.execute!("call_1", { action: "cancel", id: "alarm_999" })).rejects.toThrow(
      /not found/,
    );
  });

  it("rejects unknown actions", async () => {
    const { tool } = testSetup();
    await expect(tool.execute!("call_1", { action: "snooze" })).rejects.toThrow(/Unknown action/);
  });
});

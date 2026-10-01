import { describe, expect, it } from "vitest";
import {
  nextCronRunMs,
  parseAlarmTimeExpression,
  parseRelativeDurationMs,
  resolveAlarmTimezone,
  zonedTimeToMs,
} from "../src/time-parser.js";

const TZ = "Asia/Jakarta";
const NOW_MS = zonedTimeToMs(TZ, 2026, 10, 1, 12, 0);

describe("time-parser: relative durations", () => {
  it("parses seconds, minutes, hours", () => {
    expect(parseRelativeDurationMs("30s")).toBe(30_000);
    expect(parseRelativeDurationMs("5m")).toBe(300_000);
    expect(parseRelativeDurationMs("1h")).toBe(3_600_000);
  });

  it("parses compound durations", () => {
    expect(parseRelativeDurationMs("2h30m")).toBe(2 * 3_600_000 + 30 * 60_000);
    expect(parseRelativeDurationMs("1h30m45s")).toBe(3_600_000 + 1_800_000 + 45_000);
  });

  it("rejects garbage", () => {
    expect(parseRelativeDurationMs("")).toBeUndefined();
    expect(parseRelativeDurationMs("abc")).toBeUndefined();
    expect(parseRelativeDurationMs("0m")).toBeUndefined();
    expect(parseRelativeDurationMs("10d")).toBeUndefined();
  });

  it("parses relative timers to future one-shots", () => {
    const parsed = parseAlarmTimeExpression("15m", { nowMs: NOW_MS, timezone: TZ });
    expect(parsed.kind).toBe("once");
    expect(parsed.targetTimeMs).toBe(NOW_MS + 15 * 60_000);
    expect(parsed.timezone).toBe(TZ);
  });
});

describe("time-parser: time of day", () => {
  it("schedules later-today when the time is ahead", () => {
    const parsed = parseAlarmTimeExpression("18:30", { nowMs: NOW_MS, timezone: TZ });
    expect(parsed.kind).toBe("once");
    expect(parsed.targetTimeMs).toBe(zonedTimeToMs(TZ, 2026, 10, 1, 18, 30));
  });

  it("rolls to tomorrow when the time already passed", () => {
    const parsed = parseAlarmTimeExpression("09:00", { nowMs: NOW_MS, timezone: TZ });
    expect(parsed.kind).toBe("once");
    expect(parsed.targetTimeMs).toBe(zonedTimeToMs(TZ, 2026, 10, 2, 9, 0));
  });

  it("rejects out-of-range times", () => {
    expect(() => parseAlarmTimeExpression("25:00", { nowMs: NOW_MS, timezone: TZ })).toThrow();
  });
});

describe("time-parser: specific datetime", () => {
  it("parses YYYY-MM-DD HH:mm in the plugin timezone", () => {
    const parsed = parseAlarmTimeExpression("2026-10-02 10:00", {
      nowMs: NOW_MS,
      timezone: TZ,
    });
    expect(parsed.kind).toBe("once");
    expect(parsed.targetTimeMs).toBe(zonedTimeToMs(TZ, 2026, 10, 2, 10, 0));
  });

  it("rejects past datetimes", () => {
    expect(() =>
      parseAlarmTimeExpression("2026-09-30 10:00", { nowMs: NOW_MS, timezone: TZ }),
    ).toThrow(/past/);
  });
});

describe("time-parser: repeating intervals", () => {
  it("parses every 1h / every 30m", () => {
    const hourly = parseAlarmTimeExpression("every 1h", { nowMs: NOW_MS, timezone: TZ });
    expect(hourly.kind).toBe("interval");
    expect(hourly.intervalMs).toBe(3_600_000);
    expect(hourly.targetTimeMs).toBe(NOW_MS + 3_600_000);

    const halfHour = parseAlarmTimeExpression("every 30m", { nowMs: NOW_MS, timezone: TZ });
    expect(halfHour.kind).toBe("interval");
    expect(halfHour.intervalMs).toBe(30 * 60_000);
  });

  it("enforces the 60s minimum guard", () => {
    expect(() => parseAlarmTimeExpression("every 30s", { nowMs: NOW_MS, timezone: TZ })).toThrow(
      /minimum/,
    );
  });

  it("rejects unparsable every expressions", () => {
    expect(() =>
      parseAlarmTimeExpression("every someday", { nowMs: NOW_MS, timezone: TZ }),
    ).toThrow();
  });
});

describe("time-parser: daily and weekly", () => {
  it("parses daily 08:30 with a cron expression", () => {
    const parsed = parseAlarmTimeExpression("daily 08:30", { nowMs: NOW_MS, timezone: TZ });
    expect(parsed.kind).toBe("cron");
    expect(parsed.cronExpression).toBe("30 8 * * *");
    expect(parsed.targetTimeMs).toBe(zonedTimeToMs(TZ, 2026, 10, 2, 8, 30));
  });

  it("parses everyday 22:00 for later today", () => {
    const parsed = parseAlarmTimeExpression("everyday 22:00", { nowMs: NOW_MS, timezone: TZ });
    expect(parsed.kind).toBe("cron");
    expect(parsed.cronExpression).toBe("0 22 * * *");
    expect(parsed.targetTimeMs).toBe(zonedTimeToMs(TZ, 2026, 10, 1, 22, 0));
  });

  it("parses weekly mon 09:00 to the next Monday", () => {
    // 2026-10-01 is a Thursday; next Monday is 2026-10-05.
    const parsed = parseAlarmTimeExpression("weekly mon 09:00", { nowMs: NOW_MS, timezone: TZ });
    expect(parsed.kind).toBe("cron");
    expect(parsed.cronExpression).toBe("0 9 * * 1");
    expect(parsed.targetTimeMs).toBe(zonedTimeToMs(TZ, 2026, 10, 5, 9, 0));
  });

  it("rejects malformed daily/weekly forms", () => {
    expect(() =>
      parseAlarmTimeExpression("daily someday", { nowMs: NOW_MS, timezone: TZ }),
    ).toThrow();
    expect(() =>
      parseAlarmTimeExpression("weekly funday 09:00", { nowMs: NOW_MS, timezone: TZ }),
    ).toThrow();
  });
});

describe("time-parser: cron expressions", () => {
  it("accepts standard 5-field cron expressions", () => {
    const parsed = parseAlarmTimeExpression("0 9 * * 1-5", { nowMs: NOW_MS, timezone: TZ });
    expect(parsed.kind).toBe("cron");
    expect(parsed.cronExpression).toBe("0 9 * * 1-5");
    expect(parsed.targetTimeMs).toBeGreaterThan(NOW_MS);
  });

  it("computes future cron runs with nextCronRunMs", () => {
    const next = nextCronRunMs("0 9 * * *", TZ, NOW_MS);
    expect(next).toBeGreaterThan(NOW_MS);
  });

  it("rejects unknown expressions with an LLM-friendly error", () => {
    expect(() =>
      parseAlarmTimeExpression("someday eventually", { nowMs: NOW_MS, timezone: TZ }),
    ).toThrow(/Cannot parse/);
    expect(() => parseAlarmTimeExpression("", { nowMs: NOW_MS, timezone: TZ })).toThrow();
  });
});

describe("time-parser: timezone resolution", () => {
  it("prefers the explicit timezone, then config userTimezone", () => {
    expect(resolveAlarmTimezone("Europe/London")).toBe("Europe/London");
    expect(
      resolveAlarmTimezone(undefined, { agents: { defaults: { userTimezone: TZ } } } as never),
    ).toBe(TZ);
  });

  it("shifts wall-clock interpretation per timezone", () => {
    const jakarta = parseAlarmTimeExpression("2026-10-02 10:00", {
      nowMs: NOW_MS,
      timezone: "Asia/Jakarta",
    });
    const tokyo = parseAlarmTimeExpression("2026-10-02 10:00", {
      nowMs: NOW_MS,
      timezone: "Asia/Tokyo",
    });
    // Same wall clock in Tokyo (+9) is two hours earlier in UTC than Jakarta (+7).
    expect(jakarta.targetTimeMs! - tokyo.targetTimeMs!).toBe(7_200_000);
  });
});

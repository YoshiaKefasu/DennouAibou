/**
 * Dennou Alarm — lightweight natural time expression parser
 * (DENNOU_ALARM.md §2.3).
 *
 * Supported forms:
 * - relative timer: `"30s"`, `"5m"`, `"1h"`, `"2h30m"`
 * - time of day: `"18:30"`, `"09:00"` (tomorrow when already past)
 * - specific datetime: `"YYYY-MM-DD HH:mm"`
 * - repeating interval: `"every 1h"`, `"every 30m"` (60s minimum guard)
 * - daily: `"daily 08:30"`, `"everyday 22:00"`
 * - weekly: `"weekly mon 09:00"`
 * - cron expression (advanced): 5–6 fields
 *
 * Timezone resolution: explicit `timezone` option wins, otherwise the shared
 * `userTimezone` config value, otherwise the host system timezone.
 */

import { Cron } from "croner";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { AlarmTimeKind } from "./types.js";

export const DEFAULT_ALARM_TIMEZONE = "Asia/Jakarta";
export const MIN_INTERVAL_MS = 60_000;

export interface ParsedAlarmTime {
  kind: AlarmTimeKind;
  /** Next fire epoch ms for `once` / `interval` alarms. */
  targetTimeMs?: number;
  /** Period ms for `interval` alarms. */
  intervalMs?: number;
  /** Normalized cron expression for `cron` / weekly / daily alarms. */
  cronExpression?: string;
  timezone: string;
}

export interface ParseContext {
  nowMs?: number;
  timezone?: string;
  config?: OpenClawConfig;
}

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const WEEKDAY_NUMBERS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export function resolveAlarmTimezone(explicit?: string, config?: OpenClawConfig): string {
  const trimmedExplicit = explicit?.trim();
  if (trimmedExplicit) {
    return trimmedExplicit;
  }
  const configured = config?.agents?.defaults?.userTimezone?.trim();
  if (configured) {
    return configured;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_ALARM_TIMEZONE;
}

/** Parse a relative duration such as `"30s"`, `"5m"`, `"1h"`, `"2h30m"`. */
export function parseRelativeDurationMs(input: string): number | undefined {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!normalized || !/^\d+[smh](\d+[smh])*$/u.test(normalized)) {
    return undefined;
  }
  let total = 0;
  const pattern = /(\d+)([smh])/gu;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    matched = true;
    const value = Number.parseInt(match[1]!, 10);
    if (!Number.isFinite(value)) {
      return undefined;
    }
    if (match[2] === "s") {
      total += value * MS_PER_SECOND;
    } else if (match[2] === "m") {
      total += value * MS_PER_MINUTE;
    } else {
      total += value * MS_PER_HOUR;
    }
  }
  return matched && total > 0 ? total : undefined;
}

function getTimezoneOffsetMs(timezone: string, atMs: number): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(atMs));
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    lookup[part.type] = part.value;
  }
  const asUtcMs = Date.UTC(
    Number.parseInt(lookup.year ?? "1970", 10),
    Number.parseInt(lookup.month ?? "1", 10) - 1,
    Number.parseInt(lookup.day ?? "1", 10),
    Number.parseInt(lookup.hour ?? "0", 10),
    Number.parseInt(lookup.minute ?? "0", 10),
    Number.parseInt(lookup.second ?? "0", 10),
  );
  return asUtcMs - Math.floor(atMs / MS_PER_SECOND) * MS_PER_SECOND;
}

/** Convert a zoned wall-clock time to epoch ms. */
export function zonedTimeToMs(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let attempt = 0; attempt < 3; attempt++) {
    const offset = getTimezoneOffsetMs(timezone, guess);
    const next = Date.UTC(year, month - 1, day, hour, minute) - offset;
    if (next === guess) {
      return next;
    }
    guess = next;
  }
  return guess;
}

/** Read zoned wall-clock fields for an epoch ms. */
export function zonedFieldsFromMs(
  timezone: string,
  atMs: number,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(atMs));
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    lookup[part.type] = part.value;
  }
  const weekdayRaw = (lookup.weekday ?? "Sun").slice(0, 3).toLowerCase();
  return {
    year: Number.parseInt(lookup.year ?? "1970", 10),
    month: Number.parseInt(lookup.month ?? "1", 10),
    day: Number.parseInt(lookup.day ?? "1", 10),
    hour: Number.parseInt(lookup.hour ?? "0", 10),
    minute: Number.parseInt(lookup.minute ?? "0", 10),
    weekday: WEEKDAY_NUMBERS[weekdayRaw] ?? 0,
  };
}

/** Next occurrence of `hour:minute` in `timezone` after `nowMs`. */
export function nextDailyOccurrenceMs(
  timezone: string,
  hour: number,
  minute: number,
  nowMs: number,
): number {
  const fields = zonedFieldsFromMs(timezone, nowMs);
  let candidate = zonedTimeToMs(timezone, fields.year, fields.month, fields.day, hour, minute);
  if (candidate <= nowMs) {
    candidate = zonedTimeToMs(
      timezone,
      ...addDaysToDateParts(timezone, fields.year, fields.month, fields.day, 1),
      hour,
      minute,
    );
  }
  return candidate;
}

function addDaysToDateParts(
  _timezone: string,
  year: number,
  month: number,
  day: number,
  addDays: number,
): [number, number, number] {
  const base = Date.UTC(year, month - 1, day) + addDays * MS_PER_DAY;
  const date = new Date(base);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

/** Next occurrence of a weekday + time in `timezone` after `nowMs`. */
export function nextWeeklyOccurrenceMs(
  timezone: string,
  weekday: number,
  hour: number,
  minute: number,
  nowMs: number,
): number {
  for (let delta = 0; delta < 8; delta++) {
    const fields = zonedFieldsFromMs(timezone, nowMs + delta * MS_PER_DAY);
    if (fields.weekday !== weekday) {
      continue;
    }
    const candidate = zonedTimeToMs(timezone, fields.year, fields.month, fields.day, hour, minute);
    if (candidate > nowMs) {
      return candidate;
    }
  }
  // Fallback: same weekday next week from the zoned calendar date.
  const fields = zonedFieldsFromMs(timezone, nowMs);
  const parts = addDaysToDateParts(timezone, fields.year, fields.month, fields.day, 7);
  return zonedTimeToMs(timezone, parts[0], parts[1], parts[2], hour, minute);
}

function parseHourMinute(input: string): { hour: number; minute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!match) {
    return undefined;
  }
  const hour = Number.parseInt(match[1]!, 10);
  const minute = Number.parseInt(match[2]!, 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }
  return { hour, minute };
}

function parseWeekdayToken(input: string): number | undefined {
  const normalized = input.trim().slice(0, 3).toLowerCase();
  return WEEKDAY_NUMBERS[normalized];
}

function isCronExpression(input: string): boolean {
  const fields = input.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    return false;
  }
  try {
    // Validation only; evaluation happens through stored expressions.
    new Cron(input.trim(), { timezone: "UTC", paused: true });
    return true;
  } catch {
    return false;
  }
}

export function nextCronRunMs(expression: string, timezone: string, nowMs: number): number {
  const cron = new Cron(expression.trim(), { timezone, catch: false });
  const next = cron.nextRun(new Date(nowMs));
  if (!next) {
    throw new Error(`Cannot compute next run for cron expression: '${expression}'`);
  }
  const nextMs = next.getTime();
  if (!Number.isFinite(nextMs) || nextMs <= nowMs) {
    throw new Error(`Cron expression produced no future run: '${expression}'`);
  }
  return nextMs;
}

function parseDailyExpression(
  text: string,
  timezone: string,
  nowMs: number,
): ParsedAlarmTime | undefined {
  const match = /^(?:daily|everyday)\s+(\d{1,2}:\d{2})$/iu.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const hm = parseHourMinute(match[1]!);
  if (!hm) {
    return undefined;
  }
  const cronExpression = `${hm.minute} ${hm.hour} * * *`;
  return {
    kind: "cron",
    targetTimeMs: nextCronRunMs(cronExpression, timezone, nowMs),
    cronExpression,
    timezone,
  };
}

function parseWeeklyExpression(
  text: string,
  timezone: string,
  nowMs: number,
): ParsedAlarmTime | undefined {
  const match = /^weekly\s+([a-z]+)\s+(\d{1,2}:\d{2})$/iu.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const weekday = parseWeekdayToken(match[1]!);
  const hm = parseHourMinute(match[2]!);
  if (weekday === undefined || !hm) {
    return undefined;
  }
  const cronExpression = `${hm.minute} ${hm.hour} * * ${weekday}`;
  return {
    kind: "cron",
    targetTimeMs: nextWeeklyOccurrenceMs(timezone, weekday, hm.hour, hm.minute, nowMs),
    cronExpression,
    timezone,
  };
}

function parseEveryIntervalExpression(
  text: string,
  _timezone: string,
  nowMs: number,
): ParsedAlarmTime | undefined {
  const match = /^every\s+(.+)$/iu.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const durationMs = parseRelativeDurationMs(match[1]!);
  if (durationMs === undefined) {
    return undefined;
  }
  if (durationMs < MIN_INTERVAL_MS) {
    throw new Error(`Interval '${text.trim()}' is below the minimum of 60 seconds.`);
  }
  return {
    kind: "interval",
    targetTimeMs: nowMs + durationMs,
    intervalMs: durationMs,
    timezone: _timezone,
  };
}

function parseSpecificDatetimeExpression(
  text: string,
  timezone: string,
  _nowMs: number,
): ParsedAlarmTime | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  const hour = Number.parseInt(match[4]!, 10);
  const minute = Number.parseInt(match[5]!, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return undefined;
  }
  return {
    kind: "once",
    targetTimeMs: zonedTimeToMs(timezone, year, month, day, hour, minute),
    timezone,
  };
}

/**
 * Parse a user-facing time expression into a concrete schedule.
 * Throws with an LLM-friendly message when the expression is unusable.
 */
export function parseAlarmTimeExpression(input: string, ctx: ParseContext = {}): ParsedAlarmTime {
  const text = input.trim();
  if (!text) {
    throw new Error("Empty time expression. Examples: '15m', '18:30', 'daily 09:00'.");
  }
  const nowMs = ctx.nowMs ?? Date.now();
  const timezone = resolveAlarmTimezone(ctx.timezone, ctx.config);

  // Repeating interval first so "every ..." never falls through to cron.
  const interval = parseEveryIntervalExpression(text, timezone, nowMs);
  if (interval) {
    return interval;
  }
  if (/^every\s+/iu.test(text)) {
    throw new Error(
      `Cannot parse interval '${text}'. Examples: 'every 30m', 'every 1h' (minimum 60s).`,
    );
  }

  const daily = parseDailyExpression(text, timezone, nowMs);
  if (daily) {
    return daily;
  }
  if (/^(?:daily|everyday)\s+/iu.test(text)) {
    throw new Error(`Cannot parse daily time '${text}'. Example: 'daily 08:30'.`);
  }

  const weekly = parseWeeklyExpression(text, timezone, nowMs);
  if (weekly) {
    return weekly;
  }
  if (/^weekly\s+/iu.test(text)) {
    throw new Error(`Cannot parse weekly time '${text}'. Example: 'weekly mon 09:00'.`);
  }

  const specific = parseSpecificDatetimeExpression(text, timezone, nowMs);
  if (specific) {
    if (specific.targetTimeMs !== undefined && specific.targetTimeMs <= nowMs) {
      throw new Error(`Specified datetime '${text}' is in the past.`);
    }
    return specific;
  }

  const hm = parseHourMinute(text);
  if (hm) {
    return {
      kind: "once",
      targetTimeMs: nextDailyOccurrenceMs(timezone, hm.hour, hm.minute, nowMs),
      timezone,
    };
  }

  const relativeMs = parseRelativeDurationMs(text);
  if (relativeMs !== undefined) {
    return { kind: "once", targetTimeMs: nowMs + relativeMs, timezone };
  }

  if (isCronExpression(text)) {
    return {
      kind: "cron",
      targetTimeMs: nextCronRunMs(text, timezone, nowMs),
      cronExpression: text,
      timezone,
    };
  }

  throw new Error(
    `Cannot parse time expression '${text}'. Supported: '30s'/'5m'/'1h', '18:30', ` +
      `'YYYY-MM-DD HH:mm', 'every 30m', 'daily 08:30', 'weekly mon 09:00', or a cron expression.`,
  );
}

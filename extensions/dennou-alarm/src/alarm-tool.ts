/**
 * Dennou Alarm — `alarm` agent tool (DENNOU_ALARM.md §2.1, §2.2, §2.4).
 *
 * - `action: "set"` requires `time` + `task`
 * - `action: "cancel"` requires `id`
 * - `action: "list"` returns the formatted alarm list
 *
 * TypeBox enum rule: flat `stringEnum`, never `Type.Union(Type.Literal(...))`.
 */

import { Type } from "typebox";
import { stringEnum } from "../../../src/agents/schema/typebox.js";
import {
  readStringParam,
  textResult,
  type AnyAgentTool,
} from "../../../src/agents/tools/common.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  computeRepeatingNextFireMs,
  getSharedAlarmStore,
  nextFireDueMs,
  AlarmStore,
  resolveAlarmStorePath,
} from "./storage.js";
import {
  DEFAULT_ALARM_TIMEZONE,
  parseAlarmTimeExpression,
  resolveAlarmTimezone,
  zonedFieldsFromMs,
} from "./time-parser.js";
import type { AlarmAction, StoredAlarm } from "./types.js";

export const ALARM_ACTIONS = ["set", "list", "cancel"] as const;

export const AlarmToolSchema = Type.Object({
  action: stringEnum(ALARM_ACTIONS, {
    description: "操作種別: set=アラームをセット, list=一覧表示, cancel=キャンセル",
  }),
  id: Type.Optional(
    Type.String({
      description: "キャンセルするアラームのID（例: 'alarm_1'）。action='cancel' で必須。",
    }),
  ),
  time: Type.Optional(
    Type.String({
      description:
        "時間指定。相対時間（例: '30s', '5m', '1h', '2h30m'）または時刻指定（例: '18:30', '09:00'）。action='set' で必須。",
    }),
  ),
  task: Type.Optional(
    Type.String({
      description:
        "アラーム発火時にエージェントが実行するタスク内容・メッセージ。action='set' で必須。",
    }),
  ),
});

export interface AlarmToolOptions {
  config?: OpenClawConfig;
  store?: AlarmStore;
  storePath?: string;
  now?: () => number;
}

function readAlarmAction(params: Record<string, unknown>): AlarmAction {
  const raw = readStringParam(params, "action");
  if (raw === "set" || raw === "list" || raw === "cancel") {
    return raw;
  }
  throw new Error(`Unknown action '${raw ?? ""}'. Supported actions: ${ALARM_ACTIONS.join(", ")}.`);
}

function buildLabel(task: string, timeExpression: string): string {
  const trimmed = task.trim();
  if (trimmed.length <= 40) {
    return trimmed;
  }
  return `${trimmed.slice(0, 37)}... (${timeExpression.trim()})`;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) {
    return "まもなく";
  }
  if (ms < 60_000) {
    return `あと ${Math.max(1, Math.round(ms / 1_000))}秒`;
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return `あと ${minutes}分`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) {
    return rest === 0 ? `あと ${hours}時間` : `あと ${hours}時間${rest}分`;
  }
  const days = Math.floor(hours / 24);
  const dayRest = hours % 24;
  return dayRest === 0 ? `あと ${days}日` : `あと ${days}日${dayRest}時間`;
}

/** Relative day label in the alarm timezone (DENNOU_ALARM.md §2.4). */
function formatRelativeDayTime(targetMs: number, nowMs: number, timezone: string): string {
  const target = zonedFieldsFromMs(timezone, targetMs);
  const base = zonedFieldsFromMs(timezone, nowMs);
  const diffDays = Math.round(
    (Date.UTC(target.year, target.month, target.day) - Date.UTC(base.year, base.month, base.day)) /
      86_400_000,
  );
  const hm = `${String(target.hour).padStart(2, "0")}:${String(target.minute).padStart(2, "0")}`;
  if (diffDays <= 0) {
    return hm;
  }
  if (diffDays === 1) {
    return `明日 ${hm}`;
  }
  if (diffDays === 2) {
    return `明後日 ${hm}`;
  }
  return `${target.month}/${target.day} ${hm}`;
}

function formatNextFire(alarm: StoredAlarm, nowMs: number): string {
  const next = nextFireDueMs(alarm, nowMs) ?? computeRepeatingNextFireMs(alarm, nowMs);
  if (next === undefined) {
    return "時刻未定";
  }
  const timezone = alarm.timezone?.trim() || DEFAULT_ALARM_TIMEZONE;
  const remaining = formatRemaining(next - nowMs);
  if (alarm.kind === "once") {
    const relative = formatRelativeDayTime(next, nowMs, timezone);
    // Same-day one-shots read as `18:30 (あと 45分)` via the caller.
    if (/^\d{2}:\d{2}$/.test(relative)) {
      return remaining;
    }
    return `${relative}、${remaining}`;
  }
  // Repeating alarms follow §2.4: `次回: 明日 09:00`.
  return `次回: ${formatRelativeDayTime(next, nowMs, timezone)}`;
}

export function formatAlarmLine(alarm: StoredAlarm, nowMs: number): string {
  return `- [${alarm.id}] ${alarm.timeExpression} (${formatNextFire(alarm, nowMs)}): ${alarm.task}`;
}

export function formatAlarmList(alarms: StoredAlarm[], nowMs: number): string {
  const enabled = alarms.filter((alarm) => alarm.enabled);
  if (enabled.length === 0) {
    return "現在セットされているアラームはありません。";
  }
  const lines = enabled.map((alarm) => formatAlarmLine(alarm, nowMs));
  return `【現在セットされている電脳アラーム (${enabled.length}件)】\n${lines.join("\n")}`;
}

export function createAlarmTool(options: AlarmToolOptions = {}): AnyAgentTool {
  const now = options.now ?? Date.now;
  const getStore = () =>
    options.store ?? getSharedAlarmStore(options.storePath ?? resolveAlarmStorePath());

  return {
    label: "Alarm",
    name: "alarm",
    description:
      "自律的体内時計・タイマー＆スケジュール管理。set=アラームをセット、list=一覧表示、cancel=キャンセル。",
    parameters: AlarmToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const action = readAlarmAction(params);
      const store = getStore();

      if (action === "list") {
        return textResult(formatAlarmList(store.list(), now()), undefined);
      }

      if (action === "cancel") {
        const id = readStringParam(params, "id");
        if (!id) {
          throw new Error("action='cancel' requires 'id'");
        }
        const removed = store.remove(id);
        if (!removed) {
          throw new Error(`Alarm '${id}' not found.`);
        }
        return textResult(`アラーム [${id}] をキャンセルしました。`, undefined);
      }

      // action === "set"
      const time = readStringParam(params, "time");
      const task = readStringParam(params, "task");
      if (!time || !task) {
        throw new Error("action='set' requires both 'time' and 'task'");
      }
      const timezone = resolveAlarmTimezone(undefined, options.config);
      let parsed: ReturnType<typeof parseAlarmTimeExpression>;
      try {
        parsed = parseAlarmTimeExpression(time, { nowMs: now(), timezone, config: options.config });
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      const alarm: StoredAlarm = {
        id: store.allocateId(),
        label: buildLabel(task, time),
        task: task.trim(),
        timeExpression: time.trim(),
        kind: parsed.kind,
        targetTimeMs: parsed.targetTimeMs,
        intervalMs: parsed.intervalMs,
        cronExpression: parsed.cronExpression,
        timezone: parsed.timezone,
        createdAtMs: now(),
        enabled: true,
      };
      store.upsert(alarm);
      return textResult(
        `アラーム [${alarm.id}] をセットしました: ${alarm.timeExpression} (${formatNextFire(alarm, now())}): ${alarm.task}`,
        undefined,
      );
    },
  };
}

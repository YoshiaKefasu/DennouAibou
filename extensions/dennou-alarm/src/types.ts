/**
 * Dennou Alarm — internal data model (DENNOU_ALARM.md §4.1).
 *
 * Phase 1 covers the alarm tool + persistence + lightweight scheduler.
 * Delivery (event-pump injection, `role: "system"`, `heartbeat: last`)
 * arrives in Phase 2, so firing is exposed as a callback hook.
 */

export type AlarmTimeKind = "once" | "interval" | "cron";

export type AlarmAction = "set" | "list" | "cancel";

export interface StoredAlarm {
  /** Unique id (`alarm_1`, `alarm_2`, ...). */
  id: string;
  /** Short human-readable label derived from the task or time expression. */
  label: string;
  /** Task Kasou executes when the alarm fires. */
  task: string;
  /** Original user/Kasou-provided expression (`"15m"`, `"daily 09:00"`). */
  timeExpression: string;
  kind: AlarmTimeKind;
  /** Next fire epoch ms (one-shot alarms). */
  targetTimeMs?: number;
  /** Period ms for interval alarms (minimum 60_000ms). */
  intervalMs?: number;
  /** Cron expression for cron alarms. */
  cronExpression?: string;
  /** IANA timezone (default: `Asia/Jakarta`). */
  timezone?: string;
  createdAtMs: number;
  lastFiredAtMs?: number;
  enabled: boolean;
}

export interface AlarmStoreFile {
  version: 1;
  nextId: number;
  alarms: StoredAlarm[];
}

/** Catch-up decision taken at startup for one stored alarm. */
export type CatchUpDecision =
  | { action: "fire-now"; delayed: boolean }
  | { action: "skip" }
  | { action: "leave" }
  | { action: "reschedule"; nextFireMs: number };

export interface FireEvent {
  alarm: StoredAlarm;
  firedAtMs: number;
  /** True when the fire is late (catch-up with delay metadata). */
  delayed: boolean;
}

export type FireHandler = (event: FireEvent) => void | Promise<void>;

/**
 * Dennou Alarm — JSON file persistence + restart catch-up policy
 * (DENNOU_ALARM.md §4.1, §4.2).
 *
 * Storage file: `<stateDir>/agents/main/dennou-alarm.json`
 * (design: `~/.openclaw/agents/main/dennou-alarm.json`).
 *
 * Catch-up policy (evaluated at load time):
 * - overdue ≤ 5min → fire immediately at startup
 * - 5min – 1h overdue → fire once with a delay flag
 * - overdue > 1h → one-shot alarms are skipped; repeating alarms are
 *   recomputed to their next future fire time (no burst execution)
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../../src/plugin-sdk/state-paths.js";
import { DEFAULT_ALARM_TIMEZONE, nextCronRunMs } from "./time-parser.js";
import type { AlarmStoreFile, CatchUpDecision, StoredAlarm } from "./types.js";

export const ALARM_STORE_FILENAME = "dennou-alarm.json";
const STORE_VERSION = 1;

/** Overdue ≤ 5min fires immediately. */
export const CATCH_UP_PROMPT_MS = 5 * 60_000;
/** Overdue 5min–1h fires once with a delay flag. */
export const CATCH_UP_DELAYED_MS = 60 * 60_000;

export function resolveAlarmStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env);
  return path.join(stateDir, "agents", "main", ALARM_STORE_FILENAME);
}

function emptyStore(): AlarmStoreFile {
  return { version: STORE_VERSION, nextId: 1, alarms: [] };
}

function normalizeAlarm(raw: unknown): StoredAlarm | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) {
    return undefined;
  }
  if (typeof record.task !== "string" || !record.task.trim()) {
    return undefined;
  }
  const kind = record.kind === "interval" || record.kind === "cron" ? record.kind : "once";
  const alarm: StoredAlarm = {
    id: record.id.trim(),
    label:
      typeof record.label === "string" && record.label.trim()
        ? record.label.trim()
        : record.id.trim(),
    task: record.task.trim(),
    timeExpression:
      typeof record.timeExpression === "string" && record.timeExpression.trim()
        ? record.timeExpression.trim()
        : "",
    kind,
    timezone: typeof record.timezone === "string" ? record.timezone : undefined,
    createdAtMs:
      typeof record.createdAtMs === "number" && Number.isFinite(record.createdAtMs)
        ? record.createdAtMs
        : Date.now(),
    lastFiredAtMs:
      typeof record.lastFiredAtMs === "number" && Number.isFinite(record.lastFiredAtMs)
        ? record.lastFiredAtMs
        : undefined,
    enabled: record.enabled !== false,
  };
  if (typeof record.targetTimeMs === "number" && Number.isFinite(record.targetTimeMs)) {
    alarm.targetTimeMs = record.targetTimeMs;
  }
  if (typeof record.intervalMs === "number" && Number.isFinite(record.intervalMs)) {
    alarm.intervalMs = record.intervalMs;
  }
  if (typeof record.cronExpression === "string" && record.cronExpression.trim()) {
    alarm.cronExpression = record.cronExpression.trim();
  }
  return alarm;
}

/** Next future fire time for a repeating alarm after `nowMs`. */
export function computeRepeatingNextFireMs(alarm: StoredAlarm, nowMs: number): number | undefined {
  const timezone = alarm.timezone?.trim() || DEFAULT_ALARM_TIMEZONE;
  if (alarm.kind === "interval") {
    const intervalMs = alarm.intervalMs;
    if (!intervalMs || !Number.isFinite(intervalMs) || intervalMs <= 0) {
      return undefined;
    }
    const anchor = alarm.lastFiredAtMs ?? alarm.createdAtMs;
    if (nowMs < anchor) {
      return anchor;
    }
    const elapsed = nowMs - anchor;
    const steps = Math.max(1, Math.floor((elapsed + intervalMs - 1) / intervalMs));
    return anchor + steps * intervalMs;
  }
  if (alarm.kind === "cron" && alarm.cronExpression) {
    try {
      return nextCronRunMs(alarm.cronExpression, timezone, nowMs);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Decide what to do with one stored alarm at startup.
 * Repeating alarms past their fire time are recomputed to the next future slot.
 */
export function decideCatchUp(alarm: StoredAlarm, nowMs: number): CatchUpDecision {
  if (!alarm.enabled) {
    // Disabled alarms stay stored untouched: never fire, reschedule, or drop them.
    return { action: "leave" };
  }
  const nextFire = nextFireDueMs(alarm, nowMs);
  if (nextFire === undefined) {
    // One-shot without a future target: evaluate raw overdue when possible.
    if (alarm.kind === "once" && typeof alarm.targetTimeMs === "number") {
      const overdue = nowMs - alarm.targetTimeMs;
      if (overdue <= 0) {
        return { action: "fire-now", delayed: false };
      }
      if (overdue <= CATCH_UP_PROMPT_MS) {
        return { action: "fire-now", delayed: false };
      }
      if (overdue <= CATCH_UP_DELAYED_MS) {
        return { action: "fire-now", delayed: true };
      }
    }
    return { action: "skip" };
  }
  if (nextFire > nowMs) {
    return { action: "reschedule", nextFireMs: nextFire };
  }
  const overdue = nowMs - nextFire;
  if (overdue <= CATCH_UP_PROMPT_MS) {
    return { action: "fire-now", delayed: false };
  }
  if (overdue <= CATCH_UP_DELAYED_MS) {
    return { action: "fire-now", delayed: true };
  }
  if (alarm.kind === "once") {
    return { action: "skip" };
  }
  const recomputed = computeRepeatingNextFireMs(alarm, nowMs);
  if (recomputed !== undefined && recomputed > nowMs) {
    return { action: "reschedule", nextFireMs: recomputed };
  }
  return { action: "skip" };
}

/** Fire time the scheduler should watch (`targetTimeMs` or recomputed). */
export function nextFireDueMs(alarm: StoredAlarm, nowMs: number): number | undefined {
  if (!alarm.enabled) {
    return undefined;
  }
  if (alarm.kind === "once") {
    return alarm.targetTimeMs;
  }
  if (alarm.kind === "interval") {
    if (typeof alarm.targetTimeMs === "number") {
      if (alarm.targetTimeMs > nowMs) {
        return alarm.targetTimeMs;
      }
      // Slightly overdue stored slots stay visible so decideCatchUp can
      // evaluate the delay window instead of jumping straight to a future
      // slot. Only far-overdue slots (> CATCH_UP_DELAYED_MS) recompute.
      if (nowMs - alarm.targetTimeMs < CATCH_UP_DELAYED_MS) {
        return alarm.targetTimeMs;
      }
    }
    return computeRepeatingNextFireMs(alarm, nowMs);
  }
  if (alarm.kind === "cron") {
    if (typeof alarm.targetTimeMs === "number") {
      if (alarm.targetTimeMs > nowMs) {
        return alarm.targetTimeMs;
      }
      if (nowMs - alarm.targetTimeMs < CATCH_UP_DELAYED_MS) {
        return alarm.targetTimeMs;
      }
    }
    if (alarm.cronExpression) {
      return computeRepeatingNextFireMs(alarm, nowMs);
    }
  }
  return undefined;
}

const sharedAlarmStores = new Map<string, AlarmStore>();

/**
 * Path-keyed shared store: tool and scheduler in the same process must
 * observe the same in-memory/file state instead of split instances.
 */
export function getSharedAlarmStore(storePath?: string): AlarmStore {
  const key = storePath ?? resolveAlarmStorePath();
  const cached = sharedAlarmStores.get(key);
  if (cached) {
    return cached;
  }
  const store = new AlarmStore(key);
  sharedAlarmStores.set(key, store);
  return store;
}

/** Minimal logger surface for catch-up reporting. */
export type CatchUpLogger = {
  info?: (message: string) => void;
};

/** Result summary of {@link applyCatchUpToStore}. */
export interface CatchUpSummary {
  rescheduled: number;
  removed: number;
  left: number;
}

/** Test-only: clears the path-keyed shared store cache between test cases. */
export function resetSharedAlarmStoresForTests(): void {
  sharedAlarmStores.clear();
}

/**
 * Apply restart catch-up (§4.2) to every stored alarm.
 * Pure entry point (no plugin `api` dependency) so tests drive it directly:
 * - `reschedule` (repeating only) → rewrite `targetTimeMs` to the next future slot
 * - `skip` for an enabled one-shot → drop the long-overdue alarm
 * - `leave` (disabled) / `fire-now` / future `reschedule` for one-shots → untouched
 */
export function applyCatchUpToStore(
  store: AlarmStore,
  nowMs: number = Date.now(),
  logger?: CatchUpLogger,
): CatchUpSummary {
  const summary: CatchUpSummary = { rescheduled: 0, removed: 0, left: 0 };
  for (const alarm of store.list()) {
    const decision = decideCatchUp(alarm, nowMs);
    if (decision.action === "reschedule" && alarm.kind !== "once") {
      store.update(alarm.id, { targetTimeMs: decision.nextFireMs });
      summary.rescheduled += 1;
    } else if (decision.action === "skip" && alarm.kind === "once" && alarm.enabled) {
      store.remove(alarm.id);
      summary.removed += 1;
      logger?.info?.(`dennou-alarm: dropped long-overdue one-shot ${alarm.id}.`);
    } else {
      summary.left += 1;
    }
  }
  return summary;
}

export class AlarmStore {
  private filePath: string;
  private state: AlarmStoreFile;

  constructor(filePath?: string) {
    this.filePath = filePath ?? resolveAlarmStorePath();
    this.state = this.loadFromDisk();
  }

  get path(): string {
    return this.filePath;
  }

  list(): StoredAlarm[] {
    return this.state.alarms.map((alarm) => ({ ...alarm }));
  }

  get(id: string): StoredAlarm | undefined {
    const found = this.state.alarms.find((alarm) => alarm.id === id.trim());
    return found ? { ...found } : undefined;
  }

  allocateId(): string {
    const id = `alarm_${this.state.nextId}`;
    this.state.nextId += 1;
    return id;
  }

  upsert(alarm: StoredAlarm): StoredAlarm {
    const index = this.state.alarms.findIndex((entry) => entry.id === alarm.id);
    if (index >= 0) {
      this.state.alarms[index] = { ...alarm };
    } else {
      this.state.alarms.push({ ...alarm });
    }
    // Keep nextId ahead of any manually restored numeric suffix.
    const numeric = Number.parseInt(alarm.id.replace(/^alarm_/, ""), 10);
    if (Number.isFinite(numeric) && numeric >= this.state.nextId) {
      this.state.nextId = numeric + 1;
    }
    this.flush();
    return { ...alarm };
  }

  remove(id: string): boolean {
    const before = this.state.alarms.length;
    this.state.alarms = this.state.alarms.filter((alarm) => alarm.id !== id.trim());
    const removed = this.state.alarms.length < before;
    if (removed) {
      this.flush();
    }
    return removed;
  }

  update(id: string, patch: Partial<StoredAlarm>): StoredAlarm | undefined {
    const index = this.state.alarms.findIndex((alarm) => alarm.id === id.trim());
    if (index < 0) {
      return undefined;
    }
    const merged = { ...this.state.alarms[index]!, ...patch, id: id.trim() };
    this.state.alarms[index] = merged;
    this.flush();
    return { ...merged };
  }

  private loadFromDisk(): AlarmStoreFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch {
      return emptyStore();
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return emptyStore();
      }
      const record = parsed as Record<string, unknown>;
      const alarms = Array.isArray(record.alarms)
        ? record.alarms
            .map((entry) => normalizeAlarm(entry))
            .filter((entry): entry is StoredAlarm => entry !== undefined)
        : [];
      const nextId =
        typeof record.nextId === "number" && Number.isFinite(record.nextId) && record.nextId > 0
          ? Math.floor(record.nextId)
          : alarms.length + 1;
      return { version: STORE_VERSION, nextId, alarms };
    } catch {
      return emptyStore();
    }
  }

  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    } catch {
      // Best-effort: the write below surfaces real failures.
    }
    const payload = JSON.stringify(this.state, null, 2);
    const tmpPath = `${this.filePath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, payload, { encoding: "utf-8", mode: 0o600 });
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch {
        // Best-effort: umask or platform may already restrict permissions.
      }
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // Atomic write unavailable (cross-device, permissions): direct fallback.
      try {
        fs.writeFileSync(this.filePath, payload, { encoding: "utf-8", mode: 0o600 });
      } catch {
        // Persistence is best-effort at runtime; callers keep in-memory state.
      }
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }
  }
}

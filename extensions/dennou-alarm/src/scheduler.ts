/**
 * Dennou Alarm — lightweight polling scheduler (Phase 1).
 *
 * A short-interval loop checks stored alarms for due fire times and invokes
 * the fire handler. Phase 2 wires the handler to the event-pump
 * (`role: "system"` + `heartbeat: { target: "last" }`); until then the handler
 * is injectable so tests and the tool layer observe fires directly.
 *
 * Fire ordering guarantee (§4.3): persistence (`lastFiredAtMs` update /
 * one-shot removal) happens after the fire handler resolves, so a crash
 * mid-fire never loses the alarm silently.
 */

import {
  CATCH_UP_PROMPT_MS,
  computeRepeatingNextFireMs,
  nextFireDueMs,
  type AlarmStore,
} from "./storage.js";
import type { FireHandler, StoredAlarm } from "./types.js";

export interface SchedulerOptions {
  store: AlarmStore;
  onFire: FireHandler;
  /** Poll interval ms (default 1000). */
  checkIntervalMs?: number;
  /** Clock source (tests inject a fake clock). */
  now?: () => number;
  /**
   * Timer injection (tests avoid real timers).
   * Handles are opaque: created by `setIntervalImpl`, consumed by `clearIntervalImpl`.
   */
  setIntervalImpl?: (callback: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}

const DEFAULT_CHECK_INTERVAL_MS = 1_000;

export class AlarmScheduler {
  private readonly store: AlarmStore;
  private readonly onFire: FireHandler;
  private readonly checkIntervalMs: number;
  private readonly now: () => number;
  private readonly setIntervalImpl: (callback: () => void, ms: number) => unknown;
  private readonly clearIntervalImpl: (handle: unknown) => void;
  private readonly onError: (error: unknown) => void;
  private timer: unknown = undefined;
  private running = false;
  private checking = false;

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.onFire = options.onFire;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.setIntervalImpl = options.setIntervalImpl ?? ((callback, ms) => setInterval(callback, ms));
    // The default pairing always receives a real `setInterval` handle.
    this.clearIntervalImpl =
      options.clearIntervalImpl ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
    this.onError = options.onError ?? (() => {});
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const timer = this.setIntervalImpl(() => {
      void this.checkOnce();
    }, this.checkIntervalMs);
    // Never let the scheduler hold the gateway process open.
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.timer = timer;
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      try {
        this.clearIntervalImpl(this.timer);
      } catch {
        // Ignore teardown failures.
      }
      this.timer = undefined;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Single poll pass — public so tests drive it deterministically. */
  async checkOnce(nowMs?: number): Promise<StoredAlarm[]> {
    if (this.checking) {
      return [];
    }
    this.checking = true;
    try {
      const now = nowMs ?? this.now();
      const fired: StoredAlarm[] = [];
      for (const alarm of this.store.list()) {
        const due = nextFireDueMs(alarm, now);
        if (due === undefined || due > now) {
          continue;
        }
        try {
          await this.onFire({ alarm, firedAtMs: now, delayed: now - due > CATCH_UP_PROMPT_MS });
        } catch (error) {
          // One failing handler must not block the remaining alarms.
          this.onError(error);
          continue;
        }
        // Persist only after the handler resolved (§4.3).
        if (alarm.kind === "once") {
          this.store.remove(alarm.id);
        } else {
          const next = computeNextAfterFire(alarm, now);
          if (next === undefined) {
            this.store.update(alarm.id, { lastFiredAtMs: now });
          } else {
            this.store.update(alarm.id, { lastFiredAtMs: now, targetTimeMs: next });
          }
        }
        fired.push(alarm);
      }
      return fired;
    } finally {
      this.checking = false;
    }
  }
}

function computeNextAfterFire(alarm: StoredAlarm, nowMs: number): number | undefined {
  if (alarm.kind === "interval" && alarm.intervalMs) {
    // Anchor on "now" so drift never accumulates behind a slow handler.
    return nowMs + alarm.intervalMs;
  }
  if (alarm.kind === "cron") {
    const probe: StoredAlarm = { ...alarm, lastFiredAtMs: nowMs, targetTimeMs: undefined };
    return computeRepeatingNextFireMs(probe, nowMs);
  }
  return undefined;
}

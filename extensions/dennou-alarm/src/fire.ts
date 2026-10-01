/**
 * Dennou Alarm — Phase 2 fire handler (DENNOU_ALARM.md §3).
 *
 * On fire:
 * 1. Injects a `role: "system"` notification via `enqueueSystemEvent`
 *    into the master session (`agent:main:main`).
 * 2. Runs the event pump once with `heartbeat: { target: "last" }` so the
 *    reply is delivered to the most recently active channel
 *    (Telegram / Discord, ...).
 *
 * Dependencies are injectable so tests observe fires without a gateway.
 */

import type { OpenClawConfig } from "../../../src/config/config.js";
import { resolveMainSessionKey } from "../../../src/config/sessions/main-session.js";
import { requestWakeNow, runEventPumpOnce } from "../../../src/infra/event-pump.js";
import { enqueueSystemEvent } from "../../../src/infra/system-events.js";
import type { FireEvent } from "./types.js";

export type AlarmFireDeps = {
  enqueueSystemEvent?: typeof enqueueSystemEvent;
  runEventPumpOnce?: typeof runEventPumpOnce;
  /** Resolve the master session key (defaults to the scope-aware main session key). */
  resolveSessionKey?: (cfg?: OpenClawConfig) => string;
  /** Fallback wake request used when the pump skips the run. */
  requestWakeNow?: typeof requestWakeNow;
  now?: () => number;
};

export function formatAlarmFireText(alarm: FireEvent["alarm"]): string {
  return `【電脳アラーム発火 (ID: ${alarm.id})】タスク: ${alarm.task}`;
}

export function createAlarmFireHandler(deps: AlarmFireDeps = {}) {
  const enqueue = deps.enqueueSystemEvent ?? enqueueSystemEvent;
  const pump = deps.runEventPumpOnce ?? runEventPumpOnce;
  const wake = deps.requestWakeNow ?? requestWakeNow;
  const resolveKey = deps.resolveSessionKey ?? ((cfg) => resolveMainSessionKey(cfg));
  return async (event: FireEvent, cfg?: OpenClawConfig): Promise<void> => {
    const sessionKey = resolveKey(cfg);
    enqueue(formatAlarmFireText(event.alarm), {
      sessionKey,
      contextKey: `alarm:${event.alarm.id}`,
    });
    const result = await pump({
      cfg,
      sessionKey,
      reason: `alarm:${event.alarm.id}`,
      heartbeat: { target: "last" },
    });
    // Pump skipped the run (e.g. no wake handler yet) — queue a wake so the
    // injected alarm event is not left waiting until the next heartbeat.
    if (result.status === "skipped") {
      wake({ reason: `alarm:${event.alarm.id}` });
    }
  };
}

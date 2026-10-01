/**
 * Dennou Alarm — plugin entry (Phase 1).
 *
 * Registers the `alarm` agent tool and the background scheduler service.
 * Phase 1 firing is callback-driven: the scheduler persists state after the
 * fire handler resolves. Phase 2 wires the handler to the event-pump
 * (`role: "system"` injection + `heartbeat: { target: "last" }` delivery).
 */

import { definePluginEntry } from "../../src/plugin-sdk/plugin-entry.js";
import {
  ALARM_ACTIONS,
  AlarmToolSchema,
  createAlarmTool,
  formatAlarmLine,
  formatAlarmList,
} from "./src/alarm-tool.js";
import { AlarmScheduler } from "./src/scheduler.js";
import {
  AlarmStore,
  applyCatchUpToStore,
  decideCatchUp,
  getSharedAlarmStore,
  nextFireDueMs,
  resolveAlarmStorePath,
} from "./src/storage.js";
import {
  DEFAULT_ALARM_TIMEZONE,
  MIN_INTERVAL_MS,
  nextCronRunMs,
  parseAlarmTimeExpression,
  parseRelativeDurationMs,
  resolveAlarmTimezone,
} from "./src/time-parser.js";
import type { FireEvent, StoredAlarm } from "./src/types.js";

export {
  ALARM_ACTIONS,
  AlarmToolSchema,
  createAlarmTool,
  formatAlarmLine,
  formatAlarmList,
  AlarmScheduler,
  AlarmStore,
  applyCatchUpToStore,
  decideCatchUp,
  getSharedAlarmStore,
  nextFireDueMs,
  resolveAlarmStorePath,
  DEFAULT_ALARM_TIMEZONE,
  MIN_INTERVAL_MS,
  nextCronRunMs,
  parseAlarmTimeExpression,
  parseRelativeDurationMs,
  resolveAlarmTimezone,
};

export type { FireEvent, StoredAlarm };

export default definePluginEntry({
  id: "dennou-alarm",
  name: "電脳アラーム (Dennou Alarm)",
  description: "自律的体内時計・タイマー ＆ スケジュール管理プラグイン",
  register(api) {
    api.registerTool(
      (ctx) =>
        createAlarmTool({
          config: ctx.config,
          storePath: resolveAlarmStorePath(),
        }),
      { names: ["alarm"] },
    );

    let scheduler: AlarmScheduler | undefined;
    api.registerService({
      id: "dennou-alarm-scheduler",
      start(ctx) {
        // Guard against double-start (e.g. hot reload): stop any previous scheduler first.
        scheduler?.stop();
        const store = getSharedAlarmStore(resolveAlarmStorePath());
        // Restart catch-up (§4.2): recompute repeating alarms to future slots.
        applyCatchUpToStore(store, Date.now(), api.logger);
        scheduler = new AlarmScheduler({
          store,
          onFire: (event) => {
            // Phase 2 replaces this log with event-pump injection.
            api.logger.info(
              `dennou-alarm: fired ${event.alarm.id} (${event.alarm.timeExpression}): ${event.alarm.task}${event.delayed ? " [delayed]" : ""}`,
            );
          },
          onError: (error) => {
            api.logger.warn(
              `dennou-alarm: fire handler failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        });
        scheduler.start();
        api.logger.info("dennou-alarm: scheduler started.");
      },
      stop() {
        scheduler?.stop();
        scheduler = undefined;
      },
    });
  },
});

/**
 * Session Integrity Guard — Phase 2 plugin skeleton + Phase 3 repair / notify.
 *
 * Phase 2: registers a single daily cron job that wakes the main session with a
 * `systemEvent` payload; the `before_agent_reply` handler reads the payload and
 * runs the four-metric integrity scan over every session JSONL file in the
 * default session directory for `cwd`.
 *
 * Phase 3 additions (DENNOU_DOCS/SESSION_INTEGRITY_GUARD.md §4.4, §4.5, §7):
 *   - The same `before_agent_reply` handler also drives the auto-repair
 *     pipeline (`autoRepair: true` in plugin config) and produces a notify
 *     payload so a separate announce cron can publish Discord / Telegram
 *     notifications.
 *   - Startup reconciliation also registers an announce cron job with
 *     `delivery: { mode: "announce" | "none" }`.
 *
 * Design reference: DENNOU_DOCS/SESSION_INTEGRITY_GUARD.md §4.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  INTEGRITY_EVENT_TEXT,
  reconcileIntegrityCronJob,
  reconcileIntegrityNotifyCronJob,
  resolveCronServiceFromStartupEvent,
  resolveSessionIntegrityConfig,
  runIntegrityHealthCheck,
} from "./src/cron-job.js";

function resolvePluginConfig(
  api: Parameters<Parameters<typeof definePluginEntry>[0]["register"]>[0],
): Record<string, unknown> {
  const candidate = (api as unknown as { pluginConfig?: Record<string, unknown> }).pluginConfig;
  if (candidate && typeof candidate === "object") {
    return candidate;
  }
  return {};
}

export {
  reconcileIntegrityCronJob,
  reconcileIntegrityNotifyCronJob,
  resolveCronServiceFromStartupEvent,
  resolveSessionIntegrityConfig,
  runIntegrityHealthCheck,
  INTEGRITY_EVENT_TEXT,
} from "./src/cron-job.js";

export type {
  CronServiceLike,
  HealthCheckOutcome,
  ReconcileNotifyResult,
  ReconcileResult,
  SessionIntegrityConfig,
} from "./src/cron-job.js";

export { buildBackupPath, createBackupFile, formatBackupTimestamp } from "./src/backup.js";

export {
  applyRemovals,
  hashMessageRows,
  identifyRemovableOrphans,
  isRemovableOrphan,
  runRepairForFile,
  runRepairForFiles,
} from "./src/repair.js";

export type { RepairEntrySnapshot, RepairOutcome } from "./src/repair.js";

export { buildNotifyDelivery, formatNotifyMessage, resolveNotifyConfig } from "./src/notify.js";

export type {
  NotifyChannel,
  NotifyConfig,
  NotifyDelivery,
  NotifyFileSummary,
  NotifyPayload,
} from "./src/notify.js";

export default definePluginEntry({
  id: "session-integrity-guard",
  name: "Session Integrity Guard",
  description:
    "Periodic health check + auto-repair + Discord/Telegram notify for session JSONL integrity (Phase 3)",
  kind: "memory",
  register(api) {
    const config = resolveSessionIntegrityConfig({ pluginConfig: resolvePluginConfig(api) });

    api.registerHook(
      "gateway:startup",
      async (event: unknown) => {
        try {
          const cron = resolveCronServiceFromStartupEvent(event);
          if (!cron && config.enabled) {
            api.logger.warn(
              "session-integrity-guard: cron service unavailable; managed job not reconciled.",
            );
          }
          await reconcileIntegrityCronJob({
            cron,
            config,
            logger: api.logger,
          });
          await reconcileIntegrityNotifyCronJob({
            cron,
            config,
            logger: api.logger,
          });
        } catch (err) {
          api.logger.error(
            `session-integrity-guard: startup reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      { name: "session-integrity-guard-cron" },
    );

    api.on("before_agent_reply", async (event, ctx) => {
      try {
        if (ctx.trigger !== "heartbeat") {
          return undefined;
        }
        if (event.cleanedBody.trim() !== INTEGRITY_EVENT_TEXT) {
          return undefined;
        }
        if (!config.enabled) {
          return { handled: true, reason: "session-integrity-guard: disabled" };
        }
        const outcome = await runIntegrityHealthCheck({
          cwd: ctx.workspaceDir,
          logger: api.logger,
          autoRepair: config.autoRepair,
        });
        api.logger.info(
          `session-integrity-guard: scanned ${outcome.scanned} session file(s), ${outcome.failures} with anomalies, ${outcome.repairs.filter((r) => r.status === "applied").length} repaired.`,
        );
        return { handled: true, reason: `session-integrity-guard: scanned=${outcome.scanned}` };
      } catch (err) {
        api.logger.error(
          `session-integrity-guard: health check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    });
  },
});

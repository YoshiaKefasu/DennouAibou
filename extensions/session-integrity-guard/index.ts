/**
 * Session Integrity Guard — autonomous plugin entry (DEBLOAT §34).
 *
 * The old Gateway cron coupling (`cron.add` via `gateway:startup`) was removed
 * with the `src/cron/` subsystem. The guard now runs as a self-contained
 * `registerService` backed by `IntegrityScheduler` (croner): on fire it scans
 * session JSONL files directly and delivers anomaly notifications via
 * `deliverOutboundPayloads` — no kernel cron service involved.
 *
 * The `before_agent_reply` hook remains as a manual trigger path: when the
 * agent session receives the integrity event text on heartbeat, the same
 * health check runs inline.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  INTEGRITY_DEFAULT_FREQUENCY,
  INTEGRITY_EVENT_TEXT,
  IntegrityScheduler,
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
  INTEGRITY_DEFAULT_FREQUENCY,
  INTEGRITY_EVENT_TEXT,
  IntegrityScheduler,
  resolveSessionIntegrityConfig,
  runIntegrityHealthCheck,
} from "./src/cron-job.js";

export type {
  HealthCheckOutcome,
  IntegrityCronFactory,
  IntegrityCronJob,
  IntegrityNotifyDeliver,
  IntegritySchedulerOptions,
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
    "Periodic health check + auto-repair + Discord/Telegram notify for session JSONL integrity (autonomous scheduler)",
  kind: "memory",
  register(api) {
    const config = resolveSessionIntegrityConfig({ pluginConfig: resolvePluginConfig(api) });

    let scheduler: IntegrityScheduler | undefined;
    api.registerService({
      id: "session-integrity-guard-scheduler",
      start(ctx) {
        // Guard against double-start (e.g. hot reload).
        scheduler?.stop();
        scheduler = undefined;
        if (!config.enabled) {
          api.logger.info("session-integrity-guard: disabled by config.");
          return;
        }
        const next = new IntegrityScheduler({
          schedule: config.cron,
          ...(config.timezone ? { timezone: config.timezone } : {}),
          autoRepair: config.autoRepair,
          notify: config.notify,
          cfg: ctx.config,
          logger: api.logger,
        });
        if (!next.start()) {
          return;
        }
        scheduler = next;
        api.logger.info(`session-integrity-guard: scheduler started (${config.cron}).`);
      },
      stop() {
        scheduler?.stop();
        scheduler = undefined;
      },
    });

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

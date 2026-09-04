/**
 * Session Integrity Guard — Phase 2 plugin skeleton.
 *
 * Registers a single daily cron job that wakes the main session with a
 * `systemEvent` payload; the `before_agent_reply` handler reads the payload
 * and runs the four-metric integrity scan over every session JSONL file in
 * the default session directory for `cwd`.
 *
 * Design reference: DENNOU_DOCS/SESSION_INTEGRITY_GUARD.md §4.
 * Phase 3 (notification + auto-repair) is intentionally out of scope here.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  INTEGRITY_EVENT_TEXT,
  reconcileIntegrityCronJob,
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
  resolveCronServiceFromStartupEvent,
  resolveSessionIntegrityConfig,
  runIntegrityHealthCheck,
  INTEGRITY_EVENT_TEXT,
} from "./src/cron-job.js";

export type {
  CronServiceLike,
  HealthCheckOutcome,
  ReconcileResult,
  SessionIntegrityConfig,
} from "./src/cron-job.js";

export default definePluginEntry({
  id: "session-integrity-guard",
  name: "Session Integrity Guard",
  description: "Periodic health check for session JSONL integrity (Phase 2)",
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
        });
        api.logger.info(
          `session-integrity-guard: scanned ${outcome.scanned} session file(s), ${outcome.failures} with anomalies.`,
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

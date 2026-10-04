/**
 * Session integrity guard — autonomous scheduler (DEBLOAT §34).
 *
 * The old Gateway cron coupling (`cron.add` via `gateway:startup`) was removed
 * with the `src/cron/` subsystem. This module now owns a self-contained
 * croner-backed scheduler, mirroring `extensions/raw-chat-search/src/dream.ts`:
 * - `IntegrityScheduler.start()` registers one `Cron` job (false on invalid
 *   expression — the gateway keeps running without the guard).
 * - On fire it runs `runIntegrityHealthCheck` directly (no agent session) and,
 *   when notify is enabled with a target, delivers the outcome via
 *   `deliverOutboundPayloads` (no cron delivery indirection).
 */

import { Cron } from "croner";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { deliverOutboundPayloads } from "../../../src/infra/outbound/deliver.js";
import { runHealthCheck, formatHealthCheckLine, type HealthCheckResult } from "./health-check.js";
import {
  formatNotifyMessage,
  resolveNotifyConfig,
  type NotifyConfig,
  type NotifyFileSummary,
} from "./notify.js";
import { runRepairForFiles, type RepairOutcome } from "./repair.js";
import { discoverSessionFiles, readSessionFile } from "./session-discovery.js";

export const INTEGRITY_EVENT_TEXT = "__openclaw_session_integrity_health_check__";
export const INTEGRITY_DEFAULT_FREQUENCY = "0 3 * * *";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type SessionIntegrityConfig = {
  enabled: boolean;
  cron: string;
  timezone?: string;
  autoRepair: boolean;
  notify: NotifyConfig;
};

export function resolveSessionIntegrityConfig(params: {
  pluginConfig?: Record<string, unknown>;
}): SessionIntegrityConfig {
  const raw = params.pluginConfig ?? {};
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
  const cron =
    typeof raw.frequency === "string" && raw.frequency.trim().length > 0
      ? raw.frequency.trim()
      : INTEGRITY_DEFAULT_FREQUENCY;
  const timezone =
    typeof raw.timezone === "string" && raw.timezone.trim().length > 0
      ? raw.timezone.trim()
      : undefined;
  const autoRepair = raw.autoRepair === true;
  const notify = resolveNotifyConfig(raw.notify);
  const config: SessionIntegrityConfig = {
    enabled,
    cron,
    autoRepair,
    notify,
  };
  if (timezone) {
    config.timezone = timezone;
  }
  return config;
}

export interface HealthCheckOutcome {
  scanned: number;
  failures: number;
  results: Array<{ file: string; result: HealthCheckResult }>;
  repairs: RepairOutcome[];
  notifyMessage: string | null;
}

export interface RunIntegrityHealthCheckParams {
  cwd?: string;
  logger: Logger;
  autoRepair?: boolean;
}

/**
 * Run the integrity scan over every discovered session file.
 *
 * When `autoRepair` is true, the repair pipeline runs sequentially for files
 * that contain anomalies. The aggregate outcome exposes per-file repair
 * results and a pre-formatted notify message (returned even when notify
 * delivery is disabled so tests / log consumers can inspect the text).
 */
export async function runIntegrityHealthCheck(
  params: RunIntegrityHealthCheckParams,
): Promise<HealthCheckOutcome> {
  const files = await discoverSessionFiles({ cwd: params.cwd });
  const results: HealthCheckOutcome["results"] = [];
  let failures = 0;
  const autoRepair = params.autoRepair === true;
  const repairTargets: string[] = [];
  for (const file of files) {
    const content = await readSessionFile(file);
    const result = runHealthCheck(content);
    params.logger.info(formatHealthCheckLine(file, result));
    if (
      result.jsonErrorCount > 0 ||
      result.duplicateIdCount > 0 ||
      result.orphanCount > 0 ||
      result.leafCount > 1
    ) {
      failures += 1;
      if (result.orphanCount > 0) {
        repairTargets.push(file);
      }
    }
    results.push({ file, result });
  }
  let repairs: RepairOutcome[] = [];
  if (repairTargets.length > 0) {
    repairs = await runRepairForFiles({ files: repairTargets, autoRepair });
  }
  const notifyMessage = formatNotifyPayload({
    scanned: files.length,
    failures,
    autoRepair,
    results,
    repairs,
  });
  return {
    scanned: files.length,
    failures,
    results,
    repairs,
    notifyMessage: notifyMessage.text,
  };
}

function formatNotifyPayload(input: {
  scanned: number;
  failures: number;
  autoRepair: boolean;
  results: HealthCheckOutcome["results"];
  repairs: RepairOutcome[];
}): { text: string | null } {
  const files: NotifyFileSummary[] = [];
  for (const entry of input.results) {
    const result = entry.result;
    if (result.orphanCount === 0 && result.jsonErrorCount === 0 && result.duplicateIdCount === 0) {
      continue;
    }
    const repairOutcome = input.repairs.find((r) => r.file === entry.file);
    let removedCount: number | null = null;
    let backupPath: string | null = null;
    let status = "ok";
    if (repairOutcome) {
      if (repairOutcome.status === "applied") {
        removedCount = repairOutcome.removedCount;
        backupPath = repairOutcome.backupPath;
        status = "repaired";
      } else if (
        repairOutcome.status === "skipped" &&
        repairOutcome.reason === "auto-repair-disabled"
      ) {
        status = "dry-run-only";
      } else if (repairOutcome.status === "skipped") {
        status = "skipped";
      } else {
        status = "error";
      }
    }
    files.push({
      file: entry.file,
      orphanCount: result.orphanCount,
      removedCount,
      backupPath,
      status,
    });
  }
  if (files.length === 0) {
    return { text: null };
  }
  return {
    text: formatNotifyMessage({
      scanned: input.scanned,
      failures: input.failures,
      autoRepair: input.autoRepair,
      files,
    }),
  };
}

export type IntegrityCronJob = {
  stop: () => void;
};

export type IntegrityCronFactory = (
  schedule: string,
  timezone: string | undefined,
  onFire: () => void,
) => IntegrityCronJob;

const defaultIntegrityCronFactory: IntegrityCronFactory = (schedule, timezone, onFire) =>
  new Cron(schedule, { ...(timezone ? { timezone } : {}), protect: true }, onFire);

export type IntegrityNotifyDeliver = (
  text: string,
  params: { config: SessionIntegrityConfig; cfg?: OpenClawConfig },
) => Promise<void>;

async function defaultDeliverNotify(
  text: string,
  params: { config: SessionIntegrityConfig; cfg?: OpenClawConfig },
): Promise<void> {
  const { config, cfg } = params;
  if (!cfg) {
    throw new Error("session-integrity-guard: no gateway config available for notify delivery.");
  }
  const to = config.notify.to?.trim();
  if (!to) {
    throw new Error(
      "session-integrity-guard: notify is enabled but no target (`to`) is configured.",
    );
  }
  await deliverOutboundPayloads({
    cfg,
    channel: config.notify.channel,
    to,
    ...(config.notify.accountId ? { accountId: config.notify.accountId } : {}),
    payloads: [{ text }],
    ...(config.notify.bestEffort ? { bestEffort: true } : {}),
  });
}

export type IntegritySchedulerOptions = {
  schedule?: string;
  timezone?: string;
  autoRepair?: boolean;
  notify?: NotifyConfig;
  cwd?: string;
  cfg?: OpenClawConfig | (() => OpenClawConfig);
  logger: Logger;
  cronFactory?: IntegrityCronFactory;
  deliverNotify?: IntegrityNotifyDeliver;
  runCheck?: (params: RunIntegrityHealthCheckParams) => Promise<HealthCheckOutcome>;
};

/**
 * Croner-backed integrity scheduler. `start()` registers the Cron job (false
 * when the expression is invalid — the gateway keeps running without the
 * guard); `stop()` frees the timer; `runOnce()` fires one scan on demand.
 */
export class IntegrityScheduler {
  private readonly options: IntegritySchedulerOptions;
  private job: IntegrityCronJob | null = null;
  private inFlight: Promise<HealthCheckOutcome> | null = null;

  constructor(options: IntegritySchedulerOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.job !== null;
  }

  start(): boolean {
    if (this.job) {
      return true;
    }
    const schedule = this.options.schedule?.trim() || INTEGRITY_DEFAULT_FREQUENCY;
    const timezone = this.options.timezone?.trim() || undefined;
    const factory = this.options.cronFactory ?? defaultIntegrityCronFactory;
    try {
      this.job = factory(schedule, timezone, () => {
        void this.runOnce().catch((err) => {
          this.options.logger.warn(
            `session-integrity-guard: unhandled error in runOnce: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      });
    } catch (error) {
      this.options.logger.warn(
        `session-integrity-guard: invalid schedule "${schedule}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    return true;
  }

  stop(): void {
    if (!this.job) {
      return;
    }
    try {
      this.job.stop();
    } catch {
      // Teardown best-effort: never fail gateway shutdown.
    }
    this.job = null;
  }

  runOnce(): Promise<HealthCheckOutcome> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const task = this.runScan().finally(() => {
      if (this.inFlight === task) {
        this.inFlight = null;
      }
    });
    this.inFlight = task;
    return task;
  }

  private async runScan(): Promise<HealthCheckOutcome> {
    const runCheck = this.options.runCheck ?? runIntegrityHealthCheck;
    const outcome = await runCheck({
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      logger: this.options.logger,
      autoRepair: this.options.autoRepair === true,
    });
    this.options.logger.info(
      `session-integrity-guard: scanned ${outcome.scanned} session file(s), ` +
        `${outcome.failures} with anomalies, ` +
        `${outcome.repairs.filter((r) => r.status === "applied").length} repaired.`,
    );
    const notify = this.options.notify;
    if (notify?.enabled && outcome.notifyMessage) {
      const deliver = this.options.deliverNotify ?? defaultDeliverNotify;
      try {
        await deliver(outcome.notifyMessage, {
          config: {
            enabled: true,
            cron: this.options.schedule?.trim() || INTEGRITY_DEFAULT_FREQUENCY,
            ...(this.options.timezone ? { timezone: this.options.timezone } : {}),
            autoRepair: this.options.autoRepair === true,
            notify,
          },
          ...(this.readCfg() ? { cfg: this.readCfg() } : {}),
        });
      } catch (err) {
        this.options.logger.warn(
          `session-integrity-guard: notify delivery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return outcome;
  }

  private readCfg(): OpenClawConfig | undefined {
    if (!this.options.cfg) {
      return undefined;
    }
    return typeof this.options.cfg === "function" ? this.options.cfg() : this.options.cfg;
  }
}

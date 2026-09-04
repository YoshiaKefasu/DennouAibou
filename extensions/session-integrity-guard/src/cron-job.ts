/**
 * Cron registration helper for the session-integrity-guard plugin (Phase 2 + Phase 3).
 *
 * Pattern mirror: `extensions/memory-core/src/dreaming.ts`
 * - `resolveCronServiceFromStartupEvent` parses the `gateway:startup` payload.
 * - `reconcileManagedCronJob` keeps exactly one managed job matching the
 *   canonical name + tag + payload, and prunes duplicates / legacy siblings.
 *
 * Differences vs memory-core dreaming:
 *   - Phase 2: single cron job (no light/rem/REM phases).
 *   - Default expression is `0 3 * * *` (DESIGN §4.3), not the dreaming default.
 *   - Payload text identifies the integrity check (used by `before_agent_reply`).
 *
 * Phase 3 additions (DENNOU_DOCS/SESSION_INTEGRITY_GUARD.md §4.4, §7):
 *   - `reconcileIntegrityNotifyCronJob` registers a separate announce cron
 *     with `delivery: { mode: "announce" | "none" }` so Phase 2's check job
 *     is not perturbed.
 *   - `runIntegrityHealthCheck` now also drives the auto-repair pipeline and
 *     reports per-file repair outcomes so the announce cron can surface them.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { runHealthCheck, formatHealthCheckLine, type HealthCheckResult } from "./health-check.js";
import {
  buildNotifyDelivery,
  formatNotifyMessage,
  resolveNotifyConfig,
  type NotifyConfig,
  type NotifyDelivery,
  type NotifyFileSummary,
} from "./notify.js";
import { runRepairForFiles, type RepairOutcome } from "./repair.js";
import { discoverSessionFiles, readSessionFile } from "./session-discovery.js";

const MANAGED_CRON_NAME = "Session Integrity Health Check";
const MANAGED_CRON_TAG = "[managed-by=session-integrity-guard]";
const INTEGRITY_CHECK_EVENT_TEXT = "__openclaw_session_integrity_health_check__";

const NOTIFY_CRON_NAME = "Session Integrity Notify";
const NOTIFY_CRON_TAG = "[managed-by=session-integrity-guard.notify]";
const NOTIFY_EVENT_TEXT = "__openclaw_session_integrity_notify_publish__";

const DEFAULT_FREQUENCY = "0 3 * * *";
const NOTIFY_DEFAULT_FREQUENCY = "5 3 * * *";

type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;

type CronSchedule = { kind: "cron"; expr: string; tz?: string };
type CronPayload = { kind: "systemEvent"; text: string };
type CronDelivery = NotifyDelivery;

type ManagedCronJobCreate = {
  name: string;
  description: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main";
  wakeMode: "next-heartbeat";
  payload: CronPayload;
  delivery?: CronDelivery;
};

type ManagedCronJobPatch = {
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  sessionTarget?: "main";
  wakeMode?: "next-heartbeat";
  payload?: CronPayload;
  delivery?: CronDelivery;
};

type ManagedCronJobLike = {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: { kind?: string; expr?: string; tz?: string };
  sessionTarget?: string;
  wakeMode?: string;
  payload?: { kind?: string; text?: string };
  delivery?: CronDelivery;
  createdAtMs?: number;
};

export type CronServiceLike = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<ManagedCronJobLike[]>;
  add: (input: ManagedCronJobCreate) => Promise<unknown>;
  update: (id: string, patch: ManagedCronJobPatch) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
};

export type SessionIntegrityConfig = {
  enabled: boolean;
  cron: string;
  timezone?: string;
  autoRepair: boolean;
  notify: NotifyConfig;
};

export const INTEGRITY_EVENT_TEXT = INTEGRITY_CHECK_EVENT_TEXT;
export const INTEGRITY_CRON_NAME = MANAGED_CRON_NAME;
export const INTEGRITY_CRON_TAG = MANAGED_CRON_TAG;
export const INTEGRITY_DEFAULT_FREQUENCY = DEFAULT_FREQUENCY;
export const INTEGRITY_NOTIFY_CRON_NAME = NOTIFY_CRON_NAME;
export const INTEGRITY_NOTIFY_CRON_TAG = NOTIFY_CRON_TAG;
export const INTEGRITY_NOTIFY_DEFAULT_FREQUENCY = NOTIFY_DEFAULT_FREQUENCY;
export const INTEGRITY_NOTIFY_EVENT_TEXT = NOTIFY_EVENT_TEXT;

export function resolveSessionIntegrityConfig(params: {
  pluginConfig?: Record<string, unknown>;
}): SessionIntegrityConfig {
  const raw = params.pluginConfig ?? {};
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
  const cron =
    typeof raw.frequency === "string" && raw.frequency.trim().length > 0
      ? raw.frequency.trim()
      : DEFAULT_FREQUENCY;
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

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function resolveCronServiceFromStartupEvent(event: unknown): CronServiceLike | null {
  const payload = asRecord(event);
  if (!payload) {
    return null;
  }
  if (payload.type !== "gateway" || payload.action !== "startup") {
    return null;
  }
  const context = asRecord(payload.context);
  const deps = asRecord(context?.deps);
  const cronCandidate = context?.cron ?? deps?.cron;
  if (!cronCandidate || typeof cronCandidate !== "object") {
    return null;
  }
  const cron = cronCandidate as Partial<CronServiceLike>;
  if (
    typeof cron.list !== "function" ||
    typeof cron.add !== "function" ||
    typeof cron.update !== "function" ||
    typeof cron.remove !== "function"
  ) {
    return null;
  }
  return cron as CronServiceLike;
}

function describeJob(config: SessionIntegrityConfig): string {
  const tz = config.timezone ? ` (tz=${config.timezone})` : "";
  return `${MANAGED_CRON_TAG} Daily session integrity scan at "${config.cron}"${tz}.`;
}

function buildDesiredJob(config: SessionIntegrityConfig): ManagedCronJobCreate {
  return {
    name: MANAGED_CRON_NAME,
    description: describeJob(config),
    enabled: config.enabled,
    schedule: {
      kind: "cron",
      expr: config.cron,
      ...(config.timezone ? { tz: config.timezone } : {}),
    },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text: INTEGRITY_CHECK_EVENT_TEXT,
    },
  };
}

function isManagedJob(job: ManagedCronJobLike): boolean {
  const description = normalizeTrimmedString(job.description);
  if (description?.includes(MANAGED_CRON_TAG)) {
    return true;
  }
  const name = normalizeTrimmedString(job.name);
  const payloadText = normalizeTrimmedString(job.payload?.text);
  return name === MANAGED_CRON_NAME && payloadText === INTEGRITY_CHECK_EVENT_TEXT;
}

function sortManagedJobs(managed: ManagedCronJobLike[]): ManagedCronJobLike[] {
  return managed.toSorted((a, b) => {
    const aCreated =
      typeof a.createdAtMs === "number" && Number.isFinite(a.createdAtMs)
        ? a.createdAtMs
        : Number.MAX_SAFE_INTEGER;
    const bCreated =
      typeof b.createdAtMs === "number" && Number.isFinite(b.createdAtMs)
        ? b.createdAtMs
        : Number.MAX_SAFE_INTEGER;
    if (aCreated !== bCreated) {
      return aCreated - bCreated;
    }
    return a.id.localeCompare(b.id);
  });
}

function buildPatch(
  current: ManagedCronJobLike,
  desired: ManagedCronJobCreate,
): ManagedCronJobPatch | null {
  const patch: ManagedCronJobPatch = {};
  if (current.name !== desired.name) {
    patch.name = desired.name;
  }
  if (current.description !== desired.description) {
    patch.description = desired.description;
  }
  if (current.enabled !== desired.enabled) {
    patch.enabled = desired.enabled;
  }
  const currentSchedule = current.schedule ?? {};
  if (currentSchedule.expr !== desired.schedule.expr) {
    patch.schedule = {
      kind: "cron",
      expr: desired.schedule.expr,
      ...(desired.schedule.tz ? { tz: desired.schedule.tz } : {}),
    };
  } else if (currentSchedule.tz !== desired.schedule.tz) {
    patch.schedule = {
      kind: "cron",
      expr: desired.schedule.expr,
      ...(desired.schedule.tz ? { tz: desired.schedule.tz } : {}),
    };
  }
  if (current.sessionTarget !== desired.sessionTarget) {
    patch.sessionTarget = "main";
  }
  if (current.wakeMode !== desired.wakeMode) {
    patch.wakeMode = "next-heartbeat";
  }
  const currentPayloadText = normalizeTrimmedString(current.payload?.text);
  if (currentPayloadText !== desired.payload.text) {
    patch.payload = { kind: "systemEvent", text: desired.payload.text };
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export type ReconcileResult =
  | { status: "unavailable"; removed: number }
  | { status: "disabled"; removed: number }
  | { status: "added"; removed: number }
  | { status: "updated"; removed: number }
  | { status: "noop"; removed: number };

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export async function reconcileIntegrityCronJob(params: {
  cron: CronServiceLike | null;
  config: SessionIntegrityConfig;
  logger: Logger;
}): Promise<ReconcileResult> {
  const cron = params.cron;
  if (!cron) {
    return { status: "unavailable", removed: 0 };
  }
  const allJobs = await cron.list({ includeDisabled: true });
  const managed = allJobs.filter(isManagedJob);

  if (!params.config.enabled) {
    let removed = 0;
    for (const job of managed) {
      try {
        const result = await cron.remove(job.id);
        if (result.removed === true) {
          removed += 1;
        }
      } catch (err) {
        params.logger.warn(
          `session-integrity-guard: failed to remove managed cron job ${job.id}: ${formatErrorMessage(err)}`,
        );
      }
    }
    if (removed > 0) {
      params.logger.info(`session-integrity-guard: removed ${removed} managed cron job(s).`);
    }
    return { status: "disabled", removed };
  }

  const desired = buildDesiredJob(params.config);
  if (managed.length === 0) {
    await cron.add(desired);
    params.logger.info("session-integrity-guard: created managed cron job.");
    return { status: "added", removed: 0 };
  }

  const [primary, ...duplicates] = sortManagedJobs(managed);
  let removed = 0;
  for (const duplicate of duplicates) {
    try {
      const result = await cron.remove(duplicate.id);
      if (result.removed === true) {
        removed += 1;
      }
    } catch (err) {
      params.logger.warn(
        `session-integrity-guard: failed to prune duplicate managed cron job ${duplicate.id}: ${formatErrorMessage(err)}`,
      );
    }
  }

  const patch = buildPatch(primary, desired);
  if (!patch) {
    if (removed > 0) {
      params.logger.info("session-integrity-guard: pruned duplicate managed cron job(s).");
    }
    return { status: "noop", removed };
  }

  await cron.update(primary.id, patch);
  params.logger.info("session-integrity-guard: updated managed cron job.");
  return { status: "updated", removed };
}

// Phase 3 — announce cron. The integrity check stays as the Phase 2 job; the
// announce cron is a sibling so its delivery patch does not disturb the check
// schedule.

function describeNotifyJob(): string {
  return `${NOTIFY_CRON_TAG} Publish session-integrity-guard anomalies to Discord / Telegram.`;
}

function buildDesiredNotifyJob(config: SessionIntegrityConfig): ManagedCronJobCreate {
  return {
    name: NOTIFY_CRON_NAME,
    description: describeNotifyJob(),
    enabled: config.enabled && config.notify.enabled,
    schedule: {
      kind: "cron",
      expr: NOTIFY_DEFAULT_FREQUENCY,
      ...(config.timezone ? { tz: config.timezone } : {}),
    },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text: NOTIFY_EVENT_TEXT,
    },
    delivery: buildNotifyDelivery(config.notify),
  };
}

function isManagedNotifyJob(job: ManagedCronJobLike): boolean {
  const description = normalizeTrimmedString(job.description);
  if (description?.includes(NOTIFY_CRON_TAG)) {
    return true;
  }
  const name = normalizeTrimmedString(job.name);
  const payloadText = normalizeTrimmedString(job.payload?.text);
  return name === NOTIFY_CRON_NAME && payloadText === NOTIFY_EVENT_TEXT;
}

function buildNotifyPatch(
  job: ManagedCronJobLike,
  desired: ManagedCronJobCreate,
): ManagedCronJobPatch | null {
  const patch: ManagedCronJobPatch = {};
  if (normalizeTrimmedString(job.name) !== desired.name) {
    patch.name = desired.name;
  }
  if (normalizeTrimmedString(job.description) !== desired.description) {
    patch.description = desired.description;
  }
  const jobEnabled = job.enabled === true;
  if (jobEnabled !== desired.enabled) {
    patch.enabled = desired.enabled;
  }
  const currentSchedule = job.schedule ?? {};
  if (currentSchedule.expr !== desired.schedule.expr) {
    patch.schedule = {
      kind: "cron",
      expr: desired.schedule.expr,
      ...(desired.schedule.tz ? { tz: desired.schedule.tz } : {}),
    };
  } else if ((currentSchedule.tz ?? undefined) !== (desired.schedule.tz ?? undefined)) {
    patch.schedule = {
      kind: "cron",
      expr: desired.schedule.expr,
      ...(desired.schedule.tz ? { tz: desired.schedule.tz } : {}),
    };
  }
  if (job.sessionTarget !== desired.sessionTarget) {
    patch.sessionTarget = "main";
  }
  if (job.wakeMode !== desired.wakeMode) {
    patch.wakeMode = "next-heartbeat";
  }
  if (normalizeTrimmedString(job.payload?.text) !== desired.payload.text) {
    patch.payload = { kind: "systemEvent", text: desired.payload.text };
  }
  if (!cronDeliveryEquals(job.delivery, desired.delivery)) {
    patch.delivery = desired.delivery;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function cronDeliveryEquals(a: CronDelivery | undefined, b: CronDelivery | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.mode !== b.mode) {
    return false;
  }
  if (a.mode === "none" && b.mode === "none") {
    return true;
  }
  if (a.mode === "announce" && b.mode === "announce") {
    return (
      a.channel === b.channel &&
      (a.to ?? undefined) === (b.to ?? undefined) &&
      (a.accountId ?? undefined) === (b.accountId ?? undefined) &&
      (a.bestEffort ?? false) === (b.bestEffort ?? false)
    );
  }
  return false;
}

export type ReconcileNotifyResult =
  | { status: "unavailable"; removed: number }
  | { status: "disabled"; removed: number }
  | { status: "added"; removed: number }
  | { status: "updated"; removed: number }
  | { status: "noop"; removed: number };

export async function reconcileIntegrityNotifyCronJob(params: {
  cron: CronServiceLike | null;
  config: SessionIntegrityConfig;
  logger: Logger;
}): Promise<ReconcileNotifyResult> {
  const cron = params.cron;
  if (!cron) {
    return { status: "unavailable", removed: 0 };
  }
  const allJobs = await cron.list({ includeDisabled: true });
  const managed = allJobs.filter(isManagedNotifyJob);
  if (!params.config.enabled || !params.config.notify.enabled) {
    let removed = 0;
    for (const job of managed) {
      try {
        const result = await cron.remove(job.id);
        if (result.removed === true) {
          removed += 1;
        }
      } catch (err) {
        params.logger.warn(
          `session-integrity-guard: failed to remove notify cron job ${job.id}: ${formatErrorMessage(err)}`,
        );
      }
    }
    if (removed > 0) {
      params.logger.info(`session-integrity-guard: removed ${removed} notify cron job(s).`);
    }
    return { status: "disabled", removed };
  }
  const desired = buildDesiredNotifyJob(params.config);
  if (managed.length === 0) {
    await cron.add(desired);
    params.logger.info("session-integrity-guard: created notify cron job.");
    return { status: "added", removed: 0 };
  }
  const [primary, ...duplicates] = sortManagedJobs(managed);
  let removed = 0;
  for (const duplicate of duplicates) {
    try {
      const result = await cron.remove(duplicate.id);
      if (result.removed === true) {
        removed += 1;
      }
    } catch (err) {
      params.logger.warn(
        `session-integrity-guard: failed to prune duplicate notify cron job ${duplicate.id}: ${formatErrorMessage(err)}`,
      );
    }
  }
  const patch = buildNotifyPatch(primary, desired);
  if (!patch) {
    if (removed > 0) {
      params.logger.info("session-integrity-guard: pruned duplicate notify cron job(s).");
    }
    return { status: "noop", removed };
  }
  await cron.update(primary.id, patch);
  params.logger.info("session-integrity-guard: updated notify cron job.");
  return { status: "updated", removed };
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
 * Phase 3: when `autoRepair` is true (or the call site defaults to false), the
 * repair pipeline runs sequentially for files that contain anomalies. The
 * aggregate outcome exposes per-file repair results and a pre-formatted notify
 * message (returned even when the announce cron is disabled so tests / log
 * consumers can inspect the text).
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

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { writeConfigFile, type OpenClawConfig } from "../config/config.js";
import { resolveGatewayPort, resolveIsNixMode } from "../config/paths.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import {
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
  type ExtraGatewayService,
} from "../daemon/inspect.js";
import { renderSystemNodeWarning, resolveSystemNodeInfo } from "../daemon/runtime-paths.js";
import {
  auditGatewayServiceConfig,
  needsNodeRuntimeMigration,
  readEmbeddedGatewayToken,
  SERVICE_AUDIT_CODES,
} from "../daemon/service-audit.js";
import { resolveGatewayService } from "../daemon/service.js";
import { uninstallLegacySystemdUnits } from "../daemon/systemd.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, type GatewayDaemonRuntime } from "./daemon-runtime.js";
import { resolveGatewayAuthTokenForService } from "./doctor-gateway-auth-token.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
import { isDoctorUpdateRepairMode } from "./doctor-repair-mode.js";

const execFileAsync = promisify(execFile);

export type DoctorGatewayServicesDeps = {
  realpath?: (path: string) => Promise<string>;
  resolveIsNixMode?: typeof resolveIsNixMode;
  writeConfigFile?: typeof writeConfigFile;
  resolveGatewayService?: typeof resolveGatewayService;
  resolveGatewayPort?: typeof resolveGatewayPort;
  resolveGatewayAuthTokenForService?: typeof resolveGatewayAuthTokenForService;
  auditGatewayServiceConfig?: typeof auditGatewayServiceConfig;
  readEmbeddedGatewayToken?: typeof readEmbeddedGatewayToken;
  needsNodeRuntimeMigration?: typeof needsNodeRuntimeMigration;
  resolveSystemNodeInfo?: typeof resolveSystemNodeInfo;
  renderSystemNodeWarning?: typeof renderSystemNodeWarning;
  buildGatewayInstallPlan?: typeof buildGatewayInstallPlan;
  findExtraGatewayServices?: typeof findExtraGatewayServices;
  renderGatewayServiceCleanupHints?: typeof renderGatewayServiceCleanupHints;
  uninstallLegacySystemdUnits?: typeof uninstallLegacySystemdUnits;
  note?: typeof note;
};

function detectGatewayRuntime(programArguments: string[] | undefined): GatewayDaemonRuntime {
  const first = programArguments?.[0];
  if (first) {
    const base = path.basename(first).toLowerCase();
    if (base === "bun" || base === "bun.exe") {
      return "bun";
    }
    if (base === "node" || base === "node.exe") {
      return "node";
    }
  }
  return DEFAULT_GATEWAY_DAEMON_RUNTIME;
}

function findGatewayEntrypoint(programArguments?: string[]): string | null {
  if (!programArguments || programArguments.length === 0) {
    return null;
  }
  const gatewayIndex = programArguments.indexOf("gateway");
  if (gatewayIndex <= 0) {
    return null;
  }
  return programArguments[gatewayIndex - 1] ?? null;
}

async function normalizeExecutablePath(
  value: string,
  realpathImpl: (path: string) => Promise<string>,
): Promise<string> {
  const resolvedPath = path.resolve(value);
  try {
    return await realpathImpl(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function extractDetailPath(detail: string, prefix: string): string | null {
  if (!detail.startsWith(prefix)) {
    return null;
  }
  const value = detail.slice(prefix.length).trim();
  return value.length > 0 ? value : null;
}

async function cleanupLegacyLaunchdService(params: {
  label: string;
  plistPath: string;
}): Promise<string | null> {
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  await execFileAsync("launchctl", ["bootout", domain, params.plistPath]).catch(() => undefined);
  await execFileAsync("launchctl", ["unload", params.plistPath]).catch(() => undefined);

  const trashDir = path.join(os.homedir(), ".Trash");
  try {
    await fs.mkdir(trashDir, { recursive: true });
  } catch {
    // ignore
  }

  try {
    await fs.access(params.plistPath);
  } catch {
    return null;
  }

  const dest = path.join(trashDir, `${params.label}-${Date.now()}.plist`);
  try {
    await fs.rename(params.plistPath, dest);
    return dest;
  } catch {
    return null;
  }
}

function classifyLegacyServices(legacyServices: ExtraGatewayService[]): {
  darwinUserServices: ExtraGatewayService[];
  linuxUserServices: ExtraGatewayService[];
  failed: string[];
} {
  const darwinUserServices: ExtraGatewayService[] = [];
  const linuxUserServices: ExtraGatewayService[] = [];
  const failed: string[] = [];

  for (const svc of legacyServices) {
    if (svc.platform === "darwin") {
      if (svc.scope === "user") {
        darwinUserServices.push(svc);
      } else {
        failed.push(`${svc.label} (${svc.scope})`);
      }
      continue;
    }

    if (svc.platform === "linux") {
      if (svc.scope === "user") {
        linuxUserServices.push(svc);
      } else {
        failed.push(`${svc.label} (${svc.scope})`);
      }
      continue;
    }

    failed.push(`${svc.label} (${svc.platform})`);
  }

  return { darwinUserServices, linuxUserServices, failed };
}

async function cleanupLegacyDarwinServices(
  services: ExtraGatewayService[],
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];

  for (const svc of services) {
    const plistPath = extractDetailPath(svc.detail, "plist:");
    if (!plistPath) {
      failed.push(`${svc.label} (missing plist path)`);
      continue;
    }
    const dest = await cleanupLegacyLaunchdService({
      label: svc.label,
      plistPath,
    });
    removed.push(dest ? `${svc.label} -> ${dest}` : svc.label);
  }

  return { removed, failed };
}

async function cleanupLegacyLinuxUserServices(
  services: ExtraGatewayService[],
  runtime: RuntimeEnv,
  uninstallLegacySystemdUnitsImpl: typeof uninstallLegacySystemdUnits,
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];

  try {
    const removedUnits = await uninstallLegacySystemdUnitsImpl({
      env: process.env,
      stdout: process.stdout,
    });
    const removedByLabel: Map<string, (typeof removedUnits)[number]> = new Map(
      removedUnits.map((unit) => [`${unit.name}.service`, unit] as const),
    );
    for (const svc of services) {
      const removedUnit = removedByLabel.get(svc.label);
      if (!removedUnit) {
        failed.push(`${svc.label} (legacy unit name not recognized)`);
        continue;
      }
      removed.push(`${svc.label} -> ${removedUnit.unitPath}`);
    }
  } catch (err) {
    runtime.error(`Legacy Linux gateway cleanup failed: ${String(err)}`);
    for (const svc of services) {
      failed.push(`${svc.label} (linux cleanup failed)`);
    }
  }

  return { removed, failed };
}

export async function maybeRepairGatewayServiceConfig(
  cfg: OpenClawConfig,
  mode: "local" | "remote",
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
  deps: DoctorGatewayServicesDeps = {},
) {
  const realpathImpl = deps.realpath ?? (async (path: string) => await fs.realpath(path));
  const resolveIsNixModeImpl = deps.resolveIsNixMode ?? resolveIsNixMode;
  const writeConfigFileImpl = deps.writeConfigFile ?? writeConfigFile;
  const resolveGatewayServiceImpl = deps.resolveGatewayService ?? resolveGatewayService;
  const resolveGatewayPortImpl = deps.resolveGatewayPort ?? resolveGatewayPort;
  const resolveGatewayAuthTokenForServiceImpl =
    deps.resolveGatewayAuthTokenForService ?? resolveGatewayAuthTokenForService;
  const auditGatewayServiceConfigImpl = deps.auditGatewayServiceConfig ?? auditGatewayServiceConfig;
  const readEmbeddedGatewayTokenImpl = deps.readEmbeddedGatewayToken ?? readEmbeddedGatewayToken;
  const needsNodeRuntimeMigrationImpl = deps.needsNodeRuntimeMigration ?? needsNodeRuntimeMigration;
  const resolveSystemNodeInfoImpl = deps.resolveSystemNodeInfo ?? resolveSystemNodeInfo;
  const renderSystemNodeWarningImpl = deps.renderSystemNodeWarning ?? renderSystemNodeWarning;
  const buildGatewayInstallPlanImpl = deps.buildGatewayInstallPlan ?? buildGatewayInstallPlan;
  const noteImpl = deps.note ?? note;

  if (resolveIsNixModeImpl(process.env)) {
    noteImpl("Nix mode detected; skip service updates.", "Gateway");
    return;
  }

  if (mode === "remote") {
    noteImpl("Gateway mode is remote; skipped local service audit.", "Gateway");
    return;
  }

  const service = resolveGatewayServiceImpl();
  let command: Awaited<ReturnType<typeof service.readCommand>> | null = null;
  try {
    command = await service.readCommand(process.env);
  } catch {
    command = null;
  }
  if (!command) {
    return;
  }

  const tokenRefConfigured = Boolean(
    resolveSecretInputRef({
      value: cfg.gateway?.auth?.token,
      defaults: cfg.secrets?.defaults,
    }).ref,
  );
  const gatewayTokenResolution = await resolveGatewayAuthTokenForServiceImpl(cfg, process.env);
  if (gatewayTokenResolution.unavailableReason) {
    noteImpl(
      `Unable to verify gateway service token drift: ${gatewayTokenResolution.unavailableReason}`,
      "Gateway service config",
    );
  }
  const expectedGatewayToken = tokenRefConfigured ? undefined : gatewayTokenResolution.token;
  const audit = await auditGatewayServiceConfigImpl({
    env: process.env,
    command,
    expectedGatewayToken,
  });
  const serviceToken = readEmbeddedGatewayTokenImpl(command);
  if (tokenRefConfigured && serviceToken) {
    audit.issues.push({
      code: SERVICE_AUDIT_CODES.gatewayTokenMismatch,
      message:
        "Gateway service DENNOU_GATEWAY_TOKEN should be unset when gateway.auth.token is SecretRef-managed",
      detail: "service token is stale",
      level: "recommended",
    });
  }
  const needsNodeRuntime = needsNodeRuntimeMigrationImpl(audit.issues);
  const systemNodeInfo = needsNodeRuntime
    ? await resolveSystemNodeInfoImpl({ env: process.env })
    : null;
  const systemNodePath = systemNodeInfo?.supported ? systemNodeInfo.path : null;
  if (needsNodeRuntime && !systemNodePath) {
    const warning = renderSystemNodeWarningImpl(systemNodeInfo);
    if (warning) {
      noteImpl(warning, "Gateway runtime");
    }
    noteImpl(
      "System Node 22 LTS (22.14+) or Node 24 not found. Install via Homebrew/apt/choco and rerun doctor to migrate off Bun/version managers.",
      "Gateway runtime",
    );
  }

  const port = resolveGatewayPortImpl(cfg, process.env);
  const runtimeChoice = detectGatewayRuntime(command.programArguments);
  const { programArguments } = await buildGatewayInstallPlanImpl({
    env: process.env,
    port,
    runtime: needsNodeRuntime && systemNodePath ? "node" : runtimeChoice,
    nodePath: systemNodePath ?? undefined,
    warn: (message, title) => noteImpl(message, title),
    config: cfg,
  });
  const expectedEntrypoint = findGatewayEntrypoint(programArguments);
  const currentEntrypoint = findGatewayEntrypoint(command.programArguments);
  const normalizedExpectedEntrypoint = expectedEntrypoint
    ? await normalizeExecutablePath(expectedEntrypoint, realpathImpl)
    : null;
  const normalizedCurrentEntrypoint = currentEntrypoint
    ? await normalizeExecutablePath(currentEntrypoint, realpathImpl)
    : null;
  if (
    normalizedExpectedEntrypoint &&
    normalizedCurrentEntrypoint &&
    normalizedExpectedEntrypoint !== normalizedCurrentEntrypoint
  ) {
    audit.issues.push({
      code: SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
      message: "Gateway service entrypoint does not match the current install.",
      detail: `${currentEntrypoint} -> ${expectedEntrypoint}`,
      level: "recommended",
    });
  }

  if (audit.issues.length === 0) {
    return;
  }

  noteImpl(
    audit.issues
      .map((issue) =>
        issue.detail ? `- ${issue.message} (${issue.detail})` : `- ${issue.message}`,
      )
      .join("\n"),
    "Gateway service config",
  );

  const aggressiveIssues = audit.issues.filter((issue) => issue.level === "aggressive");
  const needsAggressive = aggressiveIssues.length > 0;

  if (needsAggressive && !prompter.shouldForce) {
    noteImpl(
      "Custom or unexpected service edits detected. Rerun with --force to overwrite.",
      "Gateway service config",
    );
  }

  const repair = needsAggressive
    ? await prompter.confirmAggressiveAutoFix({
        message: "Overwrite gateway service config with current defaults now?",
        initialValue: Boolean(prompter.shouldForce),
      })
    : await prompter.confirmAutoFix({
        message: "Update gateway service config to the recommended defaults now?",
        initialValue: true,
      });
  if (!repair) {
    return;
  }
  const updateRepairMode = isDoctorUpdateRepairMode(prompter.repairMode);
  const serviceEmbeddedToken = readEmbeddedGatewayTokenImpl(command);
  const gatewayTokenForRepair = expectedGatewayToken ?? serviceEmbeddedToken;
  const configuredGatewayToken =
    typeof cfg.gateway?.auth?.token === "string"
      ? cfg.gateway.auth.token.trim() || undefined
      : undefined;
  let cfgForServiceInstall = cfg;
  if (
    !updateRepairMode &&
    !tokenRefConfigured &&
    !configuredGatewayToken &&
    gatewayTokenForRepair
  ) {
    const nextCfg: OpenClawConfig = {
      ...cfg,
      gateway: {
        ...cfg.gateway,
        auth: {
          ...cfg.gateway?.auth,
          mode: cfg.gateway?.auth?.mode ?? "token",
          token: gatewayTokenForRepair,
        },
      },
    };
    try {
      await writeConfigFileImpl(nextCfg);
      cfgForServiceInstall = nextCfg;
      noteImpl(
        expectedGatewayToken
          ? "Persisted gateway.auth.token from environment before reinstalling service."
          : "Persisted gateway.auth.token from existing service definition before reinstalling service.",
        "Gateway",
      );
    } catch (err) {
      runtime.error(`Failed to persist gateway.auth.token before service repair: ${String(err)}`);
      return;
    }
  }

  const updatedPort = resolveGatewayPortImpl(cfgForServiceInstall, process.env);
  const updatedPlan = await buildGatewayInstallPlanImpl({
    env: process.env,
    port: updatedPort,
    runtime: needsNodeRuntime && systemNodePath ? "node" : runtimeChoice,
    nodePath: systemNodePath ?? undefined,
    warn: (message, title) => noteImpl(message, title),
    config: cfgForServiceInstall,
  });
  try {
    await (updateRepairMode ? service.stage : service.install)({
      env: process.env,
      stdout: process.stdout,
      programArguments: updatedPlan.programArguments,
      workingDirectory: updatedPlan.workingDirectory,
      environment: updatedPlan.environment,
    });
  } catch (err) {
    runtime.error(`Gateway service update failed: ${String(err)}`);
  }
}

export async function maybeScanExtraGatewayServices(
  options: DoctorOptions,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
  deps: DoctorGatewayServicesDeps = {},
) {
  const findExtraGatewayServicesImpl = deps.findExtraGatewayServices ?? findExtraGatewayServices;
  const renderGatewayServiceCleanupHintsImpl =
    deps.renderGatewayServiceCleanupHints ?? renderGatewayServiceCleanupHints;
  const uninstallLegacySystemdUnitsImpl =
    deps.uninstallLegacySystemdUnits ?? uninstallLegacySystemdUnits;
  const noteImpl = deps.note ?? note;

  const extraServices = await findExtraGatewayServicesImpl(process.env, {
    deep: options.deep,
  });
  if (extraServices.length === 0) {
    return;
  }

  noteImpl(
    extraServices.map((svc) => `- ${svc.label} (${svc.scope}, ${svc.detail})`).join("\n"),
    "Other gateway-like services detected",
  );

  const legacyServices = extraServices.filter((svc) => svc.legacy === true);
  if (legacyServices.length > 0) {
    const shouldRemove = await prompter.confirmRuntimeRepair({
      message: "Remove legacy gateway services now?",
      initialValue: true,
    });
    if (shouldRemove) {
      const removed: string[] = [];
      const { darwinUserServices, linuxUserServices, failed } =
        classifyLegacyServices(legacyServices);

      if (darwinUserServices.length > 0) {
        const result = await cleanupLegacyDarwinServices(darwinUserServices);
        removed.push(...result.removed);
        failed.push(...result.failed);
      }

      if (linuxUserServices.length > 0) {
        const result = await cleanupLegacyLinuxUserServices(
          linuxUserServices,
          runtime,
          uninstallLegacySystemdUnitsImpl,
        );
        removed.push(...result.removed);
        failed.push(...result.failed);
      }

      if (removed.length > 0) {
        noteImpl(removed.map((line) => `- ${line}`).join("\n"), "Legacy gateway removed");
      }
      if (failed.length > 0) {
        noteImpl(failed.map((line) => `- ${line}`).join("\n"), "Legacy gateway cleanup skipped");
      }
      if (removed.length > 0) {
        runtime.log("Legacy gateway services removed. Installing OpenClaw gateway next.");
      }
    }
  }

  const cleanupHints = renderGatewayServiceCleanupHintsImpl();
  if (cleanupHints.length > 0) {
    noteImpl(cleanupHints.map((hint) => `- ${hint}`).join("\n"), "Cleanup hints");
  }

  noteImpl(
    [
      "Recommendation: run a single gateway per machine for most setups.",
      "One gateway supports multiple agents.",
      "If you need multiple gateways (e.g., a rescue bot on the same host), isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host).",
    ].join("\n"),
    "Gateway recommendation",
  );
}

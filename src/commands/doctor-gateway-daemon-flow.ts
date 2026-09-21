import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayPort } from "../config/config.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveNodeLaunchAgentLabel,
} from "../daemon/constants.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import {
  isLaunchAgentListed,
  isLaunchAgentLoaded,
  launchAgentPlistExists,
  repairLaunchAgentBootstrap,
} from "../daemon/launchd.js";
import { describeGatewayServiceRestart, resolveGatewayService } from "../daemon/service.js";
import { renderSystemdUnavailableHints } from "../daemon/systemd-hints.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import { isWSL } from "../infra/wsl.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { sleep } from "../utils.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "./daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import { buildGatewayRuntimeHints, formatGatewayRuntimeSummary } from "./doctor-format.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { healthCommand } from "./health.js";

export type DoctorGatewayDaemonFlowDeps = {
  resolveGatewayService?: typeof resolveGatewayService;
  resolveGatewayPort?: typeof resolveGatewayPort;
  readLastGatewayErrorLine?: typeof readLastGatewayErrorLine;
  note?: typeof note;
  sleep?: typeof sleep;
  healthCommand?: typeof healthCommand;
  inspectPortUsage?: typeof inspectPortUsage;
  formatPortDiagnostics?: typeof formatPortDiagnostics;
  isSystemdUserServiceAvailable?: typeof isSystemdUserServiceAvailable;
  isWSL?: typeof isWSL;
  renderSystemdUnavailableHints?: typeof renderSystemdUnavailableHints;
  buildGatewayInstallPlan?: typeof buildGatewayInstallPlan;
  gatewayInstallErrorHint?: typeof gatewayInstallErrorHint;
  resolveGatewayInstallToken?: typeof resolveGatewayInstallToken;
  resolveGatewayLaunchAgentLabel?: typeof resolveGatewayLaunchAgentLabel;
  resolveNodeLaunchAgentLabel?: typeof resolveNodeLaunchAgentLabel;
  isLaunchAgentListed?: typeof isLaunchAgentListed;
  isLaunchAgentLoaded?: typeof isLaunchAgentLoaded;
  launchAgentPlistExists?: typeof launchAgentPlistExists;
  repairLaunchAgentBootstrap?: typeof repairLaunchAgentBootstrap;
  formatGatewayRuntimeSummary?: typeof formatGatewayRuntimeSummary;
  buildGatewayRuntimeHints?: typeof buildGatewayRuntimeHints;
};

async function maybeRepairLaunchAgentBootstrap(params: {
  env: Record<string, string | undefined>;
  title: string;
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
  isLaunchAgentListed: typeof isLaunchAgentListed;
  isLaunchAgentLoaded: typeof isLaunchAgentLoaded;
  launchAgentPlistExists: typeof launchAgentPlistExists;
  repairLaunchAgentBootstrap: typeof repairLaunchAgentBootstrap;
}): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  const listed = await params.isLaunchAgentListed({ env: params.env });
  if (!listed) {
    return false;
  }

  const loaded = await params.isLaunchAgentLoaded({ env: params.env });
  if (loaded) {
    return false;
  }

  const plistExists = await params.launchAgentPlistExists(params.env);
  if (!plistExists) {
    return false;
  }

  note("LaunchAgent is listed but not loaded in launchd.", `${params.title} LaunchAgent`);

  const shouldFix = await params.prompter.confirmRuntimeRepair({
    message: `Repair ${params.title} LaunchAgent bootstrap now?`,
    initialValue: true,
  });
  if (!shouldFix) {
    return false;
  }

  params.runtime.log(`Bootstrapping ${params.title} LaunchAgent...`);
  const repair = await params.repairLaunchAgentBootstrap({ env: params.env });
  if (!repair.ok) {
    params.runtime.error(
      `${params.title} LaunchAgent bootstrap failed: ${repair.detail ?? "unknown error"}`,
    );
    return false;
  }

  const verified = await params.isLaunchAgentLoaded({ env: params.env });
  if (!verified) {
    params.runtime.error(`${params.title} LaunchAgent still not loaded after repair.`);
    return false;
  }

  note(`${params.title} LaunchAgent repaired.`, `${params.title} LaunchAgent`);
  return true;
}

export async function maybeRepairGatewayDaemon(
  params: {
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
    prompter: DoctorPrompter;
    options: DoctorOptions;
    gatewayDetailsMessage: string;
    healthOk: boolean;
  },
  deps: DoctorGatewayDaemonFlowDeps = {},
) {
  const resolveGatewayServiceImpl = deps.resolveGatewayService ?? resolveGatewayService;
  const resolveGatewayPortImpl = deps.resolveGatewayPort ?? resolveGatewayPort;
  const readLastGatewayErrorLineImpl = deps.readLastGatewayErrorLine ?? readLastGatewayErrorLine;
  const noteImpl = deps.note ?? note;
  const sleepImpl = deps.sleep ?? sleep;
  const healthCommandImpl = deps.healthCommand ?? healthCommand;
  const inspectPortUsageImpl = deps.inspectPortUsage ?? inspectPortUsage;
  const formatPortDiagnosticsImpl = deps.formatPortDiagnostics ?? formatPortDiagnostics;
  const isSystemdUserServiceAvailableImpl =
    deps.isSystemdUserServiceAvailable ?? isSystemdUserServiceAvailable;
  const isWSLImpl = deps.isWSL ?? isWSL;
  const renderSystemdUnavailableHintsImpl =
    deps.renderSystemdUnavailableHints ?? renderSystemdUnavailableHints;
  const buildGatewayInstallPlanImpl = deps.buildGatewayInstallPlan ?? buildGatewayInstallPlan;
  const gatewayInstallErrorHintImpl = deps.gatewayInstallErrorHint ?? gatewayInstallErrorHint;
  const resolveGatewayInstallTokenImpl =
    deps.resolveGatewayInstallToken ?? resolveGatewayInstallToken;
  const resolveGatewayLaunchAgentLabelImpl =
    deps.resolveGatewayLaunchAgentLabel ?? resolveGatewayLaunchAgentLabel;
  const resolveNodeLaunchAgentLabelImpl =
    deps.resolveNodeLaunchAgentLabel ?? resolveNodeLaunchAgentLabel;
  const isLaunchAgentListedImpl = deps.isLaunchAgentListed ?? isLaunchAgentListed;
  const isLaunchAgentLoadedImpl = deps.isLaunchAgentLoaded ?? isLaunchAgentLoaded;
  const launchAgentPlistExistsImpl = deps.launchAgentPlistExists ?? launchAgentPlistExists;
  const repairLaunchAgentBootstrapImpl =
    deps.repairLaunchAgentBootstrap ?? repairLaunchAgentBootstrap;
  const formatGatewayRuntimeSummaryImpl =
    deps.formatGatewayRuntimeSummary ?? formatGatewayRuntimeSummary;
  const buildGatewayRuntimeHintsImpl = deps.buildGatewayRuntimeHints ?? buildGatewayRuntimeHints;
  if (params.healthOk) {
    return;
  }

  const service = resolveGatewayServiceImpl();
  // systemd can throw in containers/WSL; treat as "not loaded" and fall back to hints.
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  let serviceRuntime: Awaited<ReturnType<typeof service.readRuntime>> | undefined;
  if (loaded) {
    serviceRuntime = await service.readRuntime(process.env).catch(() => undefined);
  }

  if (process.platform === "darwin" && params.cfg.gateway?.mode !== "remote") {
    const gatewayRepaired = await maybeRepairLaunchAgentBootstrap({
      env: process.env,
      title: "Gateway",
      runtime: params.runtime,
      prompter: params.prompter,
      isLaunchAgentListed: isLaunchAgentListedImpl,
      isLaunchAgentLoaded: isLaunchAgentLoadedImpl,
      launchAgentPlistExists: launchAgentPlistExistsImpl,
      repairLaunchAgentBootstrap: repairLaunchAgentBootstrapImpl,
    });
    await maybeRepairLaunchAgentBootstrap({
      env: {
        ...process.env,
        DENNOU_LAUNCHD_LABEL: resolveNodeLaunchAgentLabelImpl(),
      },
      title: "Node",
      runtime: params.runtime,
      prompter: params.prompter,
      isLaunchAgentListed: isLaunchAgentListedImpl,
      isLaunchAgentLoaded: isLaunchAgentLoadedImpl,
      launchAgentPlistExists: launchAgentPlistExistsImpl,
      repairLaunchAgentBootstrap: repairLaunchAgentBootstrapImpl,
    });
    if (gatewayRepaired) {
      loaded = await service.isLoaded({ env: process.env });
      if (loaded) {
        serviceRuntime = await service.readRuntime(process.env).catch(() => undefined);
      }
    }
  }

  if (params.cfg.gateway?.mode !== "remote") {
    const port = resolveGatewayPortImpl(params.cfg, process.env);
    const diagnostics = await inspectPortUsageImpl(port);
    if (diagnostics.status === "busy") {
      noteImpl(formatPortDiagnosticsImpl(diagnostics).join("\n"), "Gateway port");
    } else if (loaded && serviceRuntime?.status === "running") {
      const lastError = await readLastGatewayErrorLineImpl(process.env);
      if (lastError) {
        noteImpl(`Last gateway error: ${lastError}`, "Gateway");
      }
    }
  }

  if (!loaded) {
    if (process.platform === "linux") {
      const systemdAvailable = await isSystemdUserServiceAvailableImpl().catch(() => false);
      if (!systemdAvailable) {
        const wsl = await isWSLImpl();
        noteImpl(
          renderSystemdUnavailableHintsImpl({ wsl, kind: "generic_unavailable" }).join("\n"),
          "Gateway",
        );
        return;
      }
    }
    noteImpl("Gateway service not installed.", "Gateway");
    if (params.cfg.gateway?.mode !== "remote") {
      const install = await params.prompter.confirmRuntimeRepair({
        message: "Install gateway service now?",
        initialValue: true,
      });
      if (install) {
        const daemonRuntime = await params.prompter.select<GatewayDaemonRuntime>(
          {
            message: "Gateway service runtime",
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME,
          },
          DEFAULT_GATEWAY_DAEMON_RUNTIME,
        );
        const tokenResolution = await resolveGatewayInstallTokenImpl({
          config: params.cfg,
          env: process.env,
        });
        for (const warning of tokenResolution.warnings) {
          noteImpl(warning, "Gateway");
        }
        if (tokenResolution.unavailableReason) {
          noteImpl(
            [
              "Gateway service install aborted.",
              tokenResolution.unavailableReason,
              "Fix gateway auth config/token input and rerun doctor.",
            ].join("\n"),
            "Gateway",
          );
          return;
        }
        const port = resolveGatewayPortImpl(params.cfg, process.env);
        const { programArguments, workingDirectory, environment } =
          await buildGatewayInstallPlanImpl({
            env: process.env,
            port,
            runtime: daemonRuntime,
            warn: (message, title) => noteImpl(message, title),
            config: params.cfg,
          });
        try {
          await service.install({
            env: process.env,
            stdout: process.stdout,
            programArguments,
            workingDirectory,
            environment,
          });
        } catch (err) {
          noteImpl(`Gateway service install failed: ${String(err)}`, "Gateway");
          noteImpl(gatewayInstallErrorHintImpl(), "Gateway");
        }
      }
    }
    return;
  }

  const summary = formatGatewayRuntimeSummaryImpl(serviceRuntime);
  const hints = buildGatewayRuntimeHintsImpl(serviceRuntime, {
    platform: process.platform,
    env: process.env,
  });
  if (summary || hints.length > 0) {
    const lines: string[] = [];
    if (summary) {
      lines.push(`Runtime: ${summary}`);
    }
    lines.push(...hints);
    noteImpl(lines.join("\n"), "Gateway");
  }

  if (serviceRuntime?.status !== "running") {
    const start = await params.prompter.confirmRuntimeRepair({
      message: "Start gateway service now?",
      initialValue: true,
    });
    if (start) {
      const restartResult = await service.restart({
        env: process.env,
        stdout: process.stdout,
      });
      const restartStatus = describeGatewayServiceRestart("Gateway", restartResult);
      if (!restartStatus.scheduled) {
        await sleepImpl(1500);
      } else {
        noteImpl(restartStatus.message, "Gateway");
      }
    }
  }

  if (process.platform === "darwin") {
    const label = resolveGatewayLaunchAgentLabelImpl(process.env.DENNOU_PROFILE);
    noteImpl(
      `LaunchAgent loaded; stopping requires "${formatCliCommand("openclaw gateway stop")}" or launchctl bootout gui/$UID/${label}.`,
      "Gateway",
    );
  }

  if (serviceRuntime?.status === "running") {
    const restart = await params.prompter.confirmRuntimeRepair({
      message: "Restart gateway service now?",
      initialValue: true,
    });
    if (restart) {
      const restartResult = await service.restart({
        env: process.env,
        stdout: process.stdout,
      });
      const restartStatus = describeGatewayServiceRestart("Gateway", restartResult);
      if (restartStatus.scheduled) {
        noteImpl(restartStatus.message, "Gateway");
        return;
      }
      await sleepImpl(1500);
      try {
        await healthCommandImpl({ json: false, timeoutMs: 10_000 }, params.runtime);
      } catch (err) {
        const message = String(err);
        if (message.includes("gateway closed")) {
          noteImpl("Gateway not running.", "Gateway");
          noteImpl(params.gatewayDetailsMessage, "Gateway connection");
        } else {
          params.runtime.error(formatHealthCheckFailure(err));
        }
      }
    }
  }
}

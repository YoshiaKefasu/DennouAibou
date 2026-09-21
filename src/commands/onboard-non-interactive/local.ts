// Note: daemon/diagnostics, daemon/service, health, local/auth-choice, and local/daemon-install were dynamic imports; kept static intentionally (jiti race avoidance).
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceConfigFile, resolveGatewayPort } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { readLastGatewayErrorLine } from "../../daemon/diagnostics.js";
import { resolveGatewayService } from "../../daemon/service.js";
import type { RuntimeEnv } from "../../runtime.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME } from "../daemon-runtime.js";
import { healthCommand } from "../health.js";
import { applyLocalSetupWorkspaceConfig } from "../onboard-config.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  resolveControlUiLinks,
  waitForGatewayReachable,
} from "../onboard-helpers.js";
import type { OnboardOptions } from "../onboard-types.js";
import {
  inferAuthChoiceFromFlags,
  type AuthChoiceInference,
} from "./local/auth-choice-inference.js";
import { applyNonInteractiveAuthChoice } from "./local/auth-choice.js";
import { installGatewayDaemonNonInteractive } from "./local/daemon-install.js";
import { applyNonInteractiveGatewayConfig } from "./local/gateway-config.js";
import {
  type GatewayHealthFailureDiagnostics,
  logNonInteractiveOnboardingFailure,
  logNonInteractiveOnboardingJson,
} from "./local/output.js";
import { applyNonInteractiveSkillsConfig } from "./local/skills-config.js";
import { resolveNonInteractiveWorkspaceDir } from "./local/workspace.js";

const INSTALL_DAEMON_HEALTH_DEADLINE_MS = 45_000;
const ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS = 15_000;
const INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS = 10_000;
const WINDOWS_INSTALL_DAEMON_HEALTH_DEADLINE_MS = 90_000;
const WINDOWS_INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS = 15_000;
const INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS = 10_000;
const WINDOWS_INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS = 30_000;

export type NonInteractiveLocalSetupDeps = {
  replaceConfigFile?: typeof replaceConfigFile;
  resolveGatewayPort?: typeof resolveGatewayPort;
  logConfigUpdated?: typeof logConfigUpdated;
  applyWizardMetadata?: typeof applyWizardMetadata;
  ensureWorkspaceAndSessions?: typeof ensureWorkspaceAndSessions;
  resolveControlUiLinks?: typeof resolveControlUiLinks;
  waitForGatewayReachable?: typeof waitForGatewayReachable;
  installGatewayDaemonNonInteractive?: typeof installGatewayDaemonNonInteractive;
  healthCommand?: typeof healthCommand;
  resolveGatewayService?: typeof resolveGatewayService;
  readLastGatewayErrorLine?: typeof readLastGatewayErrorLine;
  applyNonInteractiveAuthChoice?: typeof applyNonInteractiveAuthChoice;
  inferAuthChoiceFromFlags?: typeof inferAuthChoiceFromFlags;
};

function resolveInstallDaemonGatewayHealthTiming(): {
  deadlineMs: number;
  probeTimeoutMs: number;
  healthCommandTimeoutMs: number;
} {
  if (process.platform === "win32") {
    return {
      deadlineMs: WINDOWS_INSTALL_DAEMON_HEALTH_DEADLINE_MS,
      probeTimeoutMs: WINDOWS_INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS,
      healthCommandTimeoutMs: WINDOWS_INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS,
    };
  }
  return {
    deadlineMs: INSTALL_DAEMON_HEALTH_DEADLINE_MS,
    probeTimeoutMs: INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS,
    healthCommandTimeoutMs: INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS,
  };
}

async function collectGatewayHealthFailureDiagnostics(
  deps: NonInteractiveLocalSetupDeps,
): Promise<GatewayHealthFailureDiagnostics | undefined> {
  const diagnostics: GatewayHealthFailureDiagnostics = {};

  try {
    const service = (deps.resolveGatewayService ?? resolveGatewayService)();
    const env = process.env as Record<string, string | undefined>;
    const [loaded, runtime] = await Promise.all([
      service.isLoaded({ env }).catch(() => false),
      service.readRuntime(env).catch(() => undefined),
    ]);
    diagnostics.service = {
      label: service.label,
      loaded,
      loadedText: service.loadedText,
      runtimeStatus: runtime?.status,
      state: runtime?.state,
      pid: runtime?.pid,
      lastExitStatus: runtime?.lastExitStatus,
      lastExitReason: runtime?.lastExitReason,
    };
  } catch (err) {
    diagnostics.inspectError = `service diagnostics failed: ${String(err)}`;
  }

  try {
    const readLastGatewayErrorLineImpl = deps.readLastGatewayErrorLine ?? readLastGatewayErrorLine;
    diagnostics.lastGatewayError = (await readLastGatewayErrorLineImpl(process.env)) ?? undefined;
  } catch (err) {
    diagnostics.inspectError = diagnostics.inspectError
      ? `${diagnostics.inspectError}; log diagnostics failed: ${String(err)}`
      : `log diagnostics failed: ${String(err)}`;
  }

  return diagnostics.service || diagnostics.lastGatewayError || diagnostics.inspectError
    ? diagnostics
    : undefined;
}

export async function runNonInteractiveLocalSetup(
  params: {
    opts: OnboardOptions;
    runtime: RuntimeEnv;
    baseConfig: OpenClawConfig;
    baseHash?: string;
  },
  deps: NonInteractiveLocalSetupDeps = {},
) {
  const { opts, runtime, baseConfig, baseHash } = params;
  const replaceConfigFileImpl = deps.replaceConfigFile ?? replaceConfigFile;
  const resolveGatewayPortImpl = deps.resolveGatewayPort ?? resolveGatewayPort;
  const logConfigUpdatedImpl = deps.logConfigUpdated ?? logConfigUpdated;
  const applyWizardMetadataImpl = deps.applyWizardMetadata ?? applyWizardMetadata;
  const ensureWorkspaceAndSessionsImpl =
    deps.ensureWorkspaceAndSessions ?? ensureWorkspaceAndSessions;
  const resolveControlUiLinksImpl = deps.resolveControlUiLinks ?? resolveControlUiLinks;
  const waitForGatewayReachableImpl = deps.waitForGatewayReachable ?? waitForGatewayReachable;
  const installGatewayDaemonNonInteractiveImpl =
    deps.installGatewayDaemonNonInteractive ?? installGatewayDaemonNonInteractive;
  const healthCommandImpl = deps.healthCommand ?? healthCommand;
  const inferAuthChoiceFromFlagsImpl = deps.inferAuthChoiceFromFlags ?? inferAuthChoiceFromFlags;
  const mode = "local" as const;

  const workspaceDir = resolveNonInteractiveWorkspaceDir({
    opts,
    baseConfig,
    defaultWorkspaceDir: DEFAULT_WORKSPACE,
  });

  let nextConfig: OpenClawConfig = applyLocalSetupWorkspaceConfig(baseConfig, workspaceDir);

  const inferredAuthChoice: AuthChoiceInference = inferAuthChoiceFromFlagsImpl(opts, {
    config: nextConfig,
    workspaceDir,
    env: process.env,
  });
  if (!opts.authChoice && inferredAuthChoice.matches.length > 1) {
    runtime.error(
      [
        "Multiple API key flags were provided for non-interactive setup.",
        "Use a single provider flag or pass --auth-choice explicitly.",
        `Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }
  const authChoice = opts.authChoice ?? inferredAuthChoice.choice ?? "skip";
  if (authChoice !== "skip") {
    const nextConfigAfterAuth = await (
      deps.applyNonInteractiveAuthChoice ?? applyNonInteractiveAuthChoice
    )({
      nextConfig,
      authChoice,
      opts,
      runtime,
      baseConfig,
    });
    if (!nextConfigAfterAuth) {
      return;
    }
    nextConfig = nextConfigAfterAuth;
  }

  const gatewayBasePort = resolveGatewayPortImpl(baseConfig);
  const gatewayResult = applyNonInteractiveGatewayConfig({
    nextConfig,
    opts,
    runtime,
    defaultPort: gatewayBasePort,
  });
  if (!gatewayResult) {
    return;
  }
  nextConfig = gatewayResult.nextConfig;

  nextConfig = applyNonInteractiveSkillsConfig({ nextConfig, opts, runtime });

  nextConfig = applyWizardMetadataImpl(nextConfig, {
    command: "onboard",
    mode,
  });
  await replaceConfigFileImpl({
    nextConfig,
    ...(baseHash !== undefined ? { baseHash } : {}),
  });
  logConfigUpdatedImpl(runtime);

  await ensureWorkspaceAndSessionsImpl(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  let daemonInstallStatus:
    | {
        requested: boolean;
        installed: boolean;
        skippedReason?: "systemd-user-unavailable";
      }
    | undefined;
  if (opts.installDaemon) {
    const daemonInstall = await installGatewayDaemonNonInteractiveImpl({
      nextConfig,
      opts,
      runtime,
      port: gatewayResult.port,
    });
    daemonInstallStatus = daemonInstall.installed
      ? {
          requested: true,
          installed: true,
        }
      : {
          requested: true,
          installed: false,
          skippedReason: daemonInstall.skippedReason,
        };
    if (!daemonInstall.installed && !opts.skipHealth) {
      logNonInteractiveOnboardingFailure({
        opts,
        runtime,
        mode,
        phase: "daemon-install",
        message:
          daemonInstall.skippedReason === "systemd-user-unavailable"
            ? "Gateway service install is unavailable because systemd user services are not reachable in this Linux session."
            : "Gateway service install did not complete successfully.",
        installDaemon: true,
        daemonInstall: {
          requested: true,
          installed: false,
          skippedReason: daemonInstall.skippedReason,
        },
        daemonRuntime: daemonRuntimeRaw,
        hints:
          daemonInstall.skippedReason === "systemd-user-unavailable"
            ? [
                "Fix: rerun without `--install-daemon` for one-shot setup, or enable a working user-systemd session and retry.",
                "If your auth profile uses env-backed refs, keep those env vars set in the shell that runs `openclaw gateway run` or `openclaw agent --local`.",
              ]
            : [`Run \`${formatCliCommand("openclaw gateway status --deep")}\` for more detail.`],
      });
      runtime.exit(1);
      return;
    }
  }

  if (!opts.skipHealth) {
    const links = resolveControlUiLinksImpl({
      bind: gatewayResult.bind as "auto" | "lan" | "loopback" | "custom" | "tailnet",
      port: gatewayResult.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
    });
    const installDaemonGatewayHealthTiming = resolveInstallDaemonGatewayHealthTiming();
    const probe = await waitForGatewayReachableImpl({
      url: links.wsUrl,
      token: gatewayResult.gatewayToken,
      deadlineMs: opts.installDaemon
        ? installDaemonGatewayHealthTiming.deadlineMs
        : ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS,
      probeTimeoutMs: opts.installDaemon
        ? installDaemonGatewayHealthTiming.probeTimeoutMs
        : undefined,
    });
    if (!probe.ok) {
      const diagnostics = opts.installDaemon
        ? await collectGatewayHealthFailureDiagnostics(deps)
        : undefined;
      logNonInteractiveOnboardingFailure({
        opts,
        runtime,
        mode,
        phase: "gateway-health",
        message: `Gateway did not become reachable at ${links.wsUrl}.`,
        detail: probe.detail,
        gateway: {
          wsUrl: links.wsUrl,
          httpUrl: links.httpUrl,
        },
        installDaemon: Boolean(opts.installDaemon),
        daemonInstall: daemonInstallStatus,
        daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : undefined,
        diagnostics,
        hints: !opts.installDaemon
          ? [
              "Non-interactive local setup only waits for an already-running gateway unless you pass --install-daemon.",
              `Fix: start \`${formatCliCommand("openclaw gateway run")}\`, re-run with \`--install-daemon\`, or use \`--skip-health\`.`,
              process.platform === "win32"
                ? "Native Windows managed gateway install tries Scheduled Tasks first and falls back to a per-user Startup-folder login item when task creation is denied."
                : undefined,
            ].filter((value): value is string => Boolean(value))
          : [`Run \`${formatCliCommand("openclaw gateway status --deep")}\` for more detail.`],
      });
      runtime.exit(1);
      return;
    }
    await healthCommandImpl(
      {
        json: false,
        timeoutMs: opts.installDaemon
          ? installDaemonGatewayHealthTiming.healthCommandTimeoutMs
          : 10_000,
      },
      runtime,
    );
  }

  logNonInteractiveOnboardingJson({
    opts,
    runtime,
    mode,
    workspaceDir,
    authChoice,
    gateway: {
      port: gatewayResult.port,
      bind: gatewayResult.bind,
      authMode: gatewayResult.authMode,
      tailscaleMode: gatewayResult.tailscaleMode,
    },
    installDaemon: Boolean(opts.installDaemon),
    daemonInstall: daemonInstallStatus,
    daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : undefined,
    skipSkills: Boolean(opts.skipSkills),
    skipHealth: Boolean(opts.skipHealth),
  });

  if (!opts.json) {
    runtime.log(
      `Tip: run \`${formatCliCommand("openclaw configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.openclaw.ai/tools/web`,
    );
  }
}

import { withProgress } from "../cli/progress.js";
import { readBestEffortConfig, resolveGatewayPort } from "../config/config.js";
import { resolveWideAreaDiscoveryDomain } from "../infra/widearea-dns.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRich } from "../terminal/theme.js";
import { inferSshTargetFromRemoteUrl, resolveSshTarget } from "./gateway-status/discovery.js";
import {
  buildNetworkHints,
  parseTimeoutMs,
  resolveTargets,
  sanitizeSshTarget,
} from "./gateway-status/helpers.js";
import {
  buildGatewayStatusWarnings,
  pickPrimaryProbedTarget,
  writeGatewayStatusJson,
  writeGatewayStatusText,
} from "./gateway-status/output.js";
import { runGatewayStatusProbePass } from "./gateway-status/probe-run.js";

let sshConfigModulePromise: Promise<typeof import("../infra/ssh-config.js")> | undefined;
let sshTunnelModulePromise: Promise<typeof import("../infra/ssh-tunnel.js")> | undefined;

function loadSshConfigModule() {
  sshConfigModulePromise ??= import("../infra/ssh-config.js");
  return sshConfigModulePromise;
}

function loadSshTunnelModule() {
  sshTunnelModulePromise ??= import("../infra/ssh-tunnel.js");
  return sshTunnelModulePromise;
}

export type GatewayStatusDeps = {
  readBestEffortConfig?: typeof readBestEffortConfig;
  resolveGatewayPort?: typeof resolveGatewayPort;
  discoverGatewayBeaconsFn?: typeof import("../infra/bonjour-discovery.js").discoverGatewayBeacons;
  pickPrimaryTailnetIPv4?: () => string | undefined;
  probeGatewayFn?: typeof import("../gateway/probe.js").probeGateway;
  resolveSshConfigFn?: typeof import("../infra/ssh-config.js").resolveSshConfig;
  parseSshTargetFn?: typeof import("../infra/ssh-tunnel.js").parseSshTarget;
  startSshPortForwardFn?: typeof import("../infra/ssh-tunnel.js").startSshPortForward;
};

export type GatewayStatusCommandOptions = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: unknown;
  json?: boolean;
  ssh?: string;
  sshIdentity?: string;
  sshAuto?: boolean;
};

export async function gatewayStatusCommand(
  opts: GatewayStatusCommandOptions,
  runtime: RuntimeEnv,
  deps: GatewayStatusDeps = {},
) {
  const startedAt = Date.now();
  const cfg = await (deps.readBestEffortConfig ?? readBestEffortConfig)();
  const rich = isRich() && opts.json !== true;
  const overallTimeoutMs = parseTimeoutMs(opts.timeout, 3000);
  const wideAreaDomain = resolveWideAreaDiscoveryDomain({
    configDomain: cfg.discovery?.wideArea?.domain,
  });
  const resolvePort = deps.resolveGatewayPort ?? resolveGatewayPort;
  const baseTargets = resolveTargets(cfg, opts.url, { resolveGatewayPort: resolvePort });
  const network = buildNetworkHints(cfg, {
    resolveGatewayPort: resolvePort,
    pickPrimaryTailnetIPv4: deps.pickPrimaryTailnetIPv4,
  });
  const remotePort = resolvePort(cfg);
  const discoveryTimeoutMs = Math.min(1200, overallTimeoutMs);

  let sshTarget = sanitizeSshTarget(opts.ssh) ?? sanitizeSshTarget(cfg.gateway?.remote?.sshTarget);
  let sshIdentity =
    sanitizeSshTarget(opts.sshIdentity) ?? sanitizeSshTarget(cfg.gateway?.remote?.sshIdentity);

  if (!sshTarget) {
    sshTarget = inferSshTargetFromRemoteUrl(cfg.gateway?.remote?.url);
  }

  const loadSshConfig = deps.resolveSshConfigFn
    ? async () => ({
        ...(await loadSshConfigModule()),
        resolveSshConfig: deps.resolveSshConfigFn!,
      })
    : loadSshConfigModule;
  const loadSshTunnel =
    deps.startSshPortForwardFn || deps.parseSshTargetFn
      ? async () => ({
          ...(await loadSshTunnelModule()),
          ...(deps.parseSshTargetFn ? { parseSshTarget: deps.parseSshTargetFn } : {}),
          ...(deps.startSshPortForwardFn
            ? { startSshPortForward: deps.startSshPortForwardFn }
            : {}),
        })
      : loadSshTunnelModule;

  if (sshTarget) {
    const resolved = await resolveSshTarget({
      rawTarget: sshTarget,
      identity: sshIdentity,
      overallTimeoutMs,
      loadSshConfigModule: loadSshConfig,
      loadSshTunnelModule: loadSshTunnel,
    });
    if (resolved) {
      sshTarget = resolved.target;
      if (!sshIdentity && resolved.identity) {
        sshIdentity = resolved.identity;
      }
    }
  }

  const probePass = await withProgress(
    {
      label: "Inspecting gateways…",
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await runGatewayStatusProbePass({
        cfg,
        opts,
        overallTimeoutMs,
        discoveryTimeoutMs,
        wideAreaDomain,
        baseTargets,
        remotePort,
        sshTarget,
        sshIdentity,
        loadSshTunnelModule: loadSshTunnel,
        probeGatewayFn: deps.probeGatewayFn,
        discoverGatewayBeaconsFn: deps.discoverGatewayBeaconsFn,
      }),
  );

  const warnings = buildGatewayStatusWarnings({
    probed: probePass.probed,
    sshTarget: probePass.sshTarget,
    sshTunnelStarted: probePass.sshTunnelStarted,
    sshTunnelError: probePass.sshTunnelError,
  });
  const primary = pickPrimaryProbedTarget(probePass.probed);

  if (opts.json) {
    writeGatewayStatusJson({
      runtime,
      startedAt,
      overallTimeoutMs,
      discoveryTimeoutMs,
      network,
      discovery: probePass.discovery,
      probed: probePass.probed,
      warnings,
      primaryTargetId: primary?.target.id ?? null,
    });
    return;
  }

  writeGatewayStatusText({
    runtime,
    rich,
    overallTimeoutMs,
    wideAreaDomain,
    discovery: probePass.discovery,
    probed: probePass.probed,
    warnings,
  });
}

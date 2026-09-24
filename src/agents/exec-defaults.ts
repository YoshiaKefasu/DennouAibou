import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { ExecToolConfig } from "../config/types.tools.js";
import type { ExecAsk, ExecHost, ExecSecurity, ExecTarget } from "../infra/exec-approvals.js";
import { resolveAgentConfig, resolveSessionAgentId } from "./agent-scope.js";
import { isRequestedExecTargetAllowed, resolveExecTarget } from "./bash-tools.exec-runtime.js";

type ResolvedExecConfig = {
  host?: ExecTarget;
  security?: ExecSecurity;
  ask?: ExecAsk;
  node?: string;
};

function resolveExecConfigState(params: {
  cfg?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionKey?: string;
}): {
  cfg: OpenClawConfig;
  host: ExecTarget;
  agentExec?: ExecToolConfig;
  globalExec?: ExecToolConfig;
} {
  const cfg = params.cfg ?? {};
  const resolvedAgentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: cfg,
    });
  const globalExec = cfg.tools?.exec;
  const agentExec = resolvedAgentId
    ? resolveAgentConfig(cfg, resolvedAgentId)?.tools?.exec
    : undefined;
  // Note: ExecToolConfig.host accepts legacy "sandbox" (zod-level compat),
  // but runtime resolution stays ExecTarget-only (fail-closed downstream).
  const normalizeResolvedHost = (value: unknown): ExecTarget | undefined =>
    value === "auto" || value === "gateway" || value === "node" ? value : undefined;
  const host =
    (params.sessionEntry?.execHost as ExecTarget | undefined) ??
    normalizeResolvedHost(agentExec?.host) ??
    normalizeResolvedHost(globalExec?.host) ??
    "auto";
  return {
    cfg,
    host,
    agentExec,
    globalExec,
  };
}

export function canExecRequestNode(params: {
  cfg?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionKey?: string;
}): boolean {
  const { host } = resolveExecConfigState(params);
  return isRequestedExecTargetAllowed({
    configuredTarget: host,
    requestedTarget: "node",
  });
}

export function resolveExecDefaults(params: {
  cfg?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionKey?: string;
}): {
  host: ExecTarget;
  effectiveHost: ExecHost;
  security: ExecSecurity;
  ask: ExecAsk;
  node?: string;
  canRequestNode: boolean;
} {
  const { cfg, host, agentExec, globalExec } = resolveExecConfigState(params);
  const resolved = resolveExecTarget({
    configuredTarget: host,
    elevatedRequested: false,
  });
  return {
    host,
    effectiveHost: resolved.effectiveHost,
    security:
      (params.sessionEntry?.execSecurity as ExecSecurity | undefined) ??
      agentExec?.security ??
      globalExec?.security ??
      // Note: exec-approval DEBLOAT — default to full (was deny).
      // Explicit config still wins; only the unset default changed.
      "full",
    ask:
      (params.sessionEntry?.execAsk as ExecAsk | undefined) ??
      agentExec?.ask ??
      globalExec?.ask ??
      "on-miss",
    node: params.sessionEntry?.execNode ?? agentExec?.node ?? globalExec?.node,
    canRequestNode: isRequestedExecTargetAllowed({
      configuredTarget: host,
      requestedTarget: "node",
    }),
  };
}

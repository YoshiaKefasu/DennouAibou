import * as net from "node:net";
import {
  Agent,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { isWSL2Sync } from "../wsl.js";
import { hasEnvHttpProxyConfigured } from "./proxy-env.js";

export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;

const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;

let lastAppliedTimeoutKey: string | null = null;
let lastAppliedProxyBootstrap = false;

type DispatcherKind = "agent" | "env-proxy" | "unsupported";

/**
 * Injectable seams for tests. Every entry defaults to the real undici / Node
 * implementation so production callers keep the existing behaviour.
 */
export type UndiciDispatcherDeps = {
  Agent?: typeof Agent;
  EnvHttpProxyAgent?: typeof EnvHttpProxyAgent;
  getGlobalDispatcher?: () => Dispatcher;
  setGlobalDispatcher?: (dispatcher: Dispatcher) => void;
  getDefaultAutoSelectFamily?: () => boolean | undefined;
  isWSL2Sync?: () => boolean;
  hasEnvHttpProxyConfigured?: (protocol?: "http" | "https") => boolean;
};

type ResolvedUndiciDispatcherDeps = {
  AgentCtor: typeof Agent;
  EnvHttpProxyAgentCtor: typeof EnvHttpProxyAgent;
  getGlobalDispatcher: () => Dispatcher;
  setGlobalDispatcher: (dispatcher: Dispatcher) => void;
  getDefaultAutoSelectFamily: () => boolean | undefined;
  isWSL2Sync: () => boolean;
  hasEnvHttpProxyConfigured: (protocol?: "http" | "https") => boolean;
};

function resolveUndiciDispatcherDeps(
  deps: UndiciDispatcherDeps = {},
): ResolvedUndiciDispatcherDeps {
  return {
    AgentCtor: deps.Agent ?? Agent,
    EnvHttpProxyAgentCtor: deps.EnvHttpProxyAgent ?? EnvHttpProxyAgent,
    getGlobalDispatcher: deps.getGlobalDispatcher ?? getGlobalDispatcher,
    setGlobalDispatcher: deps.setGlobalDispatcher ?? setGlobalDispatcher,
    getDefaultAutoSelectFamily: deps.getDefaultAutoSelectFamily ?? net.getDefaultAutoSelectFamily,
    isWSL2Sync: deps.isWSL2Sync ?? isWSL2Sync,
    hasEnvHttpProxyConfigured: deps.hasEnvHttpProxyConfigured ?? hasEnvHttpProxyConfigured,
  };
}

function resolveDispatcherKind(dispatcher: unknown): DispatcherKind {
  const ctorName = (dispatcher as { constructor?: { name?: string } })?.constructor?.name;
  if (typeof ctorName !== "string" || ctorName.length === 0) {
    return "unsupported";
  }
  if (ctorName.includes("EnvHttpProxyAgent")) {
    return "env-proxy";
  }
  if (ctorName.includes("ProxyAgent")) {
    return "unsupported";
  }
  if (ctorName.includes("Agent")) {
    return "agent";
  }
  return "unsupported";
}

function resolveAutoSelectFamily(deps: ResolvedUndiciDispatcherDeps): boolean | undefined {
  const getDefaultAutoSelectFamily = deps.getDefaultAutoSelectFamily;
  if (typeof getDefaultAutoSelectFamily !== "function") {
    return undefined;
  }
  try {
    const systemDefault = getDefaultAutoSelectFamily();
    // WSL2 has unstable IPv6 connectivity; disable autoSelectFamily to
    // force IPv4 connections and avoid "fetch failed" errors when reaching
    // Windows-host services (e.g. Ollama) from inside WSL2.
    if (systemDefault && deps.isWSL2Sync()) {
      return false;
    }
    return systemDefault;
  } catch {
    return undefined;
  }
}

function resolveConnectOptions(
  autoSelectFamily: boolean | undefined,
): { autoSelectFamily: boolean; autoSelectFamilyAttemptTimeout: number } | undefined {
  if (autoSelectFamily === undefined) {
    return undefined;
  }
  return {
    autoSelectFamily,
    autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
  };
}

function resolveDispatcherKey(params: {
  kind: DispatcherKind;
  timeoutMs: number;
  autoSelectFamily: boolean | undefined;
}): string {
  const autoSelectToken =
    params.autoSelectFamily === undefined ? "na" : params.autoSelectFamily ? "on" : "off";
  return `${params.kind}:${params.timeoutMs}:${autoSelectToken}`;
}

function resolveCurrentDispatcherKind(deps: ResolvedUndiciDispatcherDeps): DispatcherKind | null {
  let dispatcher: unknown;
  try {
    dispatcher = deps.getGlobalDispatcher();
  } catch {
    return null;
  }

  const currentKind = resolveDispatcherKind(dispatcher);
  return currentKind === "unsupported" ? null : currentKind;
}

export function ensureGlobalUndiciEnvProxyDispatcher(deps: UndiciDispatcherDeps = {}): void {
  const resolved = resolveUndiciDispatcherDeps(deps);
  const shouldUseEnvProxy = resolved.hasEnvHttpProxyConfigured("https");
  if (!shouldUseEnvProxy) {
    return;
  }
  if (lastAppliedProxyBootstrap) {
    if (resolveCurrentDispatcherKind(resolved) === "env-proxy") {
      return;
    }
    lastAppliedProxyBootstrap = false;
  }
  const currentKind = resolveCurrentDispatcherKind(resolved);
  if (currentKind === null) {
    return;
  }
  if (currentKind === "env-proxy") {
    lastAppliedProxyBootstrap = true;
    return;
  }
  try {
    resolved.setGlobalDispatcher(new resolved.EnvHttpProxyAgentCtor());
    lastAppliedProxyBootstrap = true;
  } catch {
    // Best-effort bootstrap only.
  }
}

export function ensureGlobalUndiciStreamTimeouts(
  opts?: { timeoutMs?: number },
  deps: UndiciDispatcherDeps = {},
): void {
  const resolved = resolveUndiciDispatcherDeps(deps);
  const timeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  const timeoutMs = Math.max(1, Math.floor(timeoutMsRaw));
  if (!Number.isFinite(timeoutMsRaw)) {
    return;
  }
  const kind = resolveCurrentDispatcherKind(resolved);
  if (kind === null) {
    return;
  }

  const autoSelectFamily = resolveAutoSelectFamily(resolved);
  const nextKey = resolveDispatcherKey({ kind, timeoutMs, autoSelectFamily });
  if (lastAppliedTimeoutKey === nextKey) {
    return;
  }

  const connect = resolveConnectOptions(autoSelectFamily);
  try {
    if (kind === "env-proxy") {
      const proxyOptions = {
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        ...(connect ? { connect } : {}),
      } as ConstructorParameters<typeof EnvHttpProxyAgent>[0];
      resolved.setGlobalDispatcher(new resolved.EnvHttpProxyAgentCtor(proxyOptions));
    } else {
      resolved.setGlobalDispatcher(
        new resolved.AgentCtor({
          bodyTimeout: timeoutMs,
          headersTimeout: timeoutMs,
          ...(connect ? { connect } : {}),
        }),
      );
    }
    lastAppliedTimeoutKey = nextKey;
  } catch {
    // Best-effort hardening only.
  }
}

export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedTimeoutKey = null;
  lastAppliedProxyBootstrap = false;
}

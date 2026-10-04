import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { requestWakeNow } from "../../infra/event-pump.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { type HookAgentDispatchPayload, type HooksConfigResolved } from "../hooks.js";
import { createHooksRequestHandler, type HookClientIpConfig } from "../server-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function resolveHookClientIpConfig(cfg: OpenClawConfig): HookClientIpConfig {
  return {
    trustedProxies: cfg.gateway?.trustedProxies,
    allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
  };
}

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  getClientIpConfig: () => HookClientIpConfig;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { getHooksConfig, getClientIpConfig, bindHost, port, logHooks } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, { sessionKey });
    if (value.mode === "now") {
      requestWakeNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const jobId = randomUUID();
    void loadConfig();

    // DEBLOAT §34: old cron isolated-agent turn removed. Hook agent dispatch
    // now enqueues a system event carrying the hook message and wakes the
    // event pump, letting the normal reply path handle it.
    // Note: the event targets the main session queue (same routing as the
    // pre-DEBLOAT isolated-turn summary). value.sessionKey is already
    // validated/rebound upstream for replay scoping; without a per-session
    // wake target the event would be orphaned, so it is not used here.
    const runId = randomUUID();
    try {
      const text = `Hook ${value.name}: ${value.message}`.trim();
      enqueueSystemEvent(text, { sessionKey: mainSessionKey });
      if (value.wakeMode === "now") {
        requestWakeNow({ reason: `hook:${jobId}` });
      }
      logHooks.info(`hook agent dispatch queued as system event (session=${mainSessionKey})`);
    } catch (err) {
      logHooks.warn(`hook agent failed: ${String(err)}`);
      enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, {
        sessionKey: mainSessionKey,
      });
      if (value.wakeMode === "now") {
        requestWakeNow({ reason: `hook:${jobId}:error` });
      }
    }

    return runId;
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    getClientIpConfig,
    dispatchAgentHook,
    dispatchWakeHook,
  });
}

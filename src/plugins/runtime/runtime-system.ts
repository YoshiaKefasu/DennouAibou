import { requestWakeNow, runEventPumpOnce } from "../../infra/event-pump.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { formatNativeDependencyHint } from "./native-deps.js";
import type { RunEventPumpOnceOptions } from "./types-core.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeSystem(): PluginRuntime["system"] {
  return {
    enqueueSystemEvent,
    requestWakeNow,
    runEventPumpOnce: (opts?: RunEventPumpOnceOptions) => {
      const { reason, agentId, sessionKey, heartbeat } = opts ?? {};
      return runEventPumpOnce({
        reason,
        agentId,
        sessionKey,
        ...(heartbeat ? { heartbeat } : {}),
      });
    },
    runCommandWithTimeout,
    formatNativeDependencyHint,
  };
}

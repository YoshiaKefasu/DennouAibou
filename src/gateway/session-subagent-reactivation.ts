import { getLatestSubagentRunByChildSessionKey } from "../agents/subagent-registry-read.js";
import type { replaceSubagentRunAfterSteer } from "./session-subagent-reactivation.runtime.js";

async function loadSessionSubagentReactivationRuntime() {
  return import("./session-subagent-reactivation.runtime.js");
}

export type SessionSubagentReactivationDeps = {
  getLatestSubagentRunByChildSessionKey?: typeof getLatestSubagentRunByChildSessionKey;
  replaceSubagentRunAfterSteer?: typeof replaceSubagentRunAfterSteer;
};

export async function reactivateCompletedSubagentSession(
  params: { sessionKey: string; runId?: string },
  deps: SessionSubagentReactivationDeps = {},
): Promise<boolean> {
  const runId = params.runId?.trim();
  if (!runId) {
    return false;
  }
  const resolveLatestRun =
    deps.getLatestSubagentRunByChildSessionKey ?? getLatestSubagentRunByChildSessionKey;
  const existing = resolveLatestRun(params.sessionKey);
  if (!existing || typeof existing.endedAt !== "number") {
    return false;
  }
  const replaceRun =
    deps.replaceSubagentRunAfterSteer ??
    (await loadSessionSubagentReactivationRuntime()).replaceSubagentRunAfterSteer;
  return replaceRun({
    previousRunId: existing.runId,
    nextRunId: runId,
    fallback: existing,
    runTimeoutSeconds: existing.runTimeoutSeconds ?? 0,
  });
}

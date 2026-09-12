import { createSubsystemLogger } from "../logging/subsystem.js";

export type SessionCheckinActor =
  | "attempt"
  | "compact"
  | "prune"
  | "audio-stt"
  | "repair"
  | "gateway"
  | "plugin"
  | "unknown";

export type SessionCheckinAction = "append" | "prune" | "rewrite" | "repair";

export type SessionCheckinParams = {
  actor: SessionCheckinActor;
  action: SessionCheckinAction;
  op: string;
  lines: number;
  sessionId: string;
  detail?: string;
};

const gatewayLog = createSubsystemLogger("gateway");

/**
 * Phase A session check-in logging.
 *
 * Logging is deliberately best-effort: Phase A observes session mutations but
 * never rejects or changes the mutation because the audit log is unavailable.
 */
export function logSessionCheckin(params: SessionCheckinParams): true {
  try {
    gatewayLog.info(
      `[session:checkin] actor=${params.actor} action=${params.action} ` +
        `op=${params.op} lines=${params.lines} sessionId=${params.sessionId}` +
        (params.detail ? ` detail=${params.detail}` : ""),
    );
  } catch {
    // Phase A is log-only. A logger failure must not affect session handling.
  }
  return true;
}

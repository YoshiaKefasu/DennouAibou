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

export type SessionCheckinAction = "append" | "prune" | "rewrite" | "repair" | "compact";

export type SessionCheckinParams = {
  actor: SessionCheckinActor;
  action: SessionCheckinAction;
  op: string;
  lines: number;
  sessionId: string;
  detail?: string;
};

export type SessionWriteRequest = {
  actor: SessionCheckinActor;
  action: SessionCheckinAction;
  op: string;
  sessionId: string;
  targetLines: string | number;
  reason: string;
};

export type SessionWriteDecision =
  | { granted: true; op: string }
  | { granted: false; reason: string };

const gatewayLog = createSubsystemLogger("gateway");
const SESSION_WRITE_ACTORS = new Set<Exclude<SessionCheckinActor, "unknown">>([
  "attempt",
  "compact",
  "prune",
  "audio-stt",
  "repair",
  "gateway",
  "plugin",
]);
const MAX_SESSION_WRITE_OPS = 4_096;
const usedSessionWriteOps = new Set<string>();
const SESSION_WRITE_ACTIONS = new Set<SessionCheckinAction>([
  "append",
  "prune",
  "rewrite",
  "repair",
  "compact",
]);
const VAGUE_VALUES = new Set(["", "-", "?", "n/a", "na", "none", "null", "unknown", "todo"]);

function normalizeRequiredValue(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? String(value) : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && !VAGUE_VALUES.has(normalized.toLowerCase())
    ? normalized
    : undefined;
}

function logPreAuthorization(params: {
  actor?: string;
  action?: string;
  op?: string;
  sessionId?: string;
  targetLines?: string;
  reason: string;
  result: "granted" | "rejected";
}): boolean {
  try {
    gatewayLog.info(
      `[session:preauth] actor=${params.actor ?? "unknown"} ` +
        `action=${params.action ?? "unknown"} op=${params.op ?? "unknown"} ` +
        `targetLines=${params.targetLines ?? "unknown"} sessionId=${params.sessionId ?? "unknown"} ` +
        `result=${params.result} reason=${params.reason}`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Phase B pre-authorization for a session mutation.
 *
 * The operation id is consumed only after all request fields and the allowlist
 * have passed validation. A logging failure is fail-closed so an unrecorded
 * approval can never authorize a session write.
 */
export function requestSessionWrite(params: SessionWriteRequest): SessionWriteDecision {
  const request = (params ?? {}) as Partial<SessionWriteRequest>;
  const actor = normalizeRequiredValue(request.actor);
  const action = normalizeRequiredValue(request.action);
  const op = normalizeRequiredValue(request.op);
  const sessionId = normalizeRequiredValue(request.sessionId);
  const targetLines = normalizeRequiredValue(request.targetLines);
  const reason = normalizeRequiredValue(request.reason);

  if (!actor || !action || !op || !sessionId || !targetLines || !reason) {
    const rejectionReason = "missing-or-ambiguous-field";
    logPreAuthorization({
      actor,
      action,
      op,
      sessionId,
      targetLines,
      reason: rejectionReason,
      result: "rejected",
    });
    return { granted: false, reason: rejectionReason };
  }

  if (!SESSION_WRITE_ACTORS.has(actor as Exclude<SessionCheckinActor, "unknown">)) {
    const rejectionReason = "unknown-actor";
    logPreAuthorization({
      actor,
      action,
      op,
      sessionId,
      targetLines,
      reason: rejectionReason,
      result: "rejected",
    });
    return { granted: false, reason: rejectionReason };
  }

  if (!SESSION_WRITE_ACTIONS.has(action as SessionCheckinAction)) {
    const rejectionReason = "unknown-action";
    logPreAuthorization({
      actor,
      action,
      op,
      sessionId,
      targetLines,
      reason: rejectionReason,
      result: "rejected",
    });
    return { granted: false, reason: rejectionReason };
  }

  if (usedSessionWriteOps.has(op)) {
    // Touch the entry so repeated access follows the same bounded LRU semantics.
    usedSessionWriteOps.delete(op);
    usedSessionWriteOps.add(op);
    const rejectionReason = "op-reused";
    logPreAuthorization({
      actor,
      action,
      op,
      sessionId,
      targetLines,
      reason: rejectionReason,
      result: "rejected",
    });
    return { granted: false, reason: rejectionReason };
  }

  usedSessionWriteOps.add(op);
  while (usedSessionWriteOps.size > MAX_SESSION_WRITE_OPS) {
    const oldestOp = usedSessionWriteOps.values().next().value;
    if (oldestOp === undefined) {
      break;
    }
    usedSessionWriteOps.delete(oldestOp);
  }
  if (
    !logPreAuthorization({
      actor,
      action,
      op,
      sessionId,
      targetLines,
      reason,
      result: "granted",
    })
  ) {
    return { granted: false, reason: "preauth-log-unavailable" };
  }
  return { granted: true, op };
}

/** Clears the bounded operation cache between isolated tests. */
export function resetSessionWriteOpsForTest(): void {
  usedSessionWriteOps.clear();
}

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

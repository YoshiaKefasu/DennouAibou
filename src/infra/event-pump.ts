import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { appendCronStyleCurrentTimeLine } from "../agents/current-time.js";
import { resolveEmbeddedSessionLane } from "../agents/pi-embedded-runner/lanes.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { formatErrorMessage } from "./errors.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveHeartbeatSenderContext,
} from "./outbound/targets.js";
import { peekSystemEventEntries, resolveSystemEventDeliveryContext } from "./system-events.js";

export type WakeRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export type WakeHandler = (opts: {
  reason?: string;
  agentId?: string;
  sessionKey?: string;
}) => Promise<WakeRunResult>;

type WakeTimerKind = "normal" | "retry";
type PendingWakeReason = {
  reason: string;
  priority: number;
  requestedAt: number;
  agentId?: string;
  sessionKey?: string;
};

const log = createSubsystemLogger("gateway/event-pump");

let handler: WakeHandler | null = null;
let handlerGeneration = 0;
const pendingWakes = new Map<string, PendingWakeReason>();
let scheduled = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let timerDueAt: number | null = null;
let timerKind: WakeTimerKind | null = null;

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;
const REASON_PRIORITY = {
  RETRY: 0,
  DEFAULT: 1,
  ACTION: 2,
} as const;

function resolveReasonPriority(reason: string): number {
  if (reason === "retry") {
    return REASON_PRIORITY.RETRY;
  }
  if (
    reason.startsWith("cron:") ||
    reason.startsWith("exec-event") ||
    reason.startsWith("notifications-event") ||
    reason.startsWith("hook:") ||
    reason === "wake" ||
    reason === "manual"
  ) {
    return REASON_PRIORITY.ACTION;
  }
  return REASON_PRIORITY.DEFAULT;
}

function normalizeWakeReason(reason?: string): string {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return trimmed || "wake";
}

function normalizeWakeTarget(value?: string): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function getWakeTargetKey(params: { agentId?: string; sessionKey?: string }) {
  const agentId = normalizeWakeTarget(params.agentId);
  const sessionKey = normalizeWakeTarget(params.sessionKey);
  return `${agentId ?? ""}::${sessionKey ?? ""}`;
}

function queuePendingWakeReason(params?: {
  reason?: string;
  requestedAt?: number;
  agentId?: string;
  sessionKey?: string;
}) {
  const requestedAt = params?.requestedAt ?? Date.now();
  const normalizedReason = normalizeWakeReason(params?.reason);
  const normalizedAgentId = normalizeWakeTarget(params?.agentId);
  const normalizedSessionKey = normalizeWakeTarget(params?.sessionKey);
  const wakeTargetKey = getWakeTargetKey({
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
  });
  const next: PendingWakeReason = {
    reason: normalizedReason,
    priority: resolveReasonPriority(normalizedReason),
    requestedAt,
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
  };
  const previous = pendingWakes.get(wakeTargetKey);
  if (!previous) {
    pendingWakes.set(wakeTargetKey, next);
    return;
  }
  if (next.priority > previous.priority) {
    pendingWakes.set(wakeTargetKey, next);
    return;
  }
  if (next.priority === previous.priority && next.requestedAt >= previous.requestedAt) {
    pendingWakes.set(wakeTargetKey, next);
  }
}

function schedule(coalesceMs: number, kind: WakeTimerKind = "normal") {
  const delay = Number.isFinite(coalesceMs) ? Math.max(0, coalesceMs) : DEFAULT_COALESCE_MS;
  const dueAt = Date.now() + delay;
  if (timer) {
    if (timerKind === "retry") {
      return;
    }
    if (typeof timerDueAt === "number" && timerDueAt <= dueAt) {
      return;
    }
    clearTimeout(timer);
    timer = null;
    timerDueAt = null;
    timerKind = null;
  }
  timerDueAt = dueAt;
  timerKind = kind;
  timer = setTimeout(async () => {
    timer = null;
    timerDueAt = null;
    timerKind = null;
    scheduled = false;
    const active = handler;
    if (!active) {
      return;
    }
    if (running) {
      scheduled = true;
      schedule(delay, kind);
      return;
    }

    const pendingBatch = Array.from(pendingWakes.values());
    pendingWakes.clear();
    running = true;
    try {
      for (const pendingWake of pendingBatch) {
        const wakeOpts = {
          reason: pendingWake.reason ?? undefined,
          ...(pendingWake.agentId ? { agentId: pendingWake.agentId } : {}),
          ...(pendingWake.sessionKey ? { sessionKey: pendingWake.sessionKey } : {}),
        };
        const res = await active(wakeOpts);
        if (res.status === "skipped" && res.reason === "requests-in-flight") {
          queuePendingWakeReason({
            reason: pendingWake.reason ?? "retry",
            agentId: pendingWake.agentId,
            sessionKey: pendingWake.sessionKey,
          });
          schedule(DEFAULT_RETRY_MS, "retry");
        }
      }
    } catch {
      for (const pendingWake of pendingBatch) {
        queuePendingWakeReason({
          reason: pendingWake.reason ?? "retry",
          agentId: pendingWake.agentId,
          sessionKey: pendingWake.sessionKey,
        });
      }
      schedule(DEFAULT_RETRY_MS, "retry");
    } finally {
      running = false;
      if (pendingWakes.size > 0 || scheduled) {
        schedule(delay, "normal");
      }
    }
  }, delay);
  timer.unref?.();
}

export function setWakeHandler(next: WakeHandler | null): () => void {
  handlerGeneration += 1;
  const generation = handlerGeneration;
  handler = next;
  if (next) {
    if (timer) {
      clearTimeout(timer);
    }
    timer = null;
    timerDueAt = null;
    timerKind = null;
    running = false;
    scheduled = false;
  }
  if (handler && pendingWakes.size > 0) {
    schedule(DEFAULT_COALESCE_MS, "normal");
  }
  return () => {
    if (handlerGeneration !== generation) {
      return;
    }
    if (handler !== next) {
      return;
    }
    handlerGeneration += 1;
    handler = null;
  };
}

export function requestWakeNow(opts?: {
  reason?: string;
  coalesceMs?: number;
  agentId?: string;
  sessionKey?: string;
}) {
  queuePendingWakeReason({
    reason: opts?.reason,
    agentId: opts?.agentId,
    sessionKey: opts?.sessionKey,
  });
  schedule(opts?.coalesceMs ?? DEFAULT_COALESCE_MS, "normal");
}

export function hasWakeHandler() {
  return handler !== null;
}

export function hasPendingWake() {
  return pendingWakes.size > 0 || Boolean(timer) || scheduled;
}

export function resetWakeStateForTests() {
  if (timer) {
    clearTimeout(timer);
  }
  timer = null;
  timerDueAt = null;
  timerKind = null;
  pendingWakes.clear();
  scheduled = false;
  running = false;
  handlerGeneration += 1;
  handler = null;
}

const HEARTBEAT_OK_PREFIX = HEARTBEAT_TOKEN.toLowerCase();

function isHeartbeatAckEvent(evt: string): boolean {
  const trimmed = evt.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(HEARTBEAT_OK_PREFIX)) {
    return false;
  }
  const suffix = lower.slice(HEARTBEAT_OK_PREFIX.length);
  if (suffix.length === 0) {
    return true;
  }
  return !/[a-z0-9_]/.test(suffix[0]);
}

function isHeartbeatNoiseEvent(evt: string): boolean {
  const lower = evt.trim().toLowerCase();
  if (!lower) {
    return false;
  }
  return (
    isHeartbeatAckEvent(lower) ||
    lower.includes("heartbeat poll") ||
    lower.includes("heartbeat wake")
  );
}

export function isExecCompletionEvent(evt: string): boolean {
  return evt.toLowerCase().includes("exec finished");
}

export function isCronSystemEvent(evt: string): boolean {
  if (!evt.trim()) {
    return false;
  }
  return !isHeartbeatNoiseEvent(evt) && !isExecCompletionEvent(evt);
}

export function buildCronEventPrompt(
  pendingEvents: string[],
  opts?: { deliverToUser?: boolean },
): string {
  const deliverToUser = opts?.deliverToUser ?? true;
  const eventText = pendingEvents.join("\n").trim();
  if (!eventText) {
    return "A scheduled cron event was triggered, but no event content was found.";
  }
  if (!deliverToUser) {
    return (
      "A scheduled reminder has been triggered. The reminder content is:\n\n" +
      eventText +
      "\n\nHandle this reminder internally. Do not relay it to the user unless explicitly requested."
    );
  }
  return (
    "A scheduled reminder has been triggered. The reminder content is:\n\n" +
    eventText +
    "\n\nPlease relay this reminder to the user in a helpful and friendly way."
  );
}

export function buildExecEventPrompt(opts?: { deliverToUser?: boolean }): string {
  const deliverToUser = opts?.deliverToUser ?? true;
  if (!deliverToUser) {
    return (
      "An async command you ran earlier has completed. The result is shown in the system messages above. " +
      "Handle the result internally. Do not relay it to the user unless explicitly requested."
    );
  }
  return (
    "An async command you ran earlier has completed. The result is shown in the system messages above. " +
    "Please relay the command output to the user in a helpful way. If the command succeeded, share the relevant output. " +
    "If it failed, explain what went wrong."
  );
}

export type EventPumpDeps = OutboundSendDeps & {
  getReplyFromConfig?: typeof import("./event-pump.runtime.js").getReplyFromConfig;
  runtime?: RuntimeEnv;
  getQueueSize?: (lane?: string) => number;
  nowMs?: () => number;
};

let eventPumpRuntimePromise: Promise<typeof import("./event-pump.runtime.js")> | null = null;

function loadEventPumpRuntime() {
  eventPumpRuntimePromise ??= import("./event-pump.runtime.js");
  return eventPumpRuntimePromise;
}

export async function runEventPumpOnce(opts: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  reason?: string;
  heartbeat?: { target?: string; to?: string; accountId?: string };
  deliveryTarget?: string;
  deps?: EventPumpDeps;
}): Promise<WakeRunResult> {
  const cfg = opts.cfg ?? loadConfig();
  const explicitAgentId = typeof opts.agentId === "string" ? opts.agentId.trim() : "";
  const forcedSessionAgentId =
    explicitAgentId.length > 0 ? undefined : parseAgentSessionKey(opts.sessionKey)?.agentId;
  const agentId = normalizeAgentId(
    explicitAgentId || forcedSessionAgentId || resolveDefaultAgentId(cfg),
  );

  const startedAt = opts.deps?.nowMs?.() ?? Date.now();

  const queueSize = (opts.deps?.getQueueSize ?? getQueueSize)(CommandLane.Main);
  if (queueSize > 0) {
    return { status: "skipped", reason: "requests-in-flight" };
  }

  const rawSessionKey = opts.sessionKey?.trim();
  const sessionKey =
    rawSessionKey && !isSubagentSessionKey(rawSessionKey)
      ? rawSessionKey
      : resolveAgentMainSessionKey({ cfg, agentId });
  const sessionLaneKey = resolveEmbeddedSessionLane(sessionKey);
  const sessionLaneSize = (opts.deps?.getQueueSize ?? getQueueSize)(sessionLaneKey);
  if (sessionLaneSize > 0) {
    return { status: "skipped", reason: "requests-in-flight" };
  }

  const pendingEventEntries = peekSystemEventEntries(sessionKey);
  if (pendingEventEntries.length === 0) {
    return { status: "skipped", reason: "no-events" };
  }

  const turnSourceDeliveryContext = resolveSystemEventDeliveryContext(pendingEventEntries);
  const isCronEventReason = Boolean(opts.reason?.startsWith("cron:"));
  const isExecEventReason = opts.reason === "exec-event";
  const cronEvents = pendingEventEntries
    .filter(
      (event) =>
        (isCronEventReason || event.contextKey?.startsWith("cron:")) &&
        isCronSystemEvent(event.text),
    )
    .map((event) => event.text);
  const pendingEventTexts = pendingEventEntries.map((e) => e.text);
  const hasExecCompletion = isExecEventReason || pendingEventTexts.some(isExecCompletionEvent);
  const hasCronEvents = cronEvents.length > 0;

  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];

  const heartbeatOverride =
    opts.heartbeat ?? (opts.deliveryTarget ? { target: opts.deliveryTarget } : undefined);
  const delivery = resolveHeartbeatDeliveryTarget({
    cfg,
    entry,
    heartbeat: heartbeatOverride,
    turnSource: turnSourceDeliveryContext,
  });

  const { sender } = resolveHeartbeatSenderContext({ cfg, entry, delivery });

  const canRelayToUser = Boolean(delivery.channel !== "none" && delivery.to);
  const prompt = hasExecCompletion
    ? buildExecEventPrompt({ deliverToUser: canRelayToUser })
    : hasCronEvents
      ? buildCronEventPrompt(cronEvents, { deliverToUser: canRelayToUser })
      : pendingEventTexts.join("\n").trim();

  if (!prompt) {
    return { status: "skipped", reason: "empty-prompt" };
  }

  const ctx = {
    Body: appendCronStyleCurrentTimeLine(prompt, cfg, startedAt),
    From: sender,
    To: sender,
    OriginatingChannel: delivery.channel !== "none" ? delivery.channel : undefined,
    OriginatingTo: delivery.to,
    AccountId: delivery.accountId,
    MessageThreadId: delivery.threadId,
    Provider: hasExecCompletion ? "exec-event" : hasCronEvents ? "cron-event" : "event-pump",
    SessionKey: sessionKey,
    ForceSenderIsOwnerFalse: hasExecCompletion,
  };

  const outboundSession = buildOutboundSessionContext({
    cfg,
    agentId,
    sessionKey,
  });

  try {
    const getReplyFromConfig =
      opts.deps?.getReplyFromConfig ?? (await loadEventPumpRuntime()).getReplyFromConfig;
    const replyResult = await getReplyFromConfig(ctx, {}, cfg);

    const payloads: ReplyPayload[] = Array.isArray(replyResult)
      ? replyResult
      : replyResult
        ? [replyResult]
        : [];

    if (payloads.length > 0 && delivery.channel !== "none" && delivery.to) {
      await deliverOutboundPayloads({
        cfg,
        channel: delivery.channel,
        to: delivery.to,
        accountId: delivery.accountId,
        threadId: delivery.threadId,
        payloads,
        session: outboundSession,
        deps: opts.deps,
      });
    }

    return { status: "ran", durationMs: Date.now() - startedAt };
  } catch (err) {
    const errorMsg = formatErrorMessage(err);
    log.error(`event pump run failed: ${errorMsg}`);
    return { status: "failed", reason: errorMsg };
  }
}

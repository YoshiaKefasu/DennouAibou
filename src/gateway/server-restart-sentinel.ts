import { resolveAnnounceTargetFromKey } from "../agents/tools/sessions-send-helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { CliDeps } from "../cli/deps.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { parseSessionThreadInfo } from "../config/sessions/thread-info.js";
import { requestWakeNow } from "../infra/event-pump.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { ackDelivery, enqueueDelivery, failDelivery } from "../infra/outbound/delivery-queue.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import {
  consumeRestartSentinel,
  formatRestartSentinelMessage,
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { deliveryContextFromSession, mergeDeliveryContext } from "../utils/delivery-context.js";
import { loadSessionEntry } from "./session-utils.js";

const log = createSubsystemLogger("gateway/restart-sentinel");
const OUTBOUND_RETRY_DELAY_MS = 750;
const OUTBOUND_MAX_ATTEMPTS = 2;

type RestartSentinelLogger = Pick<ReturnType<typeof createSubsystemLogger>, "warn">;

/** Merged shape of `{ ...defaultRestartSentinelDeps, ...overrides }` used by inner helpers. */
type RestartSentinelRuntimeDeps = {
  [K in keyof RestartSentinelDeps]-?: NonNullable<RestartSentinelDeps[K]>;
};

export type RestartSentinelDeps = {
  resolveMainSessionKeyFromConfig?: typeof resolveMainSessionKeyFromConfig;
  parseSessionThreadInfo?: typeof parseSessionThreadInfo;
  requestWakeNow?: typeof requestWakeNow;
  deliverOutboundPayloads?: typeof deliverOutboundPayloads;
  ackDelivery?: typeof ackDelivery;
  enqueueDelivery?: typeof enqueueDelivery;
  failDelivery?: typeof failDelivery;
  buildOutboundSessionContext?: typeof buildOutboundSessionContext;
  resolveOutboundTarget?: typeof resolveOutboundTarget;
  consumeRestartSentinel?: typeof consumeRestartSentinel;
  formatRestartSentinelMessage?: typeof formatRestartSentinelMessage;
  summarizeRestartSentinel?: typeof summarizeRestartSentinel;
  enqueueSystemEvent?: typeof enqueueSystemEvent;
  deliveryContextFromSession?: typeof deliveryContextFromSession;
  mergeDeliveryContext?: typeof mergeDeliveryContext;
  loadSessionEntry?: typeof loadSessionEntry;
  resolveAnnounceTargetFromKey?: typeof resolveAnnounceTargetFromKey;
  getChannelPlugin?: typeof getChannelPlugin;
  normalizeChannelId?: typeof normalizeChannelId;
  log?: RestartSentinelLogger;
};

const defaultRestartSentinelDeps: RestartSentinelRuntimeDeps = {
  resolveMainSessionKeyFromConfig,
  parseSessionThreadInfo,
  requestWakeNow,
  deliverOutboundPayloads,
  ackDelivery,
  enqueueDelivery,
  failDelivery,
  buildOutboundSessionContext,
  resolveOutboundTarget,
  consumeRestartSentinel,
  formatRestartSentinelMessage,
  summarizeRestartSentinel,
  enqueueSystemEvent,
  deliveryContextFromSession,
  mergeDeliveryContext,
  loadSessionEntry,
  resolveAnnounceTargetFromKey,
  getChannelPlugin,
  normalizeChannelId,
  log,
};

function enqueueRestartSentinelWake(
  deps: RestartSentinelRuntimeDeps,
  message: string,
  sessionKey: string,
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  },
) {
  deps.enqueueSystemEvent(message, {
    sessionKey,
    ...(deliveryContext ? { deliveryContext } : {}),
  });
  deps.requestWakeNow({ reason: "wake", sessionKey });
}

async function waitForOutboundRetry(delayMs: number) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function deliverRestartSentinelNotice(
  deps: RestartSentinelRuntimeDeps,
  params: {
    deps: CliDeps;
    cfg: ReturnType<typeof loadSessionEntry>["cfg"];
    sessionKey: string;
    summary: string;
    message: string;
    channel: string;
    to: string;
    accountId?: string;
    replyToId?: string;
    threadId?: string;
    session: ReturnType<typeof buildOutboundSessionContext>;
  },
) {
  const payloads = [{ text: params.message }];
  // Persist one recoverable notice across the whole retry loop so a transient
  // failure does not leave behind a stale duplicate queue entry.
  const queueId = await deps
    .enqueueDelivery({
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      replyToId: params.replyToId,
      threadId: params.threadId,
      payloads,
      bestEffort: false,
    })
    .catch(() => null);
  for (let attempt = 1; attempt <= OUTBOUND_MAX_ATTEMPTS; attempt += 1) {
    try {
      const results = await deps.deliverOutboundPayloads({
        cfg: params.cfg,
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
        replyToId: params.replyToId,
        threadId: params.threadId,
        payloads,
        session: params.session,
        deps: params.deps,
        bestEffort: false,
        skipQueue: true,
      });
      if (results.length > 0) {
        if (queueId) {
          await deps.ackDelivery(queueId).catch(() => {});
        }
        return;
      }
      throw new Error("outbound delivery returned no results");
    } catch (err) {
      const retrying = attempt < OUTBOUND_MAX_ATTEMPTS;
      const suffix = retrying ? `; retrying in ${OUTBOUND_RETRY_DELAY_MS}ms` : "";
      deps.log.warn(`${params.summary}: outbound delivery failed${suffix}: ${String(err)}`, {
        channel: params.channel,
        to: params.to,
        sessionKey: params.sessionKey,
        attempt,
        maxAttempts: OUTBOUND_MAX_ATTEMPTS,
      });
      if (!retrying) {
        if (queueId) {
          await deps
            .failDelivery(queueId, err instanceof Error ? err.message : String(err))
            .catch(() => {
              // Best-effort queue bookkeeping.
            });
        }
        return;
      }
      await waitForOutboundRetry(OUTBOUND_RETRY_DELAY_MS);
    }
  }
}

export async function scheduleRestartSentinelWake(
  params: { deps: CliDeps },
  overrides: RestartSentinelDeps = {},
) {
  const deps = { ...defaultRestartSentinelDeps, ...overrides };
  const sentinel = await deps.consumeRestartSentinel();
  if (!sentinel) {
    return;
  }
  const payload = sentinel.payload;
  const sessionKey = payload.sessionKey?.trim();
  const message = deps.formatRestartSentinelMessage(payload);
  const summary = deps.summarizeRestartSentinel(payload);
  const wakeDeliveryContext = deps.mergeDeliveryContext(
    payload.threadId != null
      ? { ...payload.deliveryContext, threadId: payload.threadId }
      : payload.deliveryContext,
    undefined,
  );

  if (!sessionKey) {
    const mainSessionKey = deps.resolveMainSessionKeyFromConfig();
    deps.enqueueSystemEvent(message, { sessionKey: mainSessionKey });
    return;
  }

  enqueueRestartSentinelWake(deps, message, sessionKey, wakeDeliveryContext);

  const { baseSessionKey, threadId: sessionThreadId } = deps.parseSessionThreadInfo(sessionKey);

  const { cfg, entry } = deps.loadSessionEntry(sessionKey);
  const parsedTarget = deps.resolveAnnounceTargetFromKey(baseSessionKey ?? sessionKey);

  // Prefer delivery context from sentinel (captured at restart) over session store
  // Handles race condition where store wasn't flushed before restart
  const sentinelContext = payload.deliveryContext;
  let sessionDeliveryContext = deps.deliveryContextFromSession(entry);
  if (!sessionDeliveryContext && baseSessionKey && baseSessionKey !== sessionKey) {
    const { entry: baseEntry } = deps.loadSessionEntry(baseSessionKey);
    sessionDeliveryContext = deps.deliveryContextFromSession(baseEntry);
  }

  const origin = deps.mergeDeliveryContext(
    sentinelContext,
    deps.mergeDeliveryContext(sessionDeliveryContext, parsedTarget ?? undefined),
  );

  const channelRaw = origin?.channel;
  const channel = channelRaw ? deps.normalizeChannelId(channelRaw) : null;
  const to = origin?.to;
  if (!channel || !to) {
    return;
  }

  const resolved = deps.resolveOutboundTarget({
    channel,
    to,
    cfg,
    accountId: origin?.accountId,
    mode: "implicit",
  });
  if (!resolved.ok) {
    return;
  }

  const threadId =
    payload.threadId ??
    parsedTarget?.threadId ?? // From resolveAnnounceTargetFromKey (extracts :topic:N)
    sessionThreadId ??
    (origin?.threadId != null ? String(origin.threadId) : undefined);

  const replyTransport =
    deps.getChannelPlugin(channel)?.threading?.resolveReplyTransport?.({
      cfg,
      accountId: origin?.accountId,
      threadId,
    }) ?? null;
  const replyToId = replyTransport?.replyToId ?? undefined;
  const resolvedThreadId =
    replyTransport && Object.hasOwn(replyTransport, "threadId")
      ? replyTransport.threadId != null
        ? String(replyTransport.threadId)
        : undefined
      : threadId;
  const outboundSession = deps.buildOutboundSessionContext({
    cfg,
    sessionKey,
  });

  await deliverRestartSentinelNotice(deps, {
    deps: params.deps,
    cfg,
    sessionKey,
    summary,
    message,
    channel,
    to: resolved.to,
    accountId: origin?.accountId,
    replyToId,
    threadId: resolvedThreadId,
    session: outboundSession,
  });
}

export function shouldWakeFromRestartSentinel() {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}

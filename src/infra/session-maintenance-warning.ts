import type { OpenClawConfig } from "../config/config.js";
import type { SessionMaintenanceWarning } from "../config/sessions/store-maintenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  deliveryContextFromSession,
  type DeliveryContext,
  type DeliveryContextSessionSource,
} from "../utils/delivery-context.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";
import { enqueueSystemEvent } from "./system-events.js";

type WarningParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  entry: SessionEntry;
  warning: SessionMaintenanceWarning;
};

/**
 * Injectable seams for tests. Defaults mirror production so callers keep the
 * existing behaviour.
 */
export type SessionMaintenanceWarningDeps = {
  deliveryContextFromSession?: (
    entry?: DeliveryContextSessionSource,
  ) => DeliveryContext | undefined;
  normalizeMessageChannel?: (raw?: string | null) => string | undefined;
  isDeliverableMessageChannel?: (value: string) => boolean;
  buildOutboundSessionContext?: typeof buildOutboundSessionContext;
  enqueueSystemEvent?: typeof enqueueSystemEvent;
  deliverOutboundPayloads?: typeof import("./outbound/deliver-runtime.js").deliverOutboundPayloads;
};

const warnedContexts = new Map<string, string>();
const log = createSubsystemLogger("session-maintenance-warning");
let deliverRuntimePromise: Promise<typeof import("./outbound/deliver-runtime.js")> | null = null;

function resetSessionMaintenanceWarningForTests() {
  warnedContexts.clear();
  deliverRuntimePromise = null;
}

export const __testing = {
  resetSessionMaintenanceWarningForTests,
} as const;

function loadDeliverRuntime() {
  deliverRuntimePromise ??= import("./outbound/deliver-runtime.js");
  return deliverRuntimePromise;
}

function shouldSendWarning(): boolean {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}

function buildWarningContext(params: WarningParams): string {
  const { warning } = params;
  return [
    warning.activeSessionKey,
    warning.pruneAfterMs,
    warning.maxEntries,
    warning.wouldPrune ? "prune" : "",
    warning.wouldCap ? "cap" : "",
  ]
    .filter(Boolean)
    .join("|");
}

function formatDuration(ms: number): string {
  if (ms >= 86_400_000) {
    const days = Math.round(ms / 86_400_000);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (ms >= 3_600_000) {
    const hours = Math.round(ms / 3_600_000);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (ms >= 60_000) {
    const mins = Math.round(ms / 60_000);
    return `${mins} minute${mins === 1 ? "" : "s"}`;
  }
  const secs = Math.round(ms / 1000);
  return `${secs} second${secs === 1 ? "" : "s"}`;
}

function buildWarningText(warning: SessionMaintenanceWarning): string {
  const reasons: string[] = [];
  if (warning.wouldPrune) {
    reasons.push(`older than ${formatDuration(warning.pruneAfterMs)}`);
  }
  if (warning.wouldCap) {
    reasons.push(`not in the most recent ${warning.maxEntries} sessions`);
  }
  const reasonText = reasons.length > 0 ? reasons.join(" and ") : "over maintenance limits";
  return (
    `⚠️ Session maintenance warning: this active session would be evicted (${reasonText}). ` +
    `Maintenance is set to warn-only, so nothing was reset. ` +
    `To enforce cleanup, set \`session.maintenance.mode: "enforce"\` or increase the limits.`
  );
}

function resolveWarningDeliveryTarget(
  entry: SessionEntry,
  deps: SessionMaintenanceWarningDeps,
): {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
} {
  const resolveDeliveryContext = deps.deliveryContextFromSession ?? deliveryContextFromSession;
  const normalizeChannel = deps.normalizeMessageChannel ?? normalizeMessageChannel;
  const isDeliverable = deps.isDeliverableMessageChannel ?? isDeliverableMessageChannel;
  const context = resolveDeliveryContext(entry);
  const channel = context?.channel
    ? (normalizeChannel(context.channel) ?? context.channel)
    : undefined;
  return {
    channel: channel && isDeliverable(channel) ? channel : undefined,
    to: context?.to,
    accountId: context?.accountId,
    threadId: context?.threadId,
  };
}

export async function deliverSessionMaintenanceWarning(
  params: WarningParams,
  deps: SessionMaintenanceWarningDeps = {},
): Promise<void> {
  const enqueueEvent = deps.enqueueSystemEvent ?? enqueueSystemEvent;
  if (!shouldSendWarning()) {
    return;
  }

  const contextKey = buildWarningContext(params);
  if (warnedContexts.get(params.sessionKey) === contextKey) {
    return;
  }
  warnedContexts.set(params.sessionKey, contextKey);

  const text = buildWarningText(params.warning);
  const target = resolveWarningDeliveryTarget(params.entry, deps);
  const isDeliverable = deps.isDeliverableMessageChannel ?? isDeliverableMessageChannel;

  if (!target.channel || !target.to) {
    enqueueEvent(text, { sessionKey: params.sessionKey });
    return;
  }

  const normalizeChannel = deps.normalizeMessageChannel ?? normalizeMessageChannel;
  const channel = normalizeChannel(target.channel) ?? target.channel;
  if (!isDeliverable(channel)) {
    enqueueEvent(text, { sessionKey: params.sessionKey });
    return;
  }

  try {
    const deliverPayloads =
      deps.deliverOutboundPayloads ?? (await loadDeliverRuntime()).deliverOutboundPayloads;
    const buildSessionContext = deps.buildOutboundSessionContext ?? buildOutboundSessionContext;
    const outboundSession = buildSessionContext({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    await deliverPayloads({
      cfg: params.cfg,
      channel,
      to: target.to,
      accountId: target.accountId,
      threadId: target.threadId,
      payloads: [{ text }],
      session: outboundSession,
    });
  } catch (err) {
    log.warn(`Failed to deliver session maintenance warning: ${String(err)}`);
    enqueueEvent(text, { sessionKey: params.sessionKey });
  }
}

import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { normalizeAccountId } from "../../utils/account-id.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  normalizeMessageChannel,
  type GatewayMessageChannel,
} from "../../utils/message-channel.js";
import type { OutboundTargetResolution } from "./targets.js";
import {
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
  type SessionDeliveryTarget,
} from "./targets.js";

export type AgentDeliveryPlan = {
  baseDelivery: SessionDeliveryTarget;
  resolvedChannel: GatewayMessageChannel;
  resolvedTo?: string;
  resolvedAccountId?: string;
  resolvedThreadId?: string | number;
  deliveryTargetMode?: ChannelOutboundTargetMode;
};

/**
 * Injectable seams for target resolution and the channel catalog predicates.
 * Defaults resolve to the real implementations so production callers stay
 * unchanged.
 */
export type AgentDeliveryDeps = {
  resolveOutboundTarget: typeof resolveOutboundTarget;
  resolveSessionDeliveryTarget: typeof resolveSessionDeliveryTarget;
  isDeliverableMessageChannel: typeof isDeliverableMessageChannel;
  isGatewayMessageChannel: typeof isGatewayMessageChannel;
};

const defaultAgentDeliveryDeps: AgentDeliveryDeps = {
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
};

function resolveDeps(deps?: Partial<AgentDeliveryDeps>): AgentDeliveryDeps {
  return deps ? { ...defaultAgentDeliveryDeps, ...deps } : defaultAgentDeliveryDeps;
}

export function resolveAgentDeliveryPlan(
  params: {
    sessionEntry?: SessionEntry;
    requestedChannel?: string;
    explicitTo?: string;
    explicitThreadId?: string | number;
    accountId?: string;
    wantsDelivery: boolean;
    /**
     * The channel that originated the current agent turn.  When provided,
     * overrides session-level `lastChannel` to prevent cross-channel reply
     * routing in shared sessions (dmScope="main").
     *
     * @see https://github.com/openclaw/openclaw/issues/24152
     */
    turnSourceChannel?: string;
    /** Turn-source `to` — paired with `turnSourceChannel`. */
    turnSourceTo?: string;
    /** Turn-source `accountId` — paired with `turnSourceChannel`. */
    turnSourceAccountId?: string;
    /** Turn-source `threadId` — paired with `turnSourceChannel`. */
    turnSourceThreadId?: string | number;
  },
  deps?: Partial<AgentDeliveryDeps>,
): AgentDeliveryPlan {
  const resolvedDeps = resolveDeps(deps);
  const requestedRaw =
    typeof params.requestedChannel === "string" ? params.requestedChannel.trim() : "";
  const normalizedRequested = requestedRaw ? normalizeMessageChannel(requestedRaw) : undefined;
  const requestedChannel = normalizedRequested || "last";

  const explicitTo =
    typeof params.explicitTo === "string" && params.explicitTo.trim()
      ? params.explicitTo.trim()
      : undefined;

  // Resolve turn-source channel for cross-channel safety.
  const normalizedTurnSource = params.turnSourceChannel
    ? normalizeMessageChannel(params.turnSourceChannel)
    : undefined;
  const turnSourceChannel =
    normalizedTurnSource && resolvedDeps.isDeliverableMessageChannel(normalizedTurnSource)
      ? normalizedTurnSource
      : undefined;
  const turnSourceTo =
    typeof params.turnSourceTo === "string" && params.turnSourceTo.trim()
      ? params.turnSourceTo.trim()
      : undefined;
  const turnSourceAccountId = normalizeAccountId(params.turnSourceAccountId);
  const turnSourceThreadId =
    params.turnSourceThreadId != null && params.turnSourceThreadId !== ""
      ? params.turnSourceThreadId
      : undefined;

  const baseDelivery = resolvedDeps.resolveSessionDeliveryTarget({
    entry: params.sessionEntry,
    requestedChannel: requestedChannel === INTERNAL_MESSAGE_CHANNEL ? "last" : requestedChannel,
    explicitTo,
    explicitThreadId: params.explicitThreadId,
    turnSourceChannel,
    turnSourceTo,
    turnSourceAccountId,
    turnSourceThreadId,
  });

  const resolvedChannel = (() => {
    if (requestedChannel === INTERNAL_MESSAGE_CHANNEL) {
      return INTERNAL_MESSAGE_CHANNEL;
    }
    if (requestedChannel === "last") {
      if (baseDelivery.channel && baseDelivery.channel !== INTERNAL_MESSAGE_CHANNEL) {
        return baseDelivery.channel;
      }
      return INTERNAL_MESSAGE_CHANNEL;
    }

    if (resolvedDeps.isGatewayMessageChannel(requestedChannel)) {
      return requestedChannel;
    }

    if (baseDelivery.channel && baseDelivery.channel !== INTERNAL_MESSAGE_CHANNEL) {
      return baseDelivery.channel;
    }
    return INTERNAL_MESSAGE_CHANNEL;
  })();

  const deliveryTargetMode = explicitTo
    ? "explicit"
    : resolvedDeps.isDeliverableMessageChannel(resolvedChannel)
      ? "implicit"
      : undefined;

  const resolvedAccountId =
    normalizeAccountId(params.accountId) ??
    (deliveryTargetMode === "implicit" ? baseDelivery.accountId : undefined);

  let resolvedTo = explicitTo;
  if (
    !resolvedTo &&
    resolvedDeps.isDeliverableMessageChannel(resolvedChannel) &&
    resolvedChannel === baseDelivery.lastChannel
  ) {
    resolvedTo = baseDelivery.lastTo;
  }

  return {
    baseDelivery,
    resolvedChannel,
    resolvedTo,
    resolvedAccountId,
    resolvedThreadId: baseDelivery.threadId,
    deliveryTargetMode,
  };
}

export function resolveAgentOutboundTarget(
  params: {
    cfg: OpenClawConfig;
    plan: AgentDeliveryPlan;
    targetMode?: ChannelOutboundTargetMode;
    validateExplicitTarget?: boolean;
  },
  deps?: Partial<AgentDeliveryDeps>,
): {
  resolvedTarget: OutboundTargetResolution | null;
  resolvedTo?: string;
  targetMode: ChannelOutboundTargetMode;
} {
  const resolvedDeps = resolveDeps(deps);
  const targetMode =
    params.targetMode ??
    params.plan.deliveryTargetMode ??
    (params.plan.resolvedTo ? "explicit" : "implicit");
  if (!resolvedDeps.isDeliverableMessageChannel(params.plan.resolvedChannel)) {
    return {
      resolvedTarget: null,
      resolvedTo: params.plan.resolvedTo,
      targetMode,
    };
  }
  if (params.validateExplicitTarget !== true && params.plan.resolvedTo) {
    return {
      resolvedTarget: null,
      resolvedTo: params.plan.resolvedTo,
      targetMode,
    };
  }
  const resolvedTarget = resolvedDeps.resolveOutboundTarget({
    channel: params.plan.resolvedChannel,
    to: params.plan.resolvedTo,
    cfg: params.cfg,
    accountId: params.plan.resolvedAccountId,
    mode: targetMode,
  });
  return {
    resolvedTarget,
    resolvedTo: resolvedTarget.ok ? resolvedTarget.to : params.plan.resolvedTo,
    targetMode,
  };
}

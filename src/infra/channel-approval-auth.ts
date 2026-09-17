import { getChannelPlugin, resolveChannelApprovalCapability } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";

export type ApprovalCommandAuthorization = {
  authorized: boolean;
  reason?: string;
  explicit: boolean;
};

/**
 * Injectable seam for channel plugin lookup. Defaults to the real
 * implementation so production callers stay unchanged.
 */
export type ChannelApprovalAuthDeps = {
  getChannelPlugin: typeof getChannelPlugin;
};

const defaultChannelApprovalAuthDeps: ChannelApprovalAuthDeps = {
  getChannelPlugin,
};

export function resolveApprovalCommandAuthorization(
  params: {
    cfg: OpenClawConfig;
    channel?: string | null;
    accountId?: string | null;
    senderId?: string | null;
    kind: "exec" | "plugin";
  },
  deps?: Partial<ChannelApprovalAuthDeps>,
): ApprovalCommandAuthorization {
  const getPlugin = deps?.getChannelPlugin ?? defaultChannelApprovalAuthDeps.getChannelPlugin;
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    return { authorized: true, explicit: false };
  }
  const approvalCapability = resolveChannelApprovalCapability(getPlugin(channel));
  const resolved = approvalCapability?.authorizeActorAction?.({
    cfg: params.cfg,
    accountId: params.accountId,
    senderId: params.senderId,
    action: "approve",
    approvalKind: params.kind,
  });
  if (!resolved) {
    return { authorized: true, explicit: false };
  }
  const availability = approvalCapability?.getActionAvailabilityState?.({
    cfg: params.cfg,
    accountId: params.accountId,
    action: "approve",
  });
  return {
    authorized: resolved.authorized,
    reason: resolved.reason,
    explicit: resolved.authorized ? availability?.kind !== "disabled" : true,
  };
}

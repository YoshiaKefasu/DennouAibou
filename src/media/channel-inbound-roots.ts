import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agents/agent-scope.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { getBootstrapChannelPlugin } from "../channels/plugins/bootstrap-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { mergeInboundPathRoots, resolveWorkspaceInboundMediaRoots } from "./inbound-path-policy.js";

function normalizeChannelId(value?: string | null): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

/**
 * DEBLOAT §38: session-agent workspace for the current turn, so the
 * workspace-persistent `inbound_media/` tree can be allowlisted alongside
 * channel-provided attachment roots.
 */
function resolveSessionWorkspaceInboundMediaRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] {
  try {
    const agentId = resolveSessionAgentId({
      sessionKey: params.ctx.SessionKey,
      config: params.cfg,
    });
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    return resolveWorkspaceInboundMediaRoots(workspaceDir);
  } catch {
    return [];
  }
}

function findChannelMessagingAdapter(channelId?: string | null) {
  const normalized = normalizeChannelId(channelId);
  if (!normalized) {
    return undefined;
  }
  return getBootstrapChannelPlugin(normalized)?.messaging;
}

export function resolveChannelInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const messaging = findChannelMessagingAdapter(params.ctx.Surface ?? params.ctx.Provider);
  const adapterRoots = messaging?.resolveInboundAttachmentRoots?.({
    cfg: params.cfg,
    accountId: params.ctx.AccountId,
  });
  const workspaceRoots = resolveSessionWorkspaceInboundMediaRoots(params);
  if (!adapterRoots && workspaceRoots.length === 0) {
    return undefined;
  }
  return mergeInboundPathRoots(adapterRoots, workspaceRoots);
}

export function resolveChannelRemoteInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const messaging = findChannelMessagingAdapter(params.ctx.Surface ?? params.ctx.Provider);
  return messaging?.resolveRemoteInboundAttachmentRoots?.({
    cfg: params.cfg,
    accountId: params.ctx.AccountId,
  });
}

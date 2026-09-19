import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
  type DeliverableMessageChannel,
} from "../../utils/message-channel.js";
import {
  bootstrapOutboundChannelPlugin,
  resetOutboundChannelBootstrapStateForTests,
} from "./channel-bootstrap.runtime.js";

export type OutboundChannelResolutionDeps = {
  getChannelPlugin: typeof getChannelPlugin;
  getActivePluginRegistry: typeof getActivePluginRegistry;
  normalizeMessageChannel: typeof normalizeMessageChannel;
  isDeliverableMessageChannel: typeof isDeliverableMessageChannel;
  bootstrapOutboundChannelPlugin: typeof bootstrapOutboundChannelPlugin;
};

const defaultOutboundChannelResolutionDeps: OutboundChannelResolutionDeps = {
  getChannelPlugin,
  getActivePluginRegistry,
  normalizeMessageChannel,
  isDeliverableMessageChannel,
  bootstrapOutboundChannelPlugin,
};

export function resetOutboundChannelResolutionStateForTest(): void {
  resetOutboundChannelBootstrapStateForTests();
}

export function normalizeDeliverableOutboundChannel(
  raw?: string | null,
  deps: Partial<OutboundChannelResolutionDeps> = {},
): DeliverableMessageChannel | undefined {
  const resolvedDeps = { ...defaultOutboundChannelResolutionDeps, ...deps };
  const normalized = resolvedDeps.normalizeMessageChannel(raw);
  if (!normalized || !resolvedDeps.isDeliverableMessageChannel(normalized)) {
    return undefined;
  }
  return normalized;
}

function maybeBootstrapChannelPlugin(
  params: { channel: DeliverableMessageChannel; cfg?: OpenClawConfig },
  deps: Pick<OutboundChannelResolutionDeps, "bootstrapOutboundChannelPlugin">,
): void {
  deps.bootstrapOutboundChannelPlugin(params);
}

function resolveDirectFromActiveRegistry(
  channel: DeliverableMessageChannel,
  deps: Pick<OutboundChannelResolutionDeps, "getActivePluginRegistry">,
): ChannelPlugin | undefined {
  const activeRegistry = deps.getActivePluginRegistry();
  if (!activeRegistry) {
    return undefined;
  }
  for (const entry of activeRegistry.channels) {
    const plugin = entry?.plugin;
    if (plugin?.id === channel) {
      return plugin;
    }
  }
  return undefined;
}

export function resolveOutboundChannelPlugin(
  params: { channel: string; cfg?: OpenClawConfig },
  deps: Partial<OutboundChannelResolutionDeps> = {},
): ChannelPlugin | undefined {
  const resolvedDeps = { ...defaultOutboundChannelResolutionDeps, ...deps };
  const normalized = normalizeDeliverableOutboundChannel(params.channel, resolvedDeps);
  if (!normalized) {
    return undefined;
  }

  const resolve = () => resolvedDeps.getChannelPlugin(normalized);
  const current = resolve();
  if (current) {
    return current;
  }
  const directCurrent = resolveDirectFromActiveRegistry(normalized, resolvedDeps);
  if (directCurrent) {
    return directCurrent;
  }

  maybeBootstrapChannelPlugin({ channel: normalized, cfg: params.cfg }, resolvedDeps);
  return resolve() ?? resolveDirectFromActiveRegistry(normalized, resolvedDeps);
}

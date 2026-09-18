import {
  getChannelPlugin,
  listChannelPlugins,
  resolveChannelApprovalAdapter,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";

export type ExecApprovalInitiatingSurfaceState =
  | { kind: "enabled"; channel: string | undefined; channelLabel: string; accountId?: string }
  | { kind: "disabled"; channel: string; channelLabel: string; accountId?: string }
  | { kind: "unsupported"; channel: string; channelLabel: string; accountId?: string };

/**
 * Injectable seams for the channel-catalog / config lookups this module
 * performs. Tests supply fixtures instead of mocking `../config/config.js`,
 * `../channels/plugins/index.js`, and `../utils/message-channel.js` at module
 * level.
 */
export type ExecApprovalSurfaceDeps = {
  loadConfig?: typeof loadConfig;
  getChannelPlugin?: typeof getChannelPlugin;
  listChannelPlugins?: typeof listChannelPlugins;
  normalizeMessageChannel?: typeof normalizeMessageChannel;
  /**
   * Loosened from the real type predicate so tests can inject a plain mock.
   */
  isDeliverableMessageChannel?: (value: string) => boolean;
};

type ResolvedExecApprovalSurfaceDeps = Required<ExecApprovalSurfaceDeps>;

function resolveDeps(deps: ExecApprovalSurfaceDeps = {}): ResolvedExecApprovalSurfaceDeps {
  return {
    loadConfig: deps.loadConfig ?? loadConfig,
    getChannelPlugin: deps.getChannelPlugin ?? getChannelPlugin,
    listChannelPlugins: deps.listChannelPlugins ?? listChannelPlugins,
    normalizeMessageChannel: deps.normalizeMessageChannel ?? normalizeMessageChannel,
    isDeliverableMessageChannel: deps.isDeliverableMessageChannel ?? isDeliverableMessageChannel,
  };
}

function labelForChannel(
  channel: string | undefined,
  getChannelPluginImpl: typeof getChannelPlugin,
): string {
  if (channel === "tui") {
    return "terminal UI";
  }
  if (channel === INTERNAL_MESSAGE_CHANNEL) {
    return "Web UI";
  }
  return (
    getChannelPluginImpl(channel ?? "")?.meta.label ??
    (channel ? channel[0]?.toUpperCase() + channel.slice(1) : "this platform")
  );
}

function hasNativeExecApprovalCapability(
  channel: string | undefined,
  getChannelPluginImpl: typeof getChannelPlugin,
): boolean {
  const capability = resolveChannelApprovalCapability(getChannelPluginImpl(channel ?? ""));
  return Boolean(capability?.native && capability.getActionAvailabilityState);
}

export function resolveExecApprovalInitiatingSurfaceState(
  params: {
    channel?: string | null;
    accountId?: string | null;
    cfg?: OpenClawConfig;
  },
  deps: ExecApprovalSurfaceDeps = {},
): ExecApprovalInitiatingSurfaceState {
  const resolved = resolveDeps(deps);
  const channel = resolved.normalizeMessageChannel(params.channel);
  const channelLabel = labelForChannel(channel, resolved.getChannelPlugin);
  const accountId = params.accountId?.trim() || undefined;
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return { kind: "enabled", channel, channelLabel, accountId };
  }

  const cfg = params.cfg ?? resolved.loadConfig();
  const state = resolveChannelApprovalCapability(
    resolved.getChannelPlugin(channel),
  )?.getActionAvailabilityState?.({
    cfg,
    accountId: params.accountId,
    action: "approve",
  });
  if (state) {
    return { ...state, channel, channelLabel, accountId };
  }
  if (resolved.isDeliverableMessageChannel(channel)) {
    return { kind: "enabled", channel, channelLabel, accountId };
  }
  return { kind: "unsupported", channel, channelLabel, accountId };
}

export function supportsNativeExecApprovalClient(
  channel?: string | null,
  deps: ExecApprovalSurfaceDeps = {},
): boolean {
  const resolved = resolveDeps(deps);
  const normalized = resolved.normalizeMessageChannel(channel);
  if (!normalized || normalized === INTERNAL_MESSAGE_CHANNEL || normalized === "tui") {
    return true;
  }
  return hasNativeExecApprovalCapability(normalized, resolved.getChannelPlugin);
}

export function listNativeExecApprovalClientLabels(
  params?: {
    excludeChannel?: string | null;
  },
  deps: ExecApprovalSurfaceDeps = {},
): string[] {
  const resolved = resolveDeps(deps);
  const excludeChannel = resolved.normalizeMessageChannel(params?.excludeChannel);
  return resolved
    .listChannelPlugins()
    .filter((plugin) => plugin.id !== excludeChannel)
    .filter((plugin) => hasNativeExecApprovalCapability(plugin.id, resolved.getChannelPlugin))
    .map((plugin) => plugin.meta.label?.trim())
    .filter((label): label is string => Boolean(label))
    .toSorted((a, b) => a.localeCompare(b));
}

export function describeNativeExecApprovalClientSetup(
  params: {
    channel?: string | null;
    channelLabel?: string | null;
    accountId?: string | null;
  },
  deps: ExecApprovalSurfaceDeps = {},
): string | null {
  const resolved = resolveDeps(deps);
  const channel = resolved.normalizeMessageChannel(params.channel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return null;
  }
  const channelLabel =
    params.channelLabel?.trim() || labelForChannel(channel, resolved.getChannelPlugin);
  const accountId = params.accountId?.trim() || undefined;
  return (
    resolveChannelApprovalCapability(
      resolved.getChannelPlugin(channel),
    )?.describeExecApprovalSetup?.({
      channel,
      channelLabel,
      accountId,
    }) ?? null
  );
}

export function hasConfiguredExecApprovalDmRoute(
  cfg: OpenClawConfig,
  deps: ExecApprovalSurfaceDeps = {},
): boolean {
  return resolveDeps(deps)
    .listChannelPlugins()
    .some(
      (plugin) =>
        resolveChannelApprovalAdapter(plugin)?.delivery?.hasConfiguredDmRoute?.({ cfg }) ?? false,
    );
}

import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { resolveRuntimePluginRegistry } from "../../plugins/loader.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginChannelRegistryVersion,
} from "../../plugins/runtime.js";
import type { DeliverableMessageChannel } from "../../utils/message-channel.js";

const bootstrapAttempts = new Set<string>();

/**
 * Injectable seams for the outbound channel bootstrap boundaries. Tests supply
 * fake registry/auto-enable/agent-scope helpers instead of mocking the source
 * modules at module level (Bun cannot intercept ESM imports).
 */
export type OutboundChannelBootstrapDeps = {
  getActivePluginChannelRegistry: typeof getActivePluginChannelRegistry;
  getActivePluginChannelRegistryVersion: typeof getActivePluginChannelRegistryVersion;
  applyPluginAutoEnable: typeof applyPluginAutoEnable;
  resolveRuntimePluginRegistry: typeof resolveRuntimePluginRegistry;
  resolveDefaultAgentId: typeof resolveDefaultAgentId;
  resolveAgentWorkspaceDir: typeof resolveAgentWorkspaceDir;
};

const defaultOutboundChannelBootstrapDeps: OutboundChannelBootstrapDeps = {
  getActivePluginChannelRegistry,
  getActivePluginChannelRegistryVersion,
  applyPluginAutoEnable,
  resolveRuntimePluginRegistry,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
};

export function resetOutboundChannelBootstrapStateForTests(): void {
  bootstrapAttempts.clear();
}

export function bootstrapOutboundChannelPlugin(
  params: {
    channel: DeliverableMessageChannel;
    cfg?: OpenClawConfig;
  },
  deps: Partial<OutboundChannelBootstrapDeps> = {},
): void {
  const resolvedDeps = { ...defaultOutboundChannelBootstrapDeps, ...deps };
  const cfg = params.cfg;
  if (!cfg) {
    return;
  }

  const activeChannelRegistry = resolvedDeps.getActivePluginChannelRegistry();
  const activeHasRequestedChannel = activeChannelRegistry?.channels?.some(
    (entry) => entry?.plugin?.id === params.channel,
  );
  if (activeHasRequestedChannel) {
    return;
  }

  const attemptKey = `${resolvedDeps.getActivePluginChannelRegistryVersion()}:${params.channel}`;
  if (bootstrapAttempts.has(attemptKey)) {
    return;
  }
  bootstrapAttempts.add(attemptKey);

  const autoEnabled = resolvedDeps.applyPluginAutoEnable({ config: cfg });
  const defaultAgentId = resolvedDeps.resolveDefaultAgentId(autoEnabled.config);
  const workspaceDir = resolvedDeps.resolveAgentWorkspaceDir(autoEnabled.config, defaultAgentId);
  try {
    resolvedDeps.resolveRuntimePluginRegistry({
      config: autoEnabled.config,
      activationSourceConfig: cfg,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      workspaceDir,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  } catch {
    bootstrapAttempts.delete(attemptKey);
  }
}

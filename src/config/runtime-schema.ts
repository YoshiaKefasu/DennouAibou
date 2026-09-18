import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  collectChannelSchemaMetadata,
  collectPluginSchemaMetadata,
} from "./channel-config-metadata.js";
import { loadConfig, readConfigFileSnapshot } from "./config.js";
import type { OpenClawConfig } from "./config.js";
import { buildConfigSchema, type ConfigSchemaResponse } from "./schema.js";

function loadManifestRegistry(
  config: OpenClawConfig,
  loadRegistry: typeof loadPluginManifestRegistry,
  env?: NodeJS.ProcessEnv,
) {
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  return loadRegistry({
    config,
    cache: false,
    env,
    workspaceDir,
  });
}

/**
 * Injectable seams for the config and plugin-manifest boundaries.
 * Tests supply fixtures instead of mocking `./config.js` and
 * `../plugins/manifest-registry.js` at module level.
 */
export type RuntimeConfigSchemaDeps = {
  loadConfig?: typeof loadConfig;
  readConfigFileSnapshot?: typeof readConfigFileSnapshot;
  loadPluginManifestRegistry?: typeof loadPluginManifestRegistry;
};

export function loadGatewayRuntimeConfigSchema(
  deps: RuntimeConfigSchemaDeps = {},
): ConfigSchemaResponse {
  const loadConfigImpl = deps.loadConfig ?? loadConfig;
  const loadRegistry = deps.loadPluginManifestRegistry ?? loadPluginManifestRegistry;
  const config = loadConfigImpl();
  const registry = loadManifestRegistry(config, loadRegistry);
  return buildConfigSchema({
    plugins: collectPluginSchemaMetadata(registry),
    channels: collectChannelSchemaMetadata(registry),
  });
}

export async function readBestEffortRuntimeConfigSchema(
  deps: RuntimeConfigSchemaDeps = {},
): Promise<ConfigSchemaResponse> {
  const readSnapshot = deps.readConfigFileSnapshot ?? readConfigFileSnapshot;
  const loadRegistry = deps.loadPluginManifestRegistry ?? loadPluginManifestRegistry;
  const snapshot = await readSnapshot();
  const config = snapshot.valid ? snapshot.config : { plugins: { enabled: true } };
  const registry = loadManifestRegistry(config, loadRegistry);
  return buildConfigSchema({
    plugins: snapshot.valid ? collectPluginSchemaMetadata(registry) : [],
    channels: collectChannelSchemaMetadata(registry),
  });
}

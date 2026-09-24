import { vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginLoaderCache } from "../plugins/loader.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/types.js";
import { __testing as webFetchProvidersTesting } from "../plugins/web-fetch-providers.runtime.js";
import { __testing as webSearchProvidersTesting } from "../plugins/web-search-providers.runtime.js";
import { captureEnv } from "../test-utils/env.js";
import { clearSecretsRuntimeSnapshot } from "./runtime.js";

export const SECRETS_RUNTIME_INTEGRATION_TIMEOUT_MS = 300_000;
export const EMPTY_LOADABLE_PLUGIN_ORIGINS: ReadonlyMap<string, PluginOrigin> = new Map();
export type SecretsRuntimeEnvSnapshot = ReturnType<typeof captureEnv>;

export function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

export function beginSecretsRuntimeIsolationForTest(): SecretsRuntimeEnvSnapshot {
  const envSnapshot = captureEnv([
    "DENNOU_BUNDLED_PLUGINS_DIR",
    "DENNOU_DISABLE_BUNDLED_PLUGINS",
    "DENNOU_DISABLE_PLUGIN_DISCOVERY_CACHE",
    "DENNOU_VERSION",
  ]);
  delete process.env.DENNOU_BUNDLED_PLUGINS_DIR;
  process.env.DENNOU_DISABLE_PLUGIN_DISCOVERY_CACHE = "1";
  delete process.env.DENNOU_VERSION;
  return envSnapshot;
}

export function endSecretsRuntimeIsolationForTest(envSnapshot: SecretsRuntimeEnvSnapshot) {
  vi.restoreAllMocks();
  envSnapshot.restore();
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearPluginLoaderCache();
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  webSearchProvidersTesting.resetWebSearchProviderSnapshotCacheForTests();
  webFetchProvidersTesting.resetWebFetchProviderSnapshotCacheForTests();
}

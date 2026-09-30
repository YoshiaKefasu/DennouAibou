import { loadBundledCapabilityRuntimeRegistry } from "../bundled-capability-runtime.js";
import type { MediaUnderstandingProviderPlugin } from "../types.js";
import { BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS } from "./inventory/bundled-capability-metadata.js";

export type MediaUnderstandingProviderContractEntry = {
  pluginId: string;
  provider: MediaUnderstandingProviderPlugin;
};

type ManifestContractKey = "mediaUnderstandingProviders";

const VITEST_CONTRACT_PLUGIN_IDS = {
  mediaUnderstandingProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter(
    (entry) => entry.mediaUnderstandingProviderIds.length > 0,
  ).map((entry) => entry.pluginId),
} satisfies Record<ManifestContractKey, string[]>;

function loadVitestCapabilityContractEntries<T>(params: {
  contract: ManifestContractKey;
  pluginIds?: readonly string[];
  pluginSdkResolution?: "dist" | "src";
  pickEntries: (registry: ReturnType<typeof loadBundledCapabilityRuntimeRegistry>) => Array<{
    pluginId: string;
    provider: T;
  }>;
}): Array<{ pluginId: string; provider: T }> {
  const pluginIds = [...(params.pluginIds ?? VITEST_CONTRACT_PLUGIN_IDS[params.contract])];
  if (pluginIds.length === 0) {
    return [];
  }
  const bulkEntries = params.pickEntries(
    loadBundledCapabilityRuntimeRegistry({
      pluginIds,
      pluginSdkResolution: params.pluginSdkResolution ?? "dist",
    }),
  );
  const coveredPluginIds = new Set(bulkEntries.map((entry) => entry.pluginId));
  if (coveredPluginIds.size === pluginIds.length) {
    return bulkEntries;
  }
  return pluginIds.flatMap((pluginId) =>
    params
      .pickEntries(
        loadBundledCapabilityRuntimeRegistry({
          pluginIds: [pluginId],
          pluginSdkResolution: params.pluginSdkResolution ?? "dist",
        }),
      )
      .filter((entry) => entry.pluginId === pluginId),
  );
}

export function loadVitestMediaUnderstandingProviderContractRegistry(): MediaUnderstandingProviderContractEntry[] {
  return loadVitestCapabilityContractEntries({
    contract: "mediaUnderstandingProviders",
    pickEntries: (registry) =>
      registry.mediaUnderstandingProviders.map((entry) => ({
        pluginId: entry.pluginId,
        provider: entry.provider,
      })),
  });
}

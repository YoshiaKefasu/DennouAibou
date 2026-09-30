import { listBundledPluginMetadata } from "../../bundled-plugin-metadata.js";

// Build/test inventory only.
// Runtime code should prefer manifest/runtime registry queries instead of these snapshots.

export type BundledPluginContractSnapshot = {
  pluginId: string;
  providerIds: string[];
  mediaUnderstandingProviderIds: string[];
  webFetchProviderIds: string[];
  webSearchProviderIds: string[];
  toolNames: string[];
};

function uniqueStrings(values: readonly string[] | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

const BUNDLED_PLUGIN_METADATA_FOR_CAPABILITIES = listBundledPluginMetadata({
  includeChannelConfigs: false,
  includeSyntheticChannelConfigs: false,
});

export const BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS: readonly BundledPluginContractSnapshot[] =
  BUNDLED_PLUGIN_METADATA_FOR_CAPABILITIES.map(({ manifest }) => ({
    pluginId: manifest.id,
    providerIds: uniqueStrings(manifest.providers),
    mediaUnderstandingProviderIds: uniqueStrings(manifest.contracts?.mediaUnderstandingProviders),
    webFetchProviderIds: uniqueStrings(manifest.contracts?.webFetchProviders),
    webSearchProviderIds: uniqueStrings(manifest.contracts?.webSearchProviders),
    toolNames: uniqueStrings(manifest.contracts?.tools),
  }))
    .filter(
      (entry) =>
        entry.providerIds.length > 0 ||
        entry.mediaUnderstandingProviderIds.length > 0 ||
        entry.webFetchProviderIds.length > 0 ||
        entry.webSearchProviderIds.length > 0 ||
        entry.toolNames.length > 0,
    )
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));

export const BUNDLED_LEGACY_PLUGIN_ID_ALIASES = Object.fromEntries(
  BUNDLED_PLUGIN_METADATA_FOR_CAPABILITIES.flatMap(({ manifest }) =>
    (manifest.legacyPluginIds ?? []).map(
      (legacyPluginId) => [legacyPluginId, manifest.id] as const,
    ),
  ).toSorted(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

export const BUNDLED_AUTO_ENABLE_PROVIDER_PLUGIN_IDS = Object.fromEntries(
  BUNDLED_PLUGIN_METADATA_FOR_CAPABILITIES.flatMap(({ manifest }) =>
    (manifest.autoEnableWhenConfiguredProviders ?? []).map((providerId) => [
      providerId,
      manifest.id,
    ]),
  ).toSorted(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

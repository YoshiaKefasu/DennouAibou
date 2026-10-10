import { resolveProviderWebSearchPluginConfig } from "openclaw/plugin-sdk/provider-web-search";
import type { OpenClawConfig } from "../../../src/config/config.js";

/**
 * Plugin id that now owns the bundled exa/brave web search providers.
 * DEBLOAT §41: the standalone `exa` and `brave` plugins were folded into
 * `dennou-websearch`, so every credential/config path is namespaced under it.
 */
export const DENNOU_WEBSEARCH_PLUGIN_ID = "dennou-websearch";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureObject(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = target[key];
  if (isRecord(current)) {
    return current;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function resolveDennouWebSearchPluginConfig(
  config: OpenClawConfig | undefined,
): Record<string, unknown> | undefined {
  const pluginConfig = config?.plugins?.entries?.[DENNOU_WEBSEARCH_PLUGIN_ID]?.config;
  return isRecord(pluginConfig) ? pluginConfig : undefined;
}

/**
 * Resolve the provider-scoped web search config for a provider that now lives
 * inside the `dennou-websearch` plugin.
 *
 * 1. `plugins.entries["dennou-websearch"].config.<providerId>` (preferred)
 * 2. `plugins.entries["dennou-websearch"].config.webSearch.<providerId>` (compat)
 * 3. `plugins.entries.<providerId>.config.webSearch` (legacy standalone plugin)
 */
export function resolveBundledWebSearchProviderConfig(
  config: OpenClawConfig | undefined,
  providerId: string,
): Record<string, unknown> | undefined {
  const pluginConfig = resolveDennouWebSearchPluginConfig(config);
  const scoped = isRecord(pluginConfig?.[providerId]) ? pluginConfig[providerId] : undefined;
  if (scoped) {
    return scoped;
  }
  const webSearch = isRecord(pluginConfig?.webSearch) ? pluginConfig.webSearch : undefined;
  const nested = isRecord(webSearch?.[providerId]) ? webSearch[providerId] : undefined;
  if (nested) {
    return nested;
  }
  return resolveProviderWebSearchPluginConfig(config, providerId);
}

/**
 * Write `<key>` into `plugins.entries["dennou-websearch"].config.<providerId>`.
 * Mirrors `setProviderWebSearchPluginConfigValue`'s enable-on-write behavior.
 */
export function setBundledWebSearchProviderConfigValue(params: {
  configTarget: OpenClawConfig;
  providerId: string;
  key: string;
  value: unknown;
}): void {
  const plugins = ensureObject(params.configTarget as Record<string, unknown>, "plugins");
  const entries = ensureObject(plugins, "entries");
  const entry = ensureObject(entries, DENNOU_WEBSEARCH_PLUGIN_ID);
  if (entry.enabled === undefined) {
    entry.enabled = true;
  }
  const config = ensureObject(entry, "config");
  const providerConfig = ensureObject(config, params.providerId);
  providerConfig[params.key] = params.value;
}

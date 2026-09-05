import { loadBundledPluginPublicSurfaceSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

/**
 * Jiti-sync loaders for security audit collection functions.
 * Static ESM re-exports from extensions/ are forbidden because vitest
 * contracts suites run with `isolate: false` (shared module graph) and
 * mixing Jiti require-path with ESM import-path for the same module
 * triggers Node "Unexpected status" errors.
 */
export function getCollectDiscordSecurityAuditFindings() {
  const mod = loadBundledPluginPublicSurfaceSync<{
    collectDiscordSecurityAuditFindings: (...args: unknown[]) => unknown;
  }>({
    pluginId: "discord",
    artifactBasename: "contract-api.js",
  });
  return mod.collectDiscordSecurityAuditFindings;
}

export function getCollectTelegramSecurityAuditFindings() {
  const mod = loadBundledPluginPublicSurfaceSync<{
    collectTelegramSecurityAuditFindings: (...args: unknown[]) => unknown;
  }>({
    pluginId: "telegram",
    artifactBasename: "contract-api.js",
  });
  return mod.collectTelegramSecurityAuditFindings;
}

import { loadBundledPluginPublicSurfaceSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

/**
 * Jiti-sync loader for `buildTelegramModelsProviderChannelData`.
 * Static ESM re-exports from extensions/ are forbidden because vitest
 * contracts suites run with `isolate: false` (shared module graph) and
 * mixing Jiti require-path with ESM import-path for the same module
 * triggers Node "Unexpected status" errors.
 */
export function getBuildTelegramModelsProviderChannelData() {
  const mod = loadBundledPluginPublicSurfaceSync<{
    buildTelegramModelsProviderChannelData: (params: {
      providers: Array<{ id: string; count: number }>;
    }) => Record<string, unknown> | null | undefined;
  }>({
    pluginId: "telegram",
    artifactBasename: "contract-api.js",
  });
  return mod.buildTelegramModelsProviderChannelData;
}

/** Normalize a WhatsApp target (phone or group JID) to a canonical lowercase form. */
export function normalizeWhatsAppTarget(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/^whatsapp:/i, "")
    .trim();
  if (!trimmed) {
    return null;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.endsWith("@g.us")) {
    const normalized = lowered.replace(/\s+/gu, "");
    return /^\d+@g\.us$/u.test(normalized) ? normalized : null;
  }
  const digits = trimmed.replace(/\D/gu, "");
  const normalized = digits ? `+${digits}` : "";
  return /^\+\d{7,15}$/u.test(normalized) ? normalized : null;
}

/** Check if a normalized WhatsApp target is a group JID. */
export function isWhatsAppGroupJid(target: string): boolean {
  return target.toLowerCase().endsWith("@g.us");
}

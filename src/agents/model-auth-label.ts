import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveEnvApiKey, resolveUsableCustomProviderApiKey } from "./model-auth.js";
import { normalizeProviderId } from "./model-selection.js";

export function resolveModelAuthLabel(params: {
  provider?: string;
  cfg?: OpenClawConfig;
  /** @deprecated Accepted for call-site compatibility; auth profiles are removed. */
  sessionEntry?: SessionEntry;
  /** @deprecated Accepted for call-site compatibility; auth profiles are removed. */
  agentDir?: string;
}): string | undefined {
  const resolvedProvider = params.provider?.trim();
  if (!resolvedProvider) {
    return undefined;
  }

  const providerKey = normalizeProviderId(resolvedProvider);

  const envKey = resolveEnvApiKey(providerKey);
  if (envKey?.apiKey) {
    if (envKey.source.includes("OAUTH_TOKEN")) {
      return `oauth (${envKey.source})`;
    }
    return `api-key (${envKey.source})`;
  }

  const customKey = resolveUsableCustomProviderApiKey({
    cfg: params.cfg,
    provider: providerKey,
  });
  if (customKey) {
    return `api-key (models.json)`;
  }

  return "unknown";
}

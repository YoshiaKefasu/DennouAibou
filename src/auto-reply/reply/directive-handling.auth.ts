import { resolveEnvApiKey, resolveUsableCustomProviderApiKey } from "../../agents/model-auth.js";
import type { OpenClawConfig } from "../../config/config.js";
import { shortenHomePath } from "../../utils.js";
import { maskApiKey } from "../../utils/mask-api-key.js";

export type ModelAuthDetailMode = "compact" | "verbose";

export const resolveAuthLabel = async (
  provider: string,
  cfg: OpenClawConfig,
  modelsPath: string,
  agentDir?: string,
  mode: ModelAuthDetailMode = "compact",
): Promise<{ label: string; source: string }> => {
  const formatPath = (value: string) => shortenHomePath(value);
  const envKey = resolveEnvApiKey(provider);
  if (envKey) {
    const isOAuthEnv =
      envKey.source.includes("ANTHROPIC_OAUTH_TOKEN") ||
      envKey.source.toLowerCase().includes("oauth");
    const label = isOAuthEnv ? "OAuth (env)" : maskApiKey(envKey.apiKey);
    return { label, source: mode === "verbose" ? envKey.source : "" };
  }
  const customKey = resolveUsableCustomProviderApiKey({ cfg, provider })?.apiKey;
  if (customKey) {
    return {
      label: maskApiKey(customKey),
      source: mode === "verbose" ? `models.json: ${formatPath(modelsPath)}` : "",
    };
  }
  return { label: "missing", source: "missing" };
};

export const formatAuthLabel = (auth: { label: string; source: string }) => {
  if (!auth.source || auth.source === auth.label || auth.source === "missing") {
    return auth.label;
  }
  return `${auth.label} (${auth.source})`;
};

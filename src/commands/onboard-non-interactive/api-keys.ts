import { resolveEnvApiKey } from "../../agents/model-auth.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeOptionalSecretInput } from "../../utils/normalize-secret-input.js";
import type { SecretInputMode } from "../onboard-types.js";

export type NonInteractiveApiKeySource = "flag" | "env";

function parseEnvVarNameFromSourceLabel(source: string | undefined): string | undefined {
  if (!source) {
    return undefined;
  }
  const match = /^(?:shell env: |env: )([A-Z][A-Z0-9_]*)$/.exec(source.trim());
  return match?.[1];
}

export async function resolveNonInteractiveApiKey(params: {
  provider: string;
  cfg: OpenClawConfig;
  flagValue?: string;
  flagName: string;
  envVar: string;
  envVarName?: string;
  runtime: RuntimeEnv;
  agentDir?: string;
  allowProfile?: boolean;
  required?: boolean;
  secretInputMode?: SecretInputMode;
}): Promise<{ key: string; source: NonInteractiveApiKeySource; envVarName?: string } | null> {
  const flagKey = normalizeOptionalSecretInput(params.flagValue);
  const envResolved = resolveEnvApiKey(params.provider);
  const explicitEnvVar = params.envVarName?.trim();
  const explicitEnvKey = explicitEnvVar
    ? normalizeOptionalSecretInput(process.env[explicitEnvVar])
    : undefined;
  const resolvedEnvKey = envResolved?.apiKey ?? explicitEnvKey;
  const resolvedEnvVarName = parseEnvVarNameFromSourceLabel(envResolved?.source) ?? explicitEnvVar;

  const useSecretRefMode = params.secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    if (!resolvedEnvKey && flagKey) {
      params.runtime.error(
        [
          `${params.flagName} cannot be used with --secret-input-mode ref unless ${params.envVar} is set in env.`,
          `Set ${params.envVar} in env and omit ${params.flagName}, or use --secret-input-mode plaintext.`,
        ].join("\n"),
      );
      params.runtime.exit(1);
      return null;
    }
    if (resolvedEnvKey) {
      if (!resolvedEnvVarName) {
        params.runtime.error(
          [
            `--secret-input-mode ref requires an explicit environment variable for provider "${params.provider}".`,
            `Set ${params.envVar} in env and retry, or use --secret-input-mode plaintext.`,
          ].join("\n"),
        );
        params.runtime.exit(1);
        return null;
      }
      return { key: resolvedEnvKey, source: "env", envVarName: resolvedEnvVarName };
    }
  }

  if (flagKey) {
    return { key: flagKey, source: "flag" };
  }

  if (resolvedEnvKey) {
    return { key: resolvedEnvKey, source: "env", envVarName: resolvedEnvVarName };
  }

  if (params.required === false) {
    return null;
  }

  params.runtime.error(`Missing ${params.flagName} (or ${params.envVar} in env).`);
  params.runtime.exit(1);
  return null;
}

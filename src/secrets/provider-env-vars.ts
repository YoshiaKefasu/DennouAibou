import type { OpenClawConfig } from "../config/config.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";

const CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES = {
  voyage: ["VOYAGE_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "anthropic-openai": ["ANTHROPIC_API_KEY"],
  "qwen-dashscope": ["DASHSCOPE_API_KEY"],
  "cli-router": ["CLI_ROUTER_API_KEY"],
} as const;

const CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES = {
  "minimax-cn": ["MINIMAX_API_KEY"],
} as const;

type ProviderEnvVarLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Narrow view of the plugin manifest registry: only plugin auth env vars are
 * consumed here, so the seam stays small and easy to stub in tests.
 */
type ProviderManifestRegistryLike = {
  plugins: Array<{ providerAuthEnvVars?: Record<string, string[]> }>;
  diagnostics?: unknown[];
};

/**
 * Injectable seams for tests. Defaults to the real plugin manifest registry.
 */
export type ProviderEnvVarDeps = {
  loadPluginManifestRegistry?: (
    params: Parameters<typeof loadPluginManifestRegistry>[0],
  ) => ProviderManifestRegistryLike;
};

function appendUniqueEnvVarCandidates(
  target: Record<string, string[]>,
  providerId: string,
  keys: readonly string[],
) {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId || keys.length === 0) {
    return;
  }
  const bucket = (target[normalizedProviderId] ??= []);
  const seen = new Set(bucket);
  for (const key of keys) {
    const normalizedKey = key.trim();
    if (!normalizedKey || seen.has(normalizedKey)) {
      continue;
    }
    seen.add(normalizedKey);
    bucket.push(normalizedKey);
  }
}

function resolveManifestProviderAuthEnvVarCandidates(
  params?: ProviderEnvVarLookupParams,
  deps: ProviderEnvVarDeps = {},
): Record<string, string[]> {
  const loadRegistry = deps.loadPluginManifestRegistry ?? loadPluginManifestRegistry;
  const registry = loadRegistry({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
  });
  const candidates: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const plugin of registry.plugins) {
    if (!plugin.providerAuthEnvVars) {
      continue;
    }
    for (const [providerId, keys] of Object.entries(plugin.providerAuthEnvVars).toSorted(
      ([left], [right]) => left.localeCompare(right),
    )) {
      appendUniqueEnvVarCandidates(candidates, providerId, keys);
    }
  }
  return candidates;
}

export function resolveProviderAuthEnvVarCandidates(
  params?: ProviderEnvVarLookupParams,
  deps: ProviderEnvVarDeps = {},
): Record<string, readonly string[]> {
  return {
    ...resolveManifestProviderAuthEnvVarCandidates(params, deps),
    ...CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES,
  };
}

export function resolveProviderEnvVars(
  params?: ProviderEnvVarLookupParams,
  deps: ProviderEnvVarDeps = {},
): Record<string, readonly string[]> {
  return {
    ...resolveProviderAuthEnvVarCandidates(params, deps),
    ...CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES,
  };
}

/**
 * Provider auth env candidates used by generic auth resolution.
 *
 * Order matters: the first non-empty value wins for helpers such as
 * `resolveEnvApiKey()`. Bundled providers source this from plugin manifest
 * metadata so auth probes do not need to load plugin runtime.
 */
export const PROVIDER_AUTH_ENV_VAR_CANDIDATES: Record<string, readonly string[]> = {
  ...resolveProviderAuthEnvVarCandidates(),
};

/**
 * Provider env vars used for setup/default secret refs and broad secret
 * scrubbing. This can include non-model providers and may intentionally choose
 * a different preferred first env var than auth resolution.
 *
 * Bundled provider auth envs come from plugin manifests. The override map here
 * is only for true core/non-plugin providers and a few setup-specific ordering
 * overrides where generic onboarding wants a different preferred env var.
 */
export const PROVIDER_ENV_VARS: Record<string, readonly string[]> = {
  ...resolveProviderEnvVars(),
};

export function getProviderEnvVars(
  providerId: string,
  params?: ProviderEnvVarLookupParams,
  deps: ProviderEnvVarDeps = {},
): string[] {
  const providerEnvVars = resolveProviderEnvVars(params, deps);
  const envVars = Object.hasOwn(providerEnvVars, providerId)
    ? providerEnvVars[providerId]
    : undefined;
  return Array.isArray(envVars) ? [...envVars] : [];
}

const EXTRA_PROVIDER_AUTH_ENV_VARS = ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_CODING_API_KEY"] as const;

// DENNOU_API_KEY authenticates the local OpenClaw bridge itself and must
// remain available to child bridge/runtime processes.
export function listKnownProviderAuthEnvVarNames(
  params?: ProviderEnvVarLookupParams,
  deps: ProviderEnvVarDeps = {},
): string[] {
  return [
    ...new Set([
      ...Object.values(resolveProviderAuthEnvVarCandidates(params, deps)).flatMap((keys) => keys),
      ...Object.values(resolveProviderEnvVars(params, deps)).flatMap((keys) => keys),
      ...EXTRA_PROVIDER_AUTH_ENV_VARS,
    ]),
  ];
}

export function listKnownSecretEnvVarNames(
  params?: ProviderEnvVarLookupParams,
  deps: ProviderEnvVarDeps = {},
): string[] {
  return [...new Set(Object.values(resolveProviderEnvVars(params, deps)).flatMap((keys) => keys))];
}

export function omitEnvKeysCaseInsensitive(
  baseEnv: NodeJS.ProcessEnv,
  keys: Iterable<string>,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const denied = new Set<string>();
  for (const key of keys) {
    const normalizedKey = key.trim();
    if (normalizedKey) {
      denied.add(normalizedKey.toUpperCase());
    }
  }
  if (denied.size === 0) {
    return env;
  }
  for (const actualKey of Object.keys(env)) {
    if (denied.has(actualKey.toUpperCase())) {
      delete env[actualKey];
    }
  }
  return env;
}

import {
  dedupeProfileIds,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "../agents/auth-profiles.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { resolveUsableCustomProviderApiKey } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { resolveProviderUsageAuthWithPlugin } from "../plugins/provider-runtime.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import type { UsageProviderId } from "./provider-usage.types.js";

export type ProviderUsageAuthDeps = {
  loadConfig?: typeof loadConfig;
  ensureAuthProfileStore?: typeof ensureAuthProfileStore;
  dedupeProfileIds?: typeof dedupeProfileIds;
  listProfilesForProvider?: typeof listProfilesForProvider;
  resolveApiKeyForProfile?: typeof resolveApiKeyForProfile;
  resolveAuthProfileOrder?: typeof resolveAuthProfileOrder;
  resolveProviderUsageAuthWithPlugin?: typeof resolveProviderUsageAuthWithPlugin;
  resolveUsableCustomProviderApiKey?: typeof resolveUsableCustomProviderApiKey;
  normalizeSecretInput?: typeof normalizeSecretInput;
  isNonSecretApiKeyMarker?: typeof isNonSecretApiKeyMarker;
  normalizeProviderId?: typeof normalizeProviderId;
};

type ResolvedProviderUsageAuthDeps = Required<ProviderUsageAuthDeps>;

function resolveDeps(deps: ProviderUsageAuthDeps = {}): ResolvedProviderUsageAuthDeps {
  return {
    loadConfig,
    ensureAuthProfileStore,
    dedupeProfileIds,
    listProfilesForProvider,
    resolveApiKeyForProfile,
    resolveAuthProfileOrder,
    resolveProviderUsageAuthWithPlugin,
    resolveUsableCustomProviderApiKey,
    normalizeSecretInput,
    isNonSecretApiKeyMarker,
    normalizeProviderId,
    ...deps,
  };
}

export type ProviderAuth = {
  provider: UsageProviderId;
  token: string;
  accountId?: string;
};

type AuthStore = ReturnType<typeof ensureAuthProfileStore>;

type UsageAuthState = {
  cfg: OpenClawConfig;
  store: AuthStore;
  env: NodeJS.ProcessEnv;
  agentDir?: string;
};

function resolveProviderApiKeyFromConfigAndStore(params: {
  state: UsageAuthState;
  providerIds: string[];
  envDirect?: Array<string | undefined>;
  deps: ResolvedProviderUsageAuthDeps;
}): string | undefined {
  const envDirect = params.envDirect?.map(params.deps.normalizeSecretInput).find(Boolean);
  if (envDirect) {
    return envDirect;
  }

  for (const providerId of params.providerIds) {
    const key = params.deps.resolveUsableCustomProviderApiKey({
      cfg: params.state.cfg,
      provider: providerId,
    })?.apiKey;
    if (key) {
      return key;
    }
  }

  const normalizedProviderIds = new Set(
    params.providerIds
      .map((providerId) => params.deps.normalizeProviderId(providerId))
      .filter(Boolean),
  );
  const cred = [...normalizedProviderIds]
    .flatMap((providerId) => params.deps.listProfilesForProvider(params.state.store, providerId))
    .map((id) => params.state.store.profiles[id])
    .find(
      (
        profile,
      ): profile is
        | { type: "api_key"; provider: string; key: string }
        | { type: "token"; provider: string; token: string } =>
        profile?.type === "api_key" || profile?.type === "token",
    );
  if (!cred) {
    return undefined;
  }
  if (cred.type === "api_key") {
    const key = params.deps.normalizeSecretInput(cred.key);
    if (key && !params.deps.isNonSecretApiKeyMarker(key)) {
      return key;
    }
    return undefined;
  }
  const token = params.deps.normalizeSecretInput(cred.token);
  if (token && !params.deps.isNonSecretApiKeyMarker(token)) {
    return token;
  }
  return undefined;
}

async function resolveOAuthToken(params: {
  state: UsageAuthState;
  provider: string;
  deps: ResolvedProviderUsageAuthDeps;
}): Promise<ProviderAuth | null> {
  const order = params.deps.resolveAuthProfileOrder({
    cfg: params.state.cfg,
    store: params.state.store,
    provider: params.provider,
  });
  const deduped = params.deps.dedupeProfileIds(order);

  for (const profileId of deduped) {
    const cred = params.state.store.profiles[profileId];
    if (!cred || (cred.type !== "oauth" && cred.type !== "token")) {
      continue;
    }
    try {
      const resolved = await params.deps.resolveApiKeyForProfile({
        // Reuse the already-resolved config snapshot for token/ref resolution so
        // usage snapshots don't trigger a second ambient loadConfig() call.
        cfg: params.state.cfg,
        store: params.state.store,
        profileId,
        agentDir: params.state.agentDir,
      });
      if (!resolved) {
        continue;
      }
      return {
        provider: params.provider as UsageProviderId,
        token: resolved.apiKey,
        accountId:
          cred.type === "oauth" && "accountId" in cred
            ? (cred as { accountId?: string }).accountId
            : undefined,
      };
    } catch {
      // ignore
    }
  }

  return null;
}

async function resolveProviderUsageAuthViaPlugin(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
  deps: ResolvedProviderUsageAuthDeps;
}): Promise<ProviderAuth | null> {
  const resolved = await params.deps.resolveProviderUsageAuthWithPlugin({
    provider: params.provider,
    config: params.state.cfg,
    env: params.state.env,
    context: {
      config: params.state.cfg,
      agentDir: params.state.agentDir,
      env: params.state.env,
      provider: params.provider,
      resolveApiKeyFromConfigAndStore: (options) =>
        resolveProviderApiKeyFromConfigAndStore({
          state: params.state,
          providerIds: options?.providerIds ?? [params.provider],
          envDirect: options?.envDirect,
          deps: params.deps,
        }),
      resolveOAuthToken: async (options) => {
        const auth = await resolveOAuthToken({
          state: params.state,
          provider: options?.provider ?? params.provider,
          deps: params.deps,
        });
        return auth
          ? {
              token: auth.token,
              ...(auth.accountId ? { accountId: auth.accountId } : {}),
            }
          : null;
      },
    },
  });
  if (!resolved?.token) {
    return null;
  }
  return {
    provider: params.provider,
    token: resolved.token,
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
  };
}

async function resolveProviderUsageAuthFallback(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
  deps: ResolvedProviderUsageAuthDeps;
}): Promise<ProviderAuth | null> {
  const oauthToken = await resolveOAuthToken({
    state: params.state,
    provider: params.provider,
    deps: params.deps,
  });
  if (oauthToken) {
    return oauthToken;
  }

  const apiKey = resolveProviderApiKeyFromConfigAndStore({
    state: params.state,
    providerIds: [params.provider],
    deps: params.deps,
  });
  if (apiKey) {
    return {
      provider: params.provider,
      token: apiKey,
    };
  }

  return null;
}

export async function resolveProviderAuths(
  params: {
    providers: UsageProviderId[];
    auth?: ProviderAuth[];
    agentDir?: string;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  },
  deps: ProviderUsageAuthDeps = {},
): Promise<ProviderAuth[]> {
  if (params.auth) {
    return params.auth;
  }

  const resolvedDeps = resolveDeps(deps);
  const state: UsageAuthState = {
    cfg: params.config ?? resolvedDeps.loadConfig(),
    store: resolvedDeps.ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    }),
    env: params.env ?? process.env,
    agentDir: params.agentDir,
  };
  const auths: ProviderAuth[] = [];

  for (const provider of params.providers) {
    const pluginAuth = await resolveProviderUsageAuthViaPlugin({
      state,
      provider,
      deps: resolvedDeps,
    });
    if (pluginAuth) {
      auths.push(pluginAuth);
      continue;
    }
    const fallbackAuth = await resolveProviderUsageAuthFallback({
      state,
      provider,
      deps: resolvedDeps,
    });
    if (fallbackAuth) {
      auths.push(fallbackAuth);
    }
  }

  return auths;
}

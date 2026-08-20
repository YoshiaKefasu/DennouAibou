import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../../src/agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { ModelDefinitionConfig } from "../../../src/config/types.models.js";
import { registerProviders, requireProvider } from "../../../src/plugins/contracts/testkit.js";

const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn());
const bundledProviderModules = vi.hoisted(() => ({
  openAIIndexModuleUrl: new URL("../../../extensions/openai/index.ts", import.meta.url).href,
}));

type ProviderHandle = Awaited<ReturnType<typeof requireProvider>>;

type DiscoveryState = {
  runProviderCatalog: typeof import("../../../src/plugins/provider-discovery.js").runProviderCatalog;
  openAICodexProvider?: ProviderHandle;
};

type BundledProviderUnderTest = "openai-codex";

function createModelConfig(id: string, name = id): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function setRuntimeAuthStore(store?: AuthProfileStore) {
  const resolvedStore = store ?? {
    version: 1,
    profiles: {},
  };
  ensureAuthProfileStoreMock.mockReturnValue(resolvedStore);
  listProfilesForProviderMock.mockImplementation(
    (authStore: AuthProfileStore, providerId: string) =>
      Object.entries(authStore.profiles)
        .filter(([, credential]) => credential.provider === providerId)
        .map(([profileId]) => profileId),
  );
}

function setOpenAICodexProfileSnapshot() {
  setRuntimeAuthStore({
    version: 1,
    profiles: {
      "openai-codex:default": {
        type: "token",
        provider: "openai-codex",
        token: "codex-token",
      },
    },
  });
}

function runCatalog(
  state: DiscoveryState,
  params: {
    provider: ProviderHandle;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    resolveProviderApiKey?: () => { apiKey: string | undefined };
    resolveProviderAuth?: (
      providerId?: string,
      options?: { oauthMarker?: string },
    ) => {
      apiKey: string | undefined;
      discoveryApiKey?: string;
      mode: "api_key" | "oauth" | "token" | "none";
      source: "env" | "profile" | "none";
      profileId?: string;
    };
  },
) {
  return state.runProviderCatalog({
    provider: params.provider,
    config: params.config ?? {},
    env: params.env ?? ({} as NodeJS.ProcessEnv),
    resolveProviderApiKey: params.resolveProviderApiKey ?? (() => ({ apiKey: undefined })),
    resolveProviderAuth:
      params.resolveProviderAuth ??
      ((_, options) => ({
        apiKey: options?.oauthMarker,
        discoveryApiKey: undefined,
        mode: options?.oauthMarker ? "oauth" : "none",
        source: options?.oauthMarker ? "profile" : "none",
      })),
  });
}

async function importBundledProviderPlugin<T>(moduleUrl: string): Promise<T> {
  return (await import(`${moduleUrl}?t=${Date.now()}`)) as T;
}

function installDiscoveryHooks(
  state: DiscoveryState,
  providerIds: readonly BundledProviderUnderTest[],
) {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("openclaw/plugin-sdk/agent-runtime", () => {
      return {
        ensureAuthProfileStore: ensureAuthProfileStoreMock,
        listProfilesForProvider: listProfilesForProviderMock,
      };
    });
    vi.doMock("openclaw/plugin-sdk/provider-auth", () => {
      return {
        CODEX_CLI_PROFILE_ID: "openai-codex:default",
        MINIMAX_OAUTH_MARKER: "minimax-oauth",
        applyAuthProfileConfig: (config: OpenClawConfig) => config,
        buildApiKeyCredential: (
          provider: string,
          key: unknown,
          metadata?: Record<string, unknown>,
        ) => ({
          type: "api_key",
          provider,
          ...(typeof key === "string" ? { key } : {}),
          ...(metadata ? { metadata } : {}),
        }),
        buildOauthProviderAuthResult: vi.fn(),
        coerceSecretRef: (value: unknown) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null,
        ensureApiKeyFromOptionEnvOrPrompt: vi.fn(),
        ensureAuthProfileStore: ensureAuthProfileStoreMock,
        listProfilesForProvider: listProfilesForProviderMock,
        normalizeApiKeyInput: (value: unknown) => (typeof value === "string" ? value.trim() : ""),
        normalizeOptionalSecretInput: (value: unknown) =>
          typeof value === "string" && value.trim() ? value.trim() : undefined,
        resolveNonEnvSecretRefApiKeyMarker: (source: unknown) =>
          typeof source === "string" ? source : "",
        upsertAuthProfile: vi.fn(),
        validateApiKeyInput: () => undefined,
      };
    });
    ({ runProviderCatalog: state.runProviderCatalog } =
      await import("../../../src/plugins/provider-discovery.js"));

    if (providerIds.includes("openai-codex")) {
      const { default: openAIPlugin } = await importBundledProviderPlugin<{
        default: Parameters<typeof registerProviders>[0];
      }>(bundledProviderModules.openAIIndexModuleUrl);
      const registeredProviders = await registerProviders(openAIPlugin);
      state.openAICodexProvider = requireProvider(registeredProviders, "openai-codex");
    }
    setRuntimeAuthStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ensureAuthProfileStoreMock.mockReset();
    listProfilesForProviderMock.mockReset();
  });
}

export function describeOpenAICodexProviderDiscoveryContract() {
  const state = {} as DiscoveryState;

  describe("openai-codex provider discovery contract", () => {
    installDiscoveryHooks(state, ["openai-codex"]);

    it("keeps catalog disabled without stored profiles", async () => {
      await expect(runCatalog(state, { provider: state.openAICodexProvider! })).resolves.toBeNull();
    });

    it("keeps profile-gated catalog provider-owned", async () => {
      setOpenAICodexProfileSnapshot();

      await expect(
        runCatalog(state, {
          provider: state.openAICodexProvider!,
        }),
      ).resolves.toEqual({
        provider: {
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
          models: [],
        },
      });
    });
  });
}

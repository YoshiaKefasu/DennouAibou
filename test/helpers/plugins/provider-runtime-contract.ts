import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin, ProviderRuntimeModel } from "../../../src/plugins/types.js";
import {
  createProviderUsageFetch,
  makeResponse,
} from "../../../src/test-utils/provider-usage-fetch.js";
import { registerProviderPlugin, requireRegisteredProvider } from "./provider-registration.js";

const CONTRACT_SETUP_TIMEOUT_MS = 300_000;

const refreshOpenAICodexTokenMock = vi.hoisted(() => vi.fn());
const getOAuthProvidersMock = vi.hoisted(() =>
  vi.fn(() => [
    { id: "anthropic", envApiKey: "ANTHROPIC_API_KEY", oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN" },
    { id: "google", envApiKey: "GOOGLE_API_KEY", oauthTokenEnv: "GOOGLE_OAUTH_TOKEN" },
    { id: "openai-codex", envApiKey: "OPENAI_API_KEY", oauthTokenEnv: "OPENAI_OAUTH_TOKEN" },
  ]),
);
const providerRuntimeContractModules = vi.hoisted(() => ({
  googleIndexModuleUrl: new URL("../../../extensions/google/index.ts", import.meta.url).href,
  openAIIndexModuleUrl: new URL("../../../extensions/openai/index.ts", import.meta.url).href,
  openAICodexProviderRuntimeModuleId: new URL(
    "../../../extensions/openai/openai-codex-provider.runtime.js",
    import.meta.url,
  ).pathname,
}));

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
    getOAuthProviders: getOAuthProvidersMock,
  };
});

vi.mock(providerRuntimeContractModules.openAICodexProviderRuntimeModuleId, () => ({
  refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));

async function importBundledProviderPlugin<T>(moduleUrl: string): Promise<T> {
  return (await import(`${moduleUrl}?t=${Date.now()}`)) as T;
}

function createModel(overrides: Partial<ProviderRuntimeModel> & Pick<ProviderRuntimeModel, "id">) {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    api: overrides.api ?? "openai-responses",
    provider: overrides.provider ?? "demo",
    baseUrl: overrides.baseUrl ?? "https://api.example.com/v1",
    reasoning: overrides.reasoning ?? true,
    input: overrides.input ?? ["text"],
    cost: overrides.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides.contextWindow ?? 200_000,
    maxTokens: overrides.maxTokens ?? 8_192,
  } satisfies ProviderRuntimeModel;
}

type ProviderRuntimeContractFixture = {
  providerIds: string[];
  pluginId: string;
  name: string;
  load: () => Promise<{ default: Parameters<typeof registerProviderPlugin>[0]["plugin"] }>;
};

const PROVIDER_RUNTIME_CONTRACT_FIXTURES: readonly ProviderRuntimeContractFixture[] = [
  {
    providerIds: ["google", "google-gemini-cli"],
    pluginId: "google",
    name: "Google",
    load: async () =>
      await importBundledProviderPlugin<{
        default: Parameters<typeof registerProviderPlugin>[0]["plugin"];
      }>(providerRuntimeContractModules.googleIndexModuleUrl),
  },
  {
    providerIds: ["openai", "openai-codex"],
    pluginId: "openai",
    name: "OpenAI",
    load: async () =>
      await importBundledProviderPlugin<{
        default: Parameters<typeof registerProviderPlugin>[0]["plugin"];
      }>(providerRuntimeContractModules.openAIIndexModuleUrl),
  },
] as const;

const providerRuntimeContractProviders = new Map<string, ProviderPlugin>();

function requireProviderContractProvider(providerId: string): ProviderPlugin {
  const provider = providerRuntimeContractProviders.get(providerId);
  if (!provider) {
    throw new Error(`provider runtime contract fixture missing for ${providerId}`);
  }
  return provider;
}

function installRuntimeHooks() {
  beforeAll(async () => {
    providerRuntimeContractProviders.clear();
    const registeredFixtures = await Promise.all(
      PROVIDER_RUNTIME_CONTRACT_FIXTURES.map(async (fixture) => {
        const plugin = await fixture.load();
        return {
          fixture,
          providers: (
            await registerProviderPlugin({
              plugin: plugin.default,
              id: fixture.pluginId,
              name: fixture.name,
            })
          ).providers,
        };
      }),
    );
    for (const { fixture, providers } of registeredFixtures) {
      for (const providerId of fixture.providerIds) {
        providerRuntimeContractProviders.set(
          providerId,
          requireRegisteredProvider(providers, providerId, "provider"),
        );
      }
    }
  }, CONTRACT_SETUP_TIMEOUT_MS);

  beforeEach(() => {
    refreshOpenAICodexTokenMock.mockReset();
    getOAuthProvidersMock.mockClear();
  }, CONTRACT_SETUP_TIMEOUT_MS);
}

export function describeGoogleProviderRuntimeContract() {
  describe("google provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
    installRuntimeHooks();

    it("owns google direct gemini 3.1 forward-compat resolution", () => {
      const provider = requireProviderContractProvider("google");
      const model = provider.resolveDynamicModel?.({
        provider: "google",
        modelId: "gemini-3.1-pro-preview",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gemini-3-pro-preview"
              ? createModel({
                  id,
                  api: "google-generative-ai",
                  provider: "google",
                  baseUrl: "https://generativelanguage.googleapis.com",
                  reasoning: false,
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                })
              : null,
        } as never,
      });

      expect(model).toMatchObject({
        id: "gemini-3.1-pro-preview",
        provider: "google",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
        reasoning: true,
      });
    });

    it("owns gemini cli 3.1 forward-compat resolution", () => {
      const provider = requireProviderContractProvider("google-gemini-cli");
      const model = provider.resolveDynamicModel?.({
        provider: "google-gemini-cli",
        modelId: "gemini-3.1-pro-preview",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gemini-3-pro-preview"
              ? createModel({
                  id,
                  api: "google-gemini-cli",
                  provider: "google-gemini-cli",
                  baseUrl: "https://cloudcode-pa.googleapis.com",
                  reasoning: false,
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                })
              : null,
        } as never,
      });

      expect(model).toMatchObject({
        id: "gemini-3.1-pro-preview",
        provider: "google-gemini-cli",
        reasoning: true,
      });
    });

    it("owns usage-token parsing", async () => {
      const provider = requireProviderContractProvider("google-gemini-cli");
      await expect(
        provider.resolveUsageAuth?.({
          config: {} as never,
          env: {} as NodeJS.ProcessEnv,
          provider: "google-gemini-cli",
          resolveApiKeyFromConfigAndStore: () => undefined,
          resolveOAuthToken: async () => ({
            token: '{"token":"google-oauth-token"}',
            accountId: "google-account",
          }),
        }),
      ).resolves.toEqual({
        token: "google-oauth-token",
        accountId: "google-account",
      });
    });

    it("owns OAuth auth-profile formatting", () => {
      const provider = requireProviderContractProvider("google-gemini-cli");

      expect(
        provider.formatApiKey?.({
          type: "oauth",
          provider: "google-gemini-cli",
          access: "google-oauth-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          projectId: "proj-123",
        }),
      ).toBe('{"token":"google-oauth-token","projectId":"proj-123"}');
    });

    it("owns usage snapshot fetching", async () => {
      const provider = requireProviderContractProvider("google-gemini-cli");
      const mockFetch = createProviderUsageFetch(async (url) => {
        if (url.includes("cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")) {
          return makeResponse(200, {
            buckets: [
              { modelId: "gemini-3.1-pro-preview", remainingFraction: 0.4 },
              { modelId: "gemini-3.1-flash-preview", remainingFraction: 0.8 },
            ],
          });
        }
        return makeResponse(404, "not found");
      });

      const snapshot = await provider.fetchUsageSnapshot?.({
        config: {} as never,
        env: {} as NodeJS.ProcessEnv,
        provider: "google-gemini-cli",
        token: "google-oauth-token",
        timeoutMs: 5_000,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(snapshot).toMatchObject({
        provider: "google-gemini-cli",
        displayName: "Gemini",
      });
      expect(snapshot?.windows[0]).toEqual({ label: "Pro", usedPercent: 60 });
      expect(snapshot?.windows[1]?.label).toBe("Flash");
      expect(snapshot?.windows[1]?.usedPercent).toBeCloseTo(20);
    });
  });
}

export function describeOpenAIProviderRuntimeContract() {
  describe("openai provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
    installRuntimeHooks();

    it("owns openai gpt-5.4 forward-compat resolution", () => {
      const provider = requireProviderContractProvider("openai");
      const model = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-5.4-pro",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gpt-5.2-pro"
              ? createModel({
                  id,
                  provider: "openai",
                  baseUrl: "https://api.openai.com/v1",
                  input: ["text", "image"],
                })
              : null,
        } as never,
      });

      expect(model).toMatchObject({
        id: "gpt-5.4-pro",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      });
    });

    it("owns openai gpt-5.4 mini forward-compat resolution", () => {
      const provider = requireProviderContractProvider("openai");
      const model = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gpt-5-mini"
              ? createModel({
                  id,
                  provider: "openai",
                  api: "openai-responses",
                  baseUrl: "https://api.openai.com/v1",
                  input: ["text", "image"],
                  reasoning: true,
                  contextWindow: 400_000,
                  maxTokens: 128_000,
                })
              : null,
        } as never,
      });

      expect(model).toMatchObject({
        id: "gpt-5.4-mini",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 400_000,
        maxTokens: 128_000,
      });
    });

    it("owns direct openai transport normalization", () => {
      const provider = requireProviderContractProvider("openai");
      expect(
        provider.normalizeResolvedModel?.({
          provider: "openai",
          modelId: "gpt-5.4",
          model: createModel({
            id: "gpt-5.4",
            provider: "openai",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            input: ["text", "image"],
            contextWindow: 1_050_000,
            maxTokens: 128_000,
          }),
        }),
      ).toMatchObject({
        api: "openai-responses",
      });
    });

    it("owns refresh fallback for accountId extraction failures", async () => {
      const provider = requireProviderContractProvider("openai-codex");
      const credential = {
        type: "oauth" as const,
        provider: "openai-codex",
        access: "cached-access-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
      };

      refreshOpenAICodexTokenMock.mockRejectedValueOnce(
        new Error("Failed to extract accountId from token"),
      );

      await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(credential);
    });

    it("owns forward-compat codex models", () => {
      const provider = requireProviderContractProvider("openai-codex");
      const model = provider.resolveDynamicModel?.({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gpt-5.2-codex"
              ? createModel({
                  id,
                  api: "openai-codex-responses",
                  provider: "openai-codex",
                  baseUrl: "https://chatgpt.com/backend-api",
                })
              : null,
        } as never,
      });

      expect(model).toMatchObject({
        id: "gpt-5.4",
        provider: "openai-codex",
        api: "openai-codex-responses",
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      });
    });

    it("owns forward-compat codex mini models", () => {
      const provider = requireProviderContractProvider("openai-codex");
      const model = provider.resolveDynamicModel?.({
        provider: "openai-codex",
        modelId: "gpt-5.4-mini",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gpt-5.1-codex-mini"
              ? createModel({
                  id,
                  api: "openai-codex-responses",
                  provider: "openai-codex",
                  baseUrl: "https://chatgpt.com/backend-api",
                })
              : null,
        } as never,
      });

      expect(model).toMatchObject({
        id: "gpt-5.4-mini",
        provider: "openai-codex",
        api: "openai-codex-responses",
        contextWindow: 272_000,
        maxTokens: 128_000,
      });
    });

    it("owns codex transport defaults", () => {
      const provider = requireProviderContractProvider("openai-codex");
      expect(
        provider.prepareExtraParams?.({
          provider: "openai-codex",
          modelId: "gpt-5.4",
          extraParams: { temperature: 0.2 },
        }),
      ).toEqual({
        temperature: 0.2,
        transport: "auto",
      });
    });

    it("owns usage snapshot fetching", async () => {
      const provider = requireProviderContractProvider("openai-codex");
      const mockFetch = createProviderUsageFetch(async (url) => {
        if (url.includes("chatgpt.com/backend-api/wham/usage")) {
          return makeResponse(200, {
            rate_limit: {
              primary_window: {
                used_percent: 12,
                limit_window_seconds: 10800,
                reset_at: 1_705_000,
              },
            },
            plan_type: "Plus",
          });
        }
        return makeResponse(404, "not found");
      });

      await expect(
        provider.fetchUsageSnapshot?.({
          config: {} as never,
          env: {} as NodeJS.ProcessEnv,
          provider: "openai-codex",
          token: "codex-token",
          accountId: "acc-1",
          timeoutMs: 5_000,
          fetchFn: mockFetch as unknown as typeof fetch,
        }),
      ).resolves.toEqual({
        provider: "openai-codex",
        displayName: "Codex",
        windows: [{ label: "3h", usedPercent: 12, resetAt: 1_705_000_000 }],
        plan: "Plus",
      });
    });
  });
}

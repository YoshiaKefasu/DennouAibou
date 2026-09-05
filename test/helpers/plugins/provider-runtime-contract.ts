import { describe, expect, it, vi } from "vitest";
import { registerProviders, requireProvider } from "../../../src/plugins/contracts/testkit.js";
import type { ProviderRuntimeModel } from "../../../src/plugins/types.js";
import {
  createProviderUsageFetch,
  makeResponse,
} from "../../../src/test-utils/provider-usage-fetch.js";

const providerRuntimeContractModules = vi.hoisted(() => ({
  googleIndexModuleUrl: new URL("../../../extensions/google/index.ts", import.meta.url).href,
  openAIIndexModuleUrl: new URL("../../../extensions/openai/index.ts", import.meta.url).href,
}));

async function importBundledProviderPlugin<T>(moduleUrl: string): Promise<T> {
  return (await import(`${moduleUrl}?t=${Date.now()}`)) as T;
}

function createModel(overrides: Partial<ProviderRuntimeModel> & Pick<ProviderRuntimeModel, "id">) {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    api: overrides.api ?? "openai-completions",
    provider: overrides.provider ?? "demo",
    baseUrl: overrides.baseUrl ?? "https://api.example.com/v1",
    reasoning: overrides.reasoning ?? true,
    input: overrides.input ?? ["text"],
    cost: overrides.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides.contextWindow ?? 200_000,
    maxTokens: overrides.maxTokens ?? 8_192,
  } satisfies ProviderRuntimeModel;
}

export function describeGoogleProviderRuntimeContract() {
  describe("google provider runtime contract", () => {
    async function loadGoogleProviders() {
      const { default: googlePlugin } = await importBundledProviderPlugin<{
        default: Parameters<typeof registerProviders>[0];
      }>(providerRuntimeContractModules.googleIndexModuleUrl);
      return await registerProviders(googlePlugin);
    }

    it("registers google provider plugin", async () => {
      const providers = await loadGoogleProviders();
      const provider = requireProvider(providers, "google");
      expect(provider.id).toBe("google");
    });

    it("owns google direct gemini 3.1 forward-compat resolution", async () => {
      const providers = await loadGoogleProviders();
      const provider = requireProvider(providers, "google");
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

    it("owns gemini cli 3.1 forward-compat resolution", async () => {
      const providers = await loadGoogleProviders();
      const provider = requireProvider(providers, "google-gemini-cli");
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
      const providers = await loadGoogleProviders();
      const provider = requireProvider(providers, "google-gemini-cli");
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

    it("owns OAuth auth-profile formatting", async () => {
      const providers = await loadGoogleProviders();
      const provider = requireProvider(providers, "google-gemini-cli");

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
      const providers = await loadGoogleProviders();
      const provider = requireProvider(providers, "google-gemini-cli");
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
  describe("openai provider runtime contract", () => {
    async function loadOpenAIProviders() {
      const { default: openAIPlugin } = await importBundledProviderPlugin<{
        default: Parameters<typeof registerProviders>[0];
      }>(providerRuntimeContractModules.openAIIndexModuleUrl);
      return await registerProviders(openAIPlugin);
    }

    it("registers openai provider plugin", async () => {
      const providers = await loadOpenAIProviders();
      const provider = requireProvider(providers, "openai");
      expect(provider.id).toBe("openai");
    });

    it("owns openai gpt-5.4 forward-compat resolution", async () => {
      const providers = await loadOpenAIProviders();
      const provider = requireProvider(providers, "openai");
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
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      });
    });

    it("owns openai gpt-5.4 mini forward-compat resolution", async () => {
      const providers = await loadOpenAIProviders();
      const provider = requireProvider(providers, "openai");
      const model = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gpt-5-mini"
              ? createModel({
                  id,
                  provider: "openai",
                  api: "openai-completions",
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
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 400_000,
        maxTokens: 128_000,
      });
    });
  });
}

import { describe, expect, it } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";

describe("buildOpenAIProvider", () => {
  it("resolves gpt-5.4 mini and nano from GPT-5 small-model templates", () => {
    const provider = buildOpenAIProvider();
    const registry = {
      find(providerId: string, id: string) {
        if (providerId !== "openai") {
          return null;
        }
        if (id === "gpt-5-mini") {
          return {
            id,
            name: "GPT-5 mini",
            provider: "openai",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 400_000,
            maxTokens: 128_000,
          };
        }
        if (id === "gpt-5-nano") {
          return {
            id,
            name: "GPT-5 nano",
            provider: "openai",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 64_000,
          };
        }
        return null;
      },
    };

    const mini = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-mini",
      modelRegistry: registry as never,
    });
    const nano = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-nano",
      modelRegistry: registry as never,
    });

    expect(mini).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-mini",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    expect(nano).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-nano",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("surfaces gpt-5.4 mini and nano via the augmented catalog reasoningEffortMap", () => {
    const provider = buildOpenAIProvider();

    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [
        { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
        { provider: "openai", id: "gpt-5-nano", name: "GPT-5 nano" },
      ],
    } as never);

    expect(entries).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.4-mini",
        name: "gpt-5.4-mini",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        compat: {
          reasoningEffortMap: expect.objectContaining({
            xhigh: "xhigh",
            max: null,
            low: "low",
            high: "high",
          }),
        },
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.4-nano",
        name: "gpt-5.4-nano",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        compat: {
          reasoningEffortMap: expect.objectContaining({
            xhigh: "xhigh",
            max: null,
            low: "low",
            high: "high",
          }),
        },
      }),
    );
  });

  it("attaches the same reasoningEffortMap to dynamic-model resolves for the gpt-5.4 family", () => {
    const provider = buildOpenAIProvider();

    const gpt54 = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
    } as never);

    const compatWithMap = (gpt54?.compat ?? {}) as unknown as {
      reasoningEffortMap?: Record<string, string | null>;
    };
    expect(compatWithMap.reasoningEffortMap).toMatchObject({
      xhigh: "xhigh",
      max: null,
      low: "low",
      medium: "medium",
      high: "high",
      minimal: "minimal",
    });

    const gpt54Mini = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-mini",
      modelRegistry: { find: () => null },
    } as never);

    const compatMiniWithMap = (gpt54Mini?.compat ?? {}) as unknown as {
      reasoningEffortMap?: Record<string, string | null>;
    };
    expect(compatMiniWithMap.reasoningEffortMap).toMatchObject({
      xhigh: "xhigh",
      max: null,
    });
  });

  it("owns native reasoning output mode for OpenAI", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "openai",
        modelApi: "openai-completions",
        modelId: "gpt-5.4",
      } as never),
    ).toBe("native");
  });

  it("keeps GPT-5.4 family metadata aligned with native OpenAI docs", () => {
    const provider = buildOpenAIProvider();

    const openaiModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
    } as never);

    expect(openaiModel).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
  });

  it("keeps modern live selection on OpenAI 5.2+", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.0",
      } as never),
    ).toBe(false);
    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.2",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.4",
      } as never),
    ).toBe(true);
  });
});

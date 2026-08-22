import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const refreshOpenAICodexTokenMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-codex-provider.runtime.js", () => ({
  refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));

let buildOpenAICodexProviderPlugin: typeof import("./openai-codex-provider.js").buildOpenAICodexProviderPlugin;

describe("openai codex provider", () => {
  beforeAll(async () => {
    ({ buildOpenAICodexProviderPlugin } = await import("./openai-codex-provider.js"));
  });

  beforeEach(() => {
    refreshOpenAICodexTokenMock.mockReset();
  });

  it("falls back to the cached credential when accountId extraction fails", async () => {
    const provider = buildOpenAICodexProviderPlugin();
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

  it("rethrows unrelated refresh failures", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      type: "oauth" as const,
      provider: "openai-codex",
      access: "cached-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
    };
    refreshOpenAICodexTokenMock.mockRejectedValueOnce(new Error("invalid_grant"));

    await expect(provider.refreshOAuth?.(credential)).rejects.toThrow("invalid_grant");
  });

  it("merges refreshed oauth credentials", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      type: "oauth" as const,
      provider: "openai-codex",
      access: "cached-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
      email: "user@example.com",
      displayName: "User",
    };
    refreshOpenAICodexTokenMock.mockResolvedValueOnce({
      access: "next-access",
      refresh: "next-refresh",
      expires: Date.now() + 60_000,
    });

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual({
      ...credential,
      access: "next-access",
      refresh: "next-refresh",
      expires: expect.any(Number),
    });
  });

  it("returns deprecated-profile doctor guidance for legacy Codex CLI ids", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.buildAuthDoctorHint?.({
        provider: "openai-codex",
        profileId: "openai-codex:codex-cli",
        config: undefined,
        store: { version: 1, profiles: {} },
      }),
    ).toBe(
      "Deprecated profile. Run `openclaw models auth login --provider openai-codex` or `openclaw configure`.",
    );
  });

  it("owns native reasoning output mode for Codex responses", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "openai-codex",
        modelApi: "openai-codex-responses",
        modelId: "gpt-5.4",
      } as never),
    ).toBe("native");
  });

  it("resolves gpt-5.4 with native contextWindow and contextTokens both at 1_050_000 by default", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      modelRegistry: {
        find: (providerId: string, modelId: string) => {
          if (providerId === "openai-codex" && modelId === "gpt-5.3-codex") {
            return {
              id: "gpt-5.3-codex",
              name: "gpt-5.3-codex",
              provider: "openai-codex",
              api: "openai-codex-responses",
              baseUrl: "https://chatgpt.com/backend-api",
              reasoning: true,
              input: ["text", "image"] as const,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 272_000,
              maxTokens: 128_000,
            };
          }
          return undefined;
        },
      } as never,
    });

    expect(model).toMatchObject({
      id: "gpt-5.4",
      contextWindow: 1_050_000,
      contextTokens: 1_050_000,
      maxTokens: 128_000,
    });
  });

  it("resolves gpt-5.4-mini from codex templates with codex-sized limits", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4-mini",
      modelRegistry: {
        find: (providerId: string, modelId: string) => {
          if (providerId === "openai-codex" && modelId === "gpt-5.1-codex-mini") {
            return {
              id: "gpt-5.1-codex-mini",
              name: "gpt-5.1-codex-mini",
              provider: "openai-codex",
              api: "openai-codex-responses",
              baseUrl: "https://chatgpt.com/backend-api",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
              contextWindow: 272_000,
              maxTokens: 128_000,
            };
          }
          return null;
        },
      } as never,
    } as never);

    expect(model).toMatchObject({
      id: "gpt-5.4-mini",
      contextWindow: 272_000,
      maxTokens: 128_000,
      cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
    });
    expect(model).not.toHaveProperty("contextTokens");
  });

  it("augments catalog with gpt-5.4 native contextWindow and contextTokens both at 1_050_000", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [
        {
          id: "gpt-5.3-codex",
          name: "gpt-5.3-codex",
          provider: "openai-codex",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 272_000,
        },
      ],
    } as never);

    expect(entries).toContainEqual(
      expect.objectContaining({
        id: "gpt-5.4",
        contextWindow: 1_050_000,
        contextTokens: 1_050_000,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        id: "gpt-5.4-mini",
        contextWindow: 272_000,
      }),
    );
  });

  // --- Track B: configured-only forward-compat model tests ---

  function buildGpt54Template() {
    return {
      id: "gpt-5.4",
      name: "gpt-5.4",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"] as const,
      cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    };
  }

  function buildRegistryMock(findImpl?: (providerId: string, modelId: string) => unknown) {
    return {
      find: (providerId: string, modelId: string) => {
        if (findImpl) return findImpl(providerId, modelId);
        if (providerId === "openai-codex" && modelId === "gpt-5.4") {
          return buildGpt54Template();
        }
        return undefined;
      },
    } as never;
  }

  it("resolves gpt-5.5 with exact ID, text+image input, and 400k context", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.5",
      modelRegistry: buildRegistryMock(),
    });

    expect(model).toBeDefined();
    expect(model).toMatchObject({
      id: "gpt-5.5",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      contextTokens: 400_000,
      maxTokens: 128_000,
    });
  });

  it("resolves gpt-5.5-pro with exact ID, text+image input, and 1.05M context", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.5-pro",
      modelRegistry: buildRegistryMock(),
    });

    expect(model).toBeDefined();
    expect(model).toMatchObject({
      id: "gpt-5.5-pro",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
      contextTokens: 1_050_000,
      maxTokens: 128_000,
    });
  });

  it("resolves gpt-5.6-sol with exact ID, text+image input, and 1.05M context", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      modelRegistry: buildRegistryMock(),
    });

    expect(model).toBeDefined();
    expect(model).toMatchObject({
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
      contextTokens: 1_050_000,
      maxTokens: 128_000,
    });
  });

  it("resolves gpt-5.6-terra with exact ID, text+image input, and 1.05M context", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      modelRegistry: buildRegistryMock(),
    });

    expect(model).toBeDefined();
    expect(model).toMatchObject({
      id: "gpt-5.6-terra",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
      contextTokens: 1_050_000,
      maxTokens: 128_000,
    });
  });

  it("resolves gpt-5.6-luna with exact ID, text+image input, and 1.05M context", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      modelRegistry: buildRegistryMock(),
    });

    expect(model).toBeDefined();
    expect(model).toMatchObject({
      id: "gpt-5.6-luna",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
      contextTokens: 1_050_000,
      maxTokens: 128_000,
    });
  });

  it("does not resolve short gpt-5.6 alias (Platform-only)", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.6",
      modelRegistry: buildRegistryMock(),
    });

    expect(model).toBeUndefined();
  });

  it("keeps gpt-5.3-codex-spark text-only with no image in input", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
      modelRegistry: {
        find: (providerId: string, modelId: string) => {
          if (providerId === "openai-codex" && modelId === "gpt-5.3-codex") {
            return {
              id: "gpt-5.3-codex",
              name: "gpt-5.3-codex",
              provider: "openai-codex",
              api: "openai-codex-responses",
              baseUrl: "https://chatgpt.com/backend-api",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 128_000,
            };
          }
          return undefined;
        },
      } as never,
    });

    expect(model).toBeDefined();
    expect(model).toMatchObject({
      id: "gpt-5.3-codex-spark",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 128_000,
    });
    expect(model?.input).not.toContain("image");
  });

  it("does not silently substitute Sol/Terra/Luna IDs in model registry fallback", () => {
    const provider = buildOpenAICodexProviderPlugin();
    // Registry only has gpt-5.4 template — all three Sol/Terra/Luna resolve independently
    const registry = buildRegistryMock();
    const sol = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      modelRegistry: registry,
    });
    const terra = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      modelRegistry: registry,
    });
    const luna = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      modelRegistry: registry,
    });

    expect(sol?.id).toBe("gpt-5.6-sol");
    expect(terra?.id).toBe("gpt-5.6-terra");
    expect(luna?.id).toBe("gpt-5.6-luna");
    // All share the same metadata but keep their distinct IDs
    expect(sol?.contextWindow).toBe(1_050_000);
    expect(terra?.contextWindow).toBe(1_050_000);
    expect(luna?.contextWindow).toBe(1_050_000);
  });

  it("preserves provider identity: id, label, OAuth auth, baseUrl for openai-codex", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(provider.id).toBe("openai-codex");
    expect(provider.label).toBe("OpenAI Codex");
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth[0].kind).toBe("oauth");
    // Transport: normalizeResolvedModel routes through codex-responses
    const normalized = provider.normalizeResolvedModel?.({
      provider: "openai-codex",
      model: {
        id: "gpt-5.5",
        name: "gpt-5.5",
        provider: "openai-codex",
        api: "openai-responses",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
      },
    } as never);
    expect(normalized?.api).toBe("openai-codex-responses");
    expect(normalized?.baseUrl).toBe("https://chatgpt.com/backend-api");
  });

  it("does not add new Track B models to augmentModelCatalog", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [
        {
          id: "gpt-5.3-codex",
          name: "gpt-5.3-codex",
          provider: "openai-codex",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 272_000,
        },
      ],
    } as never);

    const ids = (entries as Array<{ id: string }> | undefined)?.map((e) => e?.id) ?? [];
    expect(ids).not.toContain("gpt-5.5");
    expect(ids).not.toContain("gpt-5.5-pro");
    expect(ids).not.toContain("gpt-5.6-sol");
    expect(ids).not.toContain("gpt-5.6-terra");
    expect(ids).not.toContain("gpt-5.6-luna");
  });
});

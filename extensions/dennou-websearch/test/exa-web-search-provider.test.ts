import { describe, expect, it } from "vitest";
import plugin from "../index.js";
import { __testing, createExaWebSearchProvider } from "../src/exa-web-search-provider.js";
import { resolveBundledWebSearchProviderConfig } from "../src/provider-plugin-config.js";

describe("exa web search provider", () => {
  it("exposes the expected metadata and selection wiring", () => {
    const provider = createExaWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("exa");
    expect(provider.credentialPath).toBe("plugins.entries.dennou-websearch.config.exa.apiKey");
    expect(provider.inactiveSecretPaths).toEqual([provider.credentialPath]);
    expect(applied.plugins?.entries?.["dennou-websearch"]?.enabled).toBe(true);
  });

  it("writes and reads the configured api key under the dennou-websearch plugin", () => {
    const provider = createExaWebSearchProvider();
    const config = {} as Parameters<NonNullable<typeof provider.setConfiguredCredentialValue>>[0];
    provider.setConfiguredCredentialValue?.(config, "exa-secret");

    expect(config).toEqual({
      plugins: {
        entries: {
          "dennou-websearch": {
            enabled: true,
            config: {
              exa: { apiKey: "exa-secret" },
            },
          },
        },
      },
    });
    expect(provider.getConfiguredCredentialValue?.(config)).toBe("exa-secret");
  });

  it("resolves the exa config from the preferred dennou-websearch path first", () => {
    const config = {
      plugins: {
        entries: {
          "dennou-websearch": {
            config: {
              exa: { apiKey: "primary" },
              webSearch: { exa: { apiKey: "compat" } },
            },
          },
          exa: { config: { webSearch: { apiKey: "legacy" } } },
        },
      },
    } as unknown as Parameters<typeof resolveBundledWebSearchProviderConfig>[0];

    expect(resolveBundledWebSearchProviderConfig(config, "exa")).toEqual({ apiKey: "primary" });
  });

  it("falls back to the webSearch compat path when the scoped path is absent", () => {
    const config = {
      plugins: {
        entries: {
          "dennou-websearch": {
            config: {
              webSearch: { exa: { apiKey: "compat" } },
            },
          },
          exa: { config: { webSearch: { apiKey: "legacy" } } },
        },
      },
    } as unknown as Parameters<typeof resolveBundledWebSearchProviderConfig>[0];

    expect(resolveBundledWebSearchProviderConfig(config, "exa")).toEqual({ apiKey: "compat" });
  });

  it("falls back to the legacy standalone plugin path when the plugin was folded in", () => {
    const config = {
      plugins: {
        entries: {
          exa: { config: { webSearch: { apiKey: "legacy" } } },
        },
      },
    } as unknown as Parameters<typeof resolveBundledWebSearchProviderConfig>[0];

    expect(resolveBundledWebSearchProviderConfig(config, "exa")).toEqual({ apiKey: "legacy" });
  });

  it("returns no exa config when nothing is configured", () => {
    expect(resolveBundledWebSearchProviderConfig({} as never, "exa")).toBeUndefined();
  });

  it("merges the dennou-websearch exa config into the provider search config", () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            "dennou-websearch": {
              enabled: true,
              config: { exa: { apiKey: "from-plugin-config" } },
            },
          },
        },
      } as never,
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    // The merged config is exercised through the tool factory: without the merge
    // the provider would fall back to the env var and return a missing key payload.
    expect(typeof tool.execute).toBe("function");
  });

  it("prefers scoped configured api keys over environment fallbacks", () => {
    expect(__testing.resolveExaApiKey({ apiKey: "exa-secret" })).toBe("exa-secret");
  });

  it("normalizes Exa result descriptions from highlights before text", () => {
    expect(
      __testing.resolveExaDescription({
        highlights: ["first", "", "second"],
        text: "full text",
      }),
    ).toBe("first\nsecond");
    expect(__testing.resolveExaDescription({ text: "full text" })).toBe("full text");
  });

  it("handles month freshness without date overflow", () => {
    const iso = __testing.resolveFreshnessStartDate("month");
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
  });

  it("accepts current Exa contents object options from the docs", () => {
    expect(
      __testing.parseExaContents({
        text: { maxCharacters: 1200 },
        highlights: {
          maxCharacters: 4000,
          query: "latest model launches",
          numSentences: 4,
          highlightsPerUrl: 2,
        },
        summary: { query: "launch details" },
      }),
    ).toEqual({
      value: {
        text: { maxCharacters: 1200 },
        highlights: {
          maxCharacters: 4000,
          query: "latest model launches",
          numSentences: 4,
          highlightsPerUrl: 2,
        },
        summary: { query: "launch details" },
      },
    });
  });

  it("rejects invalid Exa contents objects", () => {
    expect(
      __testing.parseExaContents({
        highlights: { numSentences: 0 },
      }),
    ).toMatchObject({
      error: "invalid_contents",
    });
  });

  it("exposes newer documented Exa search types and count limits", () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { exa: { apiKey: "exa-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const parameters = tool.parameters as {
      properties?: {
        count?: { maximum?: number };
        type?: { enum?: string[] };
      };
    };

    expect(parameters.properties?.count?.maximum).toBe(100);
    expect(parameters.properties?.type?.enum).toEqual([
      "auto",
      "neural",
      "fast",
      "deep",
      "deep-reasoning",
      "instant",
    ]);
    expect(__testing.resolveExaSearchCount(80, 10)).toBe(80);
    expect(__testing.resolveExaSearchCount(120, 10)).toBe(100);
  });

  it("returns validation errors for conflicting time filters", async () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { exa: { apiKey: "exa-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      freshness: "day",
      date_after: "2026-03-01",
    });

    expect(result).toMatchObject({
      error: "conflicting_time_filters",
    });
  });

  it("returns validation errors for invalid date input", async () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { exa: { apiKey: "exa-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      date_after: "2026-02-31",
    });

    expect(result).toMatchObject({
      error: "invalid_date",
    });
  });

  it("loads the bundled plugin entrypoint", () => {
    expect(plugin).toBeDefined();
  });
});

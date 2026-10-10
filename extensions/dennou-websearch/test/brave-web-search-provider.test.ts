import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateJsonSchemaValue } from "../../../src/plugins/schema-validator.js";
import { __testing, createBraveWebSearchProvider } from "../src/brave-web-search-provider.js";
import { resolveBundledWebSearchProviderConfig } from "../src/provider-plugin-config.js";

const braveManifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as {
  configSchema?: Record<string, unknown>;
};

describe("brave web search provider", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    restoreTestEnvs();
    global.fetch = priorFetch;
  });

  it("exposes the expected metadata and selection wiring", () => {
    const provider = createBraveWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("brave");
    expect(provider.credentialPath).toBe("plugins.entries.dennou-websearch.config.brave.apiKey");
    expect(provider.inactiveSecretPaths).toEqual([provider.credentialPath]);
    expect(applied.plugins?.entries?.["dennou-websearch"]?.enabled).toBe(true);
  });

  it("writes and reads the configured api key under the dennou-websearch plugin", () => {
    const provider = createBraveWebSearchProvider();
    const config = {} as Parameters<NonNullable<typeof provider.setConfiguredCredentialValue>>[0];
    provider.setConfiguredCredentialValue?.(config, "BSA-secret");

    expect(config).toEqual({
      plugins: {
        entries: {
          "dennou-websearch": {
            enabled: true,
            config: {
              brave: { apiKey: "BSA-secret" },
            },
          },
        },
      },
    });
    expect(provider.getConfiguredCredentialValue?.(config)).toBe("BSA-secret");
  });

  it("resolves the brave config from the preferred dennou-websearch path first", () => {
    const config = {
      plugins: {
        entries: {
          "dennou-websearch": {
            config: {
              brave: { apiKey: "primary", mode: "llm-context" },
              webSearch: { brave: { apiKey: "compat", mode: "web" } },
            },
          },
          brave: { config: { webSearch: { apiKey: "legacy" } } },
        },
      },
    } as unknown as Parameters<typeof resolveBundledWebSearchProviderConfig>[0];

    expect(resolveBundledWebSearchProviderConfig(config, "brave")).toEqual({
      apiKey: "primary",
      mode: "llm-context",
    });
  });

  it("falls back to the webSearch compat path when the scoped path is absent", () => {
    const config = {
      plugins: {
        entries: {
          "dennou-websearch": {
            config: {
              webSearch: { brave: { apiKey: "compat" } },
            },
          },
          brave: { config: { webSearch: { apiKey: "legacy" } } },
        },
      },
    } as unknown as Parameters<typeof resolveBundledWebSearchProviderConfig>[0];

    expect(resolveBundledWebSearchProviderConfig(config, "brave")).toEqual({ apiKey: "compat" });
  });

  it("falls back to the legacy standalone plugin path when the plugin was folded in", () => {
    const config = {
      plugins: {
        entries: {
          brave: { config: { webSearch: { apiKey: "legacy", mode: "llm-context" } } },
        },
      },
    } as unknown as Parameters<typeof resolveBundledWebSearchProviderConfig>[0];

    expect(resolveBundledWebSearchProviderConfig(config, "brave")).toEqual({
      apiKey: "legacy",
      mode: "llm-context",
    });
  });

  it("returns no brave config when nothing is configured", () => {
    expect(resolveBundledWebSearchProviderConfig({} as never, "brave")).toBeUndefined();
  });

  it("mirrors the dennou-websearch brave api key onto the top-level search config", async () => {
    setTestEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      } as Response;
    });
    global.fetch = mockFetch as typeof global.fetch;

    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            "dennou-websearch": {
              enabled: true,
              config: { brave: { apiKey: "BSA-plugin-config" } },
            },
          },
        },
      } as never,
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({ query: "latest gpu news" });

    const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((requestInit?.headers as Record<string, string>)?.["X-Subscription-Token"]).toBe(
      "BSA-plugin-config",
    );
  });

  it("normalizes brave language parameters and swaps reversed ui/search inputs", () => {
    expect(
      __testing.normalizeBraveLanguageParams({
        search_lang: "en-US",
        ui_lang: "ja",
      }),
    ).toEqual({
      search_lang: "jp",
      ui_lang: "en-US",
    });
    expect(__testing.normalizeBraveLanguageParams({ search_lang: "tr-TR", ui_lang: "tr" })).toEqual(
      {
        search_lang: "tr",
        ui_lang: "tr-TR",
      },
    );
    expect(__testing.normalizeBraveLanguageParams({ search_lang: "EN", ui_lang: "en-us" })).toEqual(
      {
        search_lang: "en",
        ui_lang: "en-US",
      },
    );
  });

  it("flags invalid brave language fields", () => {
    expect(
      __testing.normalizeBraveLanguageParams({
        search_lang: "xx",
      }),
    ).toEqual({ invalidField: "search_lang" });
    expect(__testing.normalizeBraveLanguageParams({ search_lang: "en-US" })).toEqual({
      invalidField: "search_lang",
    });
    expect(__testing.normalizeBraveLanguageParams({ ui_lang: "en" })).toEqual({
      invalidField: "ui_lang",
    });
  });

  it("normalizes Brave country codes and falls back unsupported values to ALL", () => {
    expect(__testing.normalizeBraveCountry("de")).toBe("DE");
    expect(__testing.normalizeBraveCountry(" VN ")).toBe("ALL");
    expect(__testing.normalizeBraveCountry("")).toBeUndefined();
  });

  it("defaults brave mode to web unless llm-context is explicitly selected", () => {
    expect(__testing.resolveBraveMode()).toBe("web");
    expect(__testing.resolveBraveMode({ mode: "llm-context" })).toBe("llm-context");
  });

  it("accepts llm-context in the dennou-websearch plugin config schema", () => {
    if (!braveManifest.configSchema) {
      throw new Error("Expected dennou-websearch manifest config schema");
    }

    const result = validateJsonSchemaValue({
      schema: braveManifest.configSchema,
      cacheKey: "test:dennou-websearch-brave-config-schema",
      value: {
        brave: {
          mode: "llm-context",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects invalid Brave mode values in the plugin config schema", () => {
    if (!braveManifest.configSchema) {
      throw new Error("Expected dennou-websearch manifest config schema");
    }

    const result = validateJsonSchemaValue({
      schema: braveManifest.configSchema,
      cacheKey: "test:dennou-websearch-brave-config-schema",
      value: {
        brave: {
          mode: "invalid-mode",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "brave.mode",
        allowedValues: ["web", "llm-context"],
      }),
    );
  });

  it("accepts the compat webSearch object in the plugin config schema", () => {
    if (!braveManifest.configSchema) {
      throw new Error("Expected dennou-websearch manifest config schema");
    }

    expect(
      validateJsonSchemaValue({
        schema: braveManifest.configSchema,
        cacheKey: "test:dennou-websearch-brave-config-schema",
        value: {
          webSearch: { brave: { apiKey: "BSA...", mode: "llm-context" } },
        },
      }).ok,
    ).toBe(true);
  });

  it("maps llm-context results into wrapped source entries", () => {
    expect(
      __testing.mapBraveLlmContextResults({
        grounding: {
          generic: [
            {
              url: "https://example.com/post",
              title: "Example",
              snippets: ["a", "", "b"],
            },
          ],
        },
      }),
    ).toEqual([
      {
        url: "https://example.com/post",
        title: "Example",
        snippets: ["a", "b"],
        siteName: "example.com",
      },
    ]);
  });

  it("returns validation errors for invalid date ranges", async () => {
    setTestEnv("BRAVE_API_KEY", "");
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { apiKey: "BSA..." },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      date_after: "2026-03-20",
      date_before: "2026-03-01",
    });

    expect(result).toMatchObject({
      error: "invalid_date_range",
    });
  });

  it("falls back unsupported country values before calling Brave", async () => {
    setTestEnv("BRAVE_API_KEY", "test-key");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      } as Response;
    });
    global.fetch = mockFetch as typeof global.fetch;

    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { apiKey: "BSA..." },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({
      query: "latest Vietnam news",
      country: "VN",
    });

    const requestUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.get("country")).toBe("ALL");
  });
});

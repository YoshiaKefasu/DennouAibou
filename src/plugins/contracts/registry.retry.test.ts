import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin, WebFetchProviderPlugin, WebSearchProviderPlugin } from "../types.js";

type MockPluginRecord = {
  id: string;
  status: "loaded" | "error";
  error?: string;
  providerIds: string[];
  webFetchProviderIds: string[];
  webSearchProviderIds: string[];
};

type MockRuntimeRegistry = {
  plugins: MockPluginRecord[];
  diagnostics: Array<{ pluginId?: string; message: string }>;
  providers: Array<{ pluginId: string; provider: ProviderPlugin }>;
  webFetchProviders: Array<{ pluginId: string; provider: WebFetchProviderPlugin }>;
  webSearchProviders: Array<{ pluginId: string; provider: WebSearchProviderPlugin }>;
};

function createMockRuntimeRegistry(params: {
  plugin: MockPluginRecord;
  providers?: Array<{ pluginId: string; provider: ProviderPlugin }>;
  webFetchProviders?: Array<{ pluginId: string; provider: WebFetchProviderPlugin }>;
  webSearchProviders?: Array<{ pluginId: string; provider: WebSearchProviderPlugin }>;
  diagnostics?: Array<{ pluginId?: string; message: string }>;
}): MockRuntimeRegistry {
  return {
    plugins: [params.plugin],
    diagnostics: params.diagnostics ?? [],
    providers: params.providers ?? [],
    webFetchProviders: params.webFetchProviders ?? [],
    webSearchProviders: params.webSearchProviders ?? [],
  };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("plugin contract registry scoped retries", () => {
  it("retries provider loads after a transient plugin-scoped runtime error", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi
      .fn()
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "provider-a",
            status: "error",
            error: "transient provider-a load failure",
            providerIds: [],
            webFetchProviderIds: [],
            webSearchProviderIds: [],
          },
          diagnostics: [{ pluginId: "provider-a", message: "transient provider-a load failure" }],
        }),
      )
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "provider-a",
            status: "loaded",
            providerIds: ["provider-a"],
            webFetchProviderIds: [],
            webSearchProviderIds: ["search-a"],
          },
          providers: [
            {
              pluginId: "provider-a",
              provider: {
                id: "provider-a",
                label: "Provider A",
                docsPath: "/providers/provider-a",
                auth: [],
              } as ProviderPlugin,
            },
          ],
        }),
      );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { resolveProviderContractProvidersForPluginIds } = await import("./registry.js");

    expect(
      resolveProviderContractProvidersForPluginIds(["provider-a"]).map((provider) => provider.id),
    ).toEqual(["provider-a"]);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(2);
  });

  it("retries web search provider loads after a transient plugin-scoped runtime error", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi
      .fn()
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "provider-b",
            status: "error",
            error: "transient search-c load failure",
            providerIds: [],
            webFetchProviderIds: [],
            webSearchProviderIds: [],
          },
          diagnostics: [{ pluginId: "provider-b", message: "transient search-c load failure" }],
        }),
      )
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "provider-b",
            status: "loaded",
            providerIds: ["provider-b"],
            webFetchProviderIds: [],
            webSearchProviderIds: ["search-c"],
          },
          webSearchProviders: [
            {
              pluginId: "provider-b",
              provider: {
                id: "search-c",
                label: "Search C",
                hint: "Search the web with Search C",
                envVars: ["SEARCH_C_API_KEY"],
                placeholder: "search-c-key",
                signupUrl: "https://example.com/search-c",
                credentialPath: "plugins.entries.provider-b.config.webSearch.apiKey",
                requiresCredential: true,
                getCredentialValue: () => undefined,
                setCredentialValue() {},
                createTool: () => ({
                  description: "search",
                  parameters: {},
                  execute: async () => ({}),
                }),
              } as WebSearchProviderPlugin,
            },
          ],
        }),
      );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { resolveWebSearchProviderContractEntriesForPluginId } = await import("./registry.js");

    expect(
      resolveWebSearchProviderContractEntriesForPluginId("provider-b").map(
        (entry) => entry.provider.id,
      ),
    ).toEqual(["search-c"]);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(2);
  });

  it("reuses the single registered provider contract for paired manifest alias ids", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi.fn().mockReturnValue(
      createMockRuntimeRegistry({
        plugin: {
          id: "openai",
          status: "loaded",
          providerIds: ["openai"],
          webFetchProviderIds: [],
          webSearchProviderIds: [],
        },
        providers: [
          {
            pluginId: "openai",
            provider: {
              id: "openai",
              label: "OpenAI",
              docsPath: "/providers/openai",
              auth: [],
            } as ProviderPlugin,
          },
        ],
      }),
    );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { requireProviderContractProvider } = await import("./registry.js");

    expect(requireProviderContractProvider("openai-codex").id).toBe("openai");
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(1);
  });

  it("retries web fetch provider loads after a transient plugin-scoped runtime error", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi
      .fn()
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "fetch-a",
            status: "error",
            error: "transient fetch-a fetch load failure",
            providerIds: [],
            webFetchProviderIds: [],
            webSearchProviderIds: [],
          },
          diagnostics: [
            { pluginId: "fetch-a", message: "transient fetch-a fetch load failure" },
          ],
        }),
      )
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "fetch-a",
            status: "loaded",
            providerIds: [],
            webFetchProviderIds: ["fetch-a"],
            webSearchProviderIds: ["fetch-a"],
          },
          webFetchProviders: [
            {
              pluginId: "fetch-a",
              provider: {
                id: "fetch-a",
                label: "Fetch A",
                hint: "Fetch with Fetch A",
                envVars: ["FETCH_A_API_KEY"],
                placeholder: "fa-...",
                signupUrl: "https://example.com/fetch-a",
                credentialPath: "plugins.entries.fetch-a.config.webFetch.apiKey",
                requiresCredential: true,
                getCredentialValue: () => undefined,
                setCredentialValue() {},
                createTool: () => ({
                  description: "fetch",
                  parameters: {},
                  execute: async () => ({}),
                }),
              } as WebFetchProviderPlugin,
            },
          ],
        }),
      );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { resolveWebFetchProviderContractEntriesForPluginId } = await import("./registry.js");

    expect(
      resolveWebFetchProviderContractEntriesForPluginId("fetch-a").map(
        (entry) => entry.provider.id,
      ),
    ).toEqual(["fetch-a"]);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(2);
  });
});

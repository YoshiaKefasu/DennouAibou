import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../../src/agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../../../src/agents/auth-profiles/types.js";
import { registerProviders, requireProvider } from "../../../src/plugins/contracts/testkit.js";
import type { ProviderPlugin } from "../../../src/plugins/types.js";

type RunProviderCatalog =
  (typeof import("../../../src/plugins/provider-discovery.js"))["runProviderCatalog"];
type EnsureAuthProfileStore =
  typeof import("openclaw/plugin-sdk/provider-auth").ensureAuthProfileStore;
type ListProfilesForProvider =
  typeof import("openclaw/plugin-sdk/provider-auth").listProfilesForProvider;

type DiscoveryState = {
  runProviderCatalog: RunProviderCatalog;
  openAIProvider?: ProviderPlugin;
};

type BundledProviderUnderTest = "openai";

const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn<EnsureAuthProfileStore>());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn<ListProfilesForProvider>());
const bundledProviderModules = vi.hoisted(() => ({
  openAIIndexModuleUrl: new URL("../../../extensions/openai/index.ts", import.meta.url).href,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-auth")>(
    "openclaw/plugin-sdk/provider-auth",
  );
  return {
    ...actual,
    ensureAuthProfileStore: ensureAuthProfileStoreMock,
    listProfilesForProvider: listProfilesForProviderMock,
  };
});

async function importBundledProviderPlugin<T>(moduleUrl: string): Promise<T> {
  return (await import(moduleUrl)) as T;
}

function installDiscoveryHooks(state: DiscoveryState, providerIds: BundledProviderUnderTest[]) {
  beforeEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    vi.mock("openclaw/plugin-sdk/provider-auth", async () => {
      const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-auth")>(
        "openclaw/plugin-sdk/provider-auth",
      );
      return {
        ...actual,
        ensureAuthProfileStore: ensureAuthProfileStoreMock,
        listProfilesForProvider: listProfilesForProviderMock,
      };
    });
    ({ runProviderCatalog: state.runProviderCatalog } =
      await import("../../../src/plugins/provider-discovery.js"));

    if (providerIds.includes("openai")) {
      const { default: openAIPlugin } = await importBundledProviderPlugin<{
        default: Parameters<typeof registerProviders>[0];
      }>(bundledProviderModules.openAIIndexModuleUrl);
      const registeredProviders = await registerProviders(openAIPlugin);
      state.openAIProvider = requireProvider(registeredProviders, "openai");
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ensureAuthProfileStoreMock.mockReset();
    listProfilesForProviderMock.mockReset();
  });
}

export function describeOpenAICodexProviderDiscoveryContract() {
  const state = {} as DiscoveryState;

  describe("openai provider discovery contract", () => {
    installDiscoveryHooks(state, ["openai"]);

    it("registers OpenAI provider plugin successfully", () => {
      expect(state.openAIProvider?.id).toBe("openai");
    });
  });
}

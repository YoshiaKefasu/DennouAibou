import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../../src/agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../../../src/agents/auth-profiles/types.js";
import { registerProviders, requireProvider } from "../../../src/plugins/contracts/testkit.js";
import { createNonExitingRuntime } from "../../../src/runtime.js";
import type {
  WizardMultiSelectParams,
  WizardPrompter,
  WizardProgress,
  WizardSelectParams,
} from "../../../src/wizard/prompts.js";

type EnsureAuthProfileStore =
  typeof import("openclaw/plugin-sdk/provider-auth").ensureAuthProfileStore;
type ListProfilesForProvider =
  typeof import("openclaw/plugin-sdk/provider-auth").listProfilesForProvider;

const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn<EnsureAuthProfileStore>());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn<ListProfilesForProvider>());
const providerAuthContractModules = vi.hoisted(() => ({
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

function createDummyPrompter(): WizardPrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn(
      async (params: WizardSelectParams) => params.options[0]?.value,
    ) as WizardPrompter["select"],
    multiselect: vi.fn(async (params: WizardMultiSelectParams) =>
      params.options.map((o) => o.value),
    ) as WizardPrompter["multiselect"],
    text: vi.fn(async () => "test-api-key"),
    confirm: vi.fn(async () => true),
    progress: vi.fn(
      () =>
        ({
          start: vi.fn(),
          stop: vi.fn(),
        }) as unknown as WizardProgress,
    ),
  };
}

function buildAuthContext() {
  return {
    prompter: createDummyPrompter(),
    runtime: createNonExitingRuntime(),
    isRemote: false,
    options: {},
  };
}

function installSharedAuthProfileStoreHooks(state: { authStore: AuthProfileStore }) {
  beforeEach(() => {
    state.authStore = { version: 1, profiles: {} };
    clearRuntimeAuthProfileStoreSnapshots();
    ensureAuthProfileStoreMock.mockImplementation(() => {
      return state.authStore;
    });
    listProfilesForProviderMock.mockImplementation((_store, provider) => {
      return Object.entries(state.authStore.profiles)
        .filter(([, profile]) => profile.provider === provider)
        .map(([id]) => id);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
}

export function describeOpenAICodexProviderAuthContract() {
  const state = {
    authStore: { version: 1, profiles: {} } as AuthProfileStore,
  };

  describe("openai provider auth contract", () => {
    installSharedAuthProfileStoreHooks(state);

    it("registers OpenAI api-key auth method", async () => {
      const { default: openAIPlugin } = await importBundledProviderPlugin<{
        default: Parameters<typeof registerProviders>[0];
      }>(providerAuthContractModules.openAIIndexModuleUrl);
      const provider = requireProvider(await registerProviders(openAIPlugin), "openai");

      expect(provider.auth[0]).toMatchObject({
        id: "api-key",
        kind: "api_key",
      });
    });
  });
}

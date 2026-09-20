import { describe, expect, it, vi } from "vitest";
import type { resolveProviderPluginChoice } from "../plugins/provider-wizard.js";
import type { resolvePluginProviders } from "../plugins/providers.runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { promptAuthConfig } from "./configure.gateway-auth.js";

const deps = {
  ensureAuthProfileStore: vi.fn(() => ({
    version: 1,
    profiles: {},
  })),
  resolveDefaultAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  promptAuthChoiceGrouped: vi.fn(),
  applyAuthChoice: vi.fn(),
  resolvePreferredProviderForAuthChoice: vi.fn<() => Promise<string | undefined>>(
    async () => undefined,
  ),
  promptModelAllowlist: vi.fn(),
  promptDefaultModel: vi.fn(),
  promptCustomApiConfig: vi.fn(),
  resolvePluginProviders: vi.fn() as MockFn<typeof resolvePluginProviders>,
  resolveProviderPluginChoice: vi.fn(() => null) as MockFn<typeof resolveProviderPluginChoice>,
};

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

const noopPrompter = {} as WizardPrompter;

function createKilocodeProvider() {
  return {
    baseUrl: "https://api.kilo.ai/api/gateway/",
    api: "openai-completions",
    models: [
      { id: "kilo/auto", name: "Kilo Auto" },
      { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
    ],
  };
}

function createApplyAuthChoiceConfig(includeMinimaxProvider = false) {
  return {
    config: {
      agents: {
        defaults: {
          model: { primary: "kilocode/kilo/auto" },
        },
      },
      models: {
        providers: {
          kilocode: createKilocodeProvider(),
          ...(includeMinimaxProvider
            ? {
                minimax: {
                  baseUrl: "https://api.minimax.io/anthropic",
                  api: "anthropic-messages",
                  models: [{ id: "MiniMax-M2.7", name: "MiniMax M2.7" }],
                },
              }
            : {}),
        },
      },
    },
  };
}

async function runPromptAuthConfigWithAllowlist(includeMinimaxProvider = false) {
  deps.promptAuthChoiceGrouped.mockResolvedValue("kilocode-api-key");
  deps.applyAuthChoice.mockResolvedValue(createApplyAuthChoiceConfig(includeMinimaxProvider));
  deps.promptModelAllowlist.mockResolvedValue({
    models: ["kilocode/kilo/auto"],
  });
  deps.resolvePluginProviders.mockReturnValue([]);
  deps.resolveProviderPluginChoice.mockReturnValue(null);

  return promptAuthConfig({}, makeRuntime(), noopPrompter, deps);
}

describe("promptAuthConfig", () => {
  it("keeps Kilo provider models while applying allowlist defaults", async () => {
    const result = await runPromptAuthConfigWithAllowlist();
    expect(result.models?.providers?.kilocode?.models?.map((model) => model.id)).toEqual([
      "kilo/auto",
      "anthropic/claude-sonnet-4",
    ]);
    expect(Object.keys(result.agents?.defaults?.models ?? {})).toEqual(["kilocode/kilo/auto"]);
  });

  it("does not mutate provider model catalogs when allowlist is set", async () => {
    const result = await runPromptAuthConfigWithAllowlist(true);
    expect(result.models?.providers?.kilocode?.models?.map((model) => model.id)).toEqual([
      "kilo/auto",
      "anthropic/claude-sonnet-4",
    ]);
    expect(result.models?.providers?.minimax?.models?.map((model) => model.id)).toEqual([
      "MiniMax-M2.7",
    ]);
  });

  it("uses plugin-owned allowlist metadata for provider auth choices", async () => {
    deps.promptAuthChoiceGrouped.mockResolvedValue("token");
    deps.applyAuthChoice.mockResolvedValue({ config: {} });
    deps.promptModelAllowlist.mockResolvedValue({ models: undefined });
    deps.resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "anthropic", label: "Anthropic", auth: [] },
      method: {
        id: "setup-token",
        label: "setup-token",
        kind: "token",
        run: async () => ({ profiles: [] }),
      },
      wizard: {
        modelAllowlist: {
          allowedKeys: ["anthropic/claude-sonnet-4-6"],
          initialSelections: ["anthropic/claude-sonnet-4-6"],
          message: "Anthropic OAuth models",
        },
      },
    });

    await promptAuthConfig({}, makeRuntime(), noopPrompter, deps);

    expect(deps.promptModelAllowlist).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedKeys: ["anthropic/claude-sonnet-4-6"],
        initialSelections: ["anthropic/claude-sonnet-4-6"],
        message: "Anthropic OAuth models",
      }),
    );
  });

  it("scopes the allowlist picker to the selected provider when available", async () => {
    deps.promptAuthChoiceGrouped.mockResolvedValue("openai-api-key");
    deps.resolvePreferredProviderForAuthChoice.mockResolvedValue("openai");
    deps.applyAuthChoice.mockResolvedValue({ config: {} });
    deps.promptModelAllowlist.mockResolvedValue({ models: undefined });

    await promptAuthConfig({}, makeRuntime(), noopPrompter, deps);

    expect(deps.promptModelAllowlist).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredProvider: "openai",
      }),
    );
  });
});

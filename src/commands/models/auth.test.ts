import { cancel } from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  clearAuthProfileCooldown,
  listProfilesForProvider,
  loadAuthProfileStoreForRuntime,
  upsertAuthProfile,
} from "../../agents/auth-profiles.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { resolvePluginProviders } from "../../plugins/providers.runtime.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { MockFn } from "../../test-utils/vitest-mock-fn.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { openUrl } from "../onboard-helpers.js";
import {
  modelsAuthLoginCommand,
  modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand,
} from "./auth.js";
import { loadValidConfigOrThrow, updateConfig } from "./shared.js";

const deps = {
  loadConfig: vi.fn() as MockFn<typeof loadValidConfigOrThrow>,
  updateConfig: vi.fn() as MockFn<typeof updateConfig>,
  resolveAgentId: vi.fn() as MockFn<typeof resolveDefaultAgentId>,
  resolveAgentDir: vi.fn() as MockFn<typeof resolveAgentDir>,
  resolveAgentWorkspaceDir: vi.fn() as MockFn<typeof resolveAgentWorkspaceDir>,
  resolveDefaultWorkspaceDir: vi.fn() as MockFn<typeof resolveDefaultAgentWorkspaceDir>,
  resolvePluginProviders: vi.fn() as MockFn<typeof resolvePluginProviders>,
  upsertAuthProfile: vi.fn() as MockFn<typeof upsertAuthProfile>,
  loadAuthProfileStore: vi.fn() as MockFn<typeof loadAuthProfileStoreForRuntime>,
  listProfilesForProvider: vi.fn() as MockFn<typeof listProfilesForProvider>,
  clearAuthProfileCooldown: vi.fn() as MockFn<typeof clearAuthProfileCooldown>,
  logConfigUpdated: vi.fn() as MockFn<typeof logConfigUpdated>,
  createPrompter: vi.fn() as MockFn<typeof createClackPrompter>,
  checkInteractiveStdin: vi.fn(() => true),
  promptText: vi.fn(),
  promptSelect: vi.fn(),
  promptConfirm: vi.fn(),
  openUrl: vi.fn() as MockFn<typeof openUrl>,
};

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function createProvider(params: {
  id: string;
  label?: string;
  run: NonNullable<ProviderPlugin["auth"]>[number]["run"];
}): ProviderPlugin {
  return {
    id: params.id,
    label: params.label ?? params.id,
    auth: [
      {
        id: "oauth",
        label: "OAuth",
        kind: "oauth",
        run: params.run,
      },
    ],
  };
}

describe("modelsAuthLoginCommand", () => {
  let currentConfig: OpenClawConfig;
  let lastUpdatedConfig: OpenClawConfig | null;
  let runProviderAuth: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps.checkInteractiveStdin.mockReturnValue(true);
    currentConfig = {};
    lastUpdatedConfig = null;
    deps.promptText.mockReset();
    deps.promptConfirm.mockReset();
    deps.upsertAuthProfile.mockReset();

    deps.resolveAgentId.mockReturnValue("main");
    deps.resolveAgentDir.mockReturnValue("/tmp/openclaw/agents/main");
    deps.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    deps.resolveDefaultWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    deps.loadConfig.mockImplementation(async () => currentConfig);
    deps.updateConfig.mockImplementation(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => {
        lastUpdatedConfig = mutator(currentConfig);
        currentConfig = lastUpdatedConfig;
        return lastUpdatedConfig;
      },
    );
    deps.createPrompter.mockReturnValue({
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select: vi.fn(),
      multiselect: vi.fn(async () => []),
      text: vi.fn(async () => ""),
      confirm: vi.fn(async () => true),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    });
    runProviderAuth = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "openai-codex:user@example.com",
          credential: {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            email: "user@example.com",
          },
        },
      ],
      defaultModel: "openai-codex/gpt-5.4",
    });
    deps.resolvePluginProviders.mockReturnValue([
      createProvider({
        id: "openai-codex",
        label: "OpenAI Codex",
        run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
      }),
    ]);
    deps.loadAuthProfileStore.mockReturnValue({ version: 1, profiles: {}, usageStats: {} });
    deps.listProfilesForProvider.mockReturnValue([]);
    deps.clearAuthProfileCooldown.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs plugin-owned openai-codex login", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime, deps);

    expect(runProviderAuth).toHaveBeenCalledOnce();
    expect(deps.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "openai-codex:user@example.com",
      credential: expect.objectContaining({
        type: "oauth",
        provider: "openai-codex",
      }),
      agentDir: "/tmp/openclaw/agents/main",
    });
    expect(lastUpdatedConfig?.auth?.profiles?.["openai-codex:user@example.com"]).toMatchObject({
      provider: "openai-codex",
      mode: "oauth",
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Auth profile: openai-codex:user@example.com (openai-codex/oauth)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Default model available: openai-codex/gpt-5.4 (use --set-default to apply)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Tip: Codex-capable models can use native Codex web search. Enable it with openclaw configure --section web (recommended mode: cached). Docs: https://docs.openclaw.ai/tools/web",
    );
  });

  it("applies openai-codex default model when --set-default is used", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand({ provider: "openai-codex", setDefault: true }, runtime, deps);

    expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual({
      primary: "openai-codex/gpt-5.4",
    });
    expect(runtime.log).toHaveBeenCalledWith("Default model set to openai-codex/gpt-5.4");
  });

  it("clears stale auth lockouts before attempting openai-codex login", async () => {
    const runtime = createRuntime();
    const fakeStore = {
      version: 1 as const,
      profiles: {
        "openai-codex:user@example.com": {
          type: "oauth" as const,
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 3_600_000,
        },
      },
      usageStats: {
        "openai-codex:user@example.com": {
          disabledUntil: Date.now() + 3_600_000,
          disabledReason: "auth_permanent" as const,
          errorCount: 3,
        },
      },
    };
    deps.loadAuthProfileStore.mockReturnValue(fakeStore);
    deps.listProfilesForProvider.mockReturnValue(["openai-codex:user@example.com"]);

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime, deps);

    expect(deps.clearAuthProfileCooldown).toHaveBeenCalledWith({
      store: fakeStore,
      profileId: "openai-codex:user@example.com",
      agentDir: "/tmp/openclaw/agents/main",
    });
    // Verify clearing happens before login attempt
    const clearOrder = deps.clearAuthProfileCooldown.mock.invocationCallOrder[0];
    const loginOrder = runProviderAuth.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(loginOrder);
  });

  it("survives lockout clearing failure without blocking login", async () => {
    const runtime = createRuntime();
    deps.loadAuthProfileStore.mockImplementation(() => {
      throw new Error("corrupt auth-profiles.json");
    });

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime, deps);

    expect(runProviderAuth).toHaveBeenCalledOnce();
  });

  it("loads lockout state from the agent-scoped store", async () => {
    const runtime = createRuntime();
    deps.loadAuthProfileStore.mockReturnValue({ version: 1, profiles: {}, usageStats: {} });
    deps.listProfilesForProvider.mockReturnValue([]);

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime, deps);

    expect(deps.loadAuthProfileStore).toHaveBeenCalledWith("/tmp/openclaw/agents/main");
  });

  it("reports loaded plugin providers when requested provider is unavailable", async () => {
    const runtime = createRuntime();

    await expect(modelsAuthLoginCommand({ provider: "anthropic" }, runtime, deps)).rejects.toThrow(
      'Unknown provider "anthropic". Loaded providers: openai-codex. Verify plugins via `openclaw plugins list --json`.',
    );
  });

  it("does not persist a cancelled manual token entry", async () => {
    const runtime = createRuntime();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${String(code ?? "")}`);
    }) as typeof process.exit);
    try {
      const cancelSymbol = Symbol.for("clack:cancel");
      deps.promptText.mockImplementation(async () => {
        cancel("Cancelled.");
        process.exit(0);
      });
      void cancelSymbol;

      await expect(
        modelsAuthPasteTokenCommand({ provider: "openai" }, runtime, deps),
      ).rejects.toThrow("exit:0");

      expect(deps.upsertAuthProfile).not.toHaveBeenCalled();
      expect(deps.updateConfig).not.toHaveBeenCalled();
      expect(deps.logConfigUpdated).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("writes pasted tokens to the resolved agent store", async () => {
    const runtime = createRuntime();
    deps.promptText.mockResolvedValue("tok-fresh");

    await modelsAuthPasteTokenCommand({ provider: "openai" }, runtime, deps);

    expect(deps.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "openai:manual",
      credential: {
        type: "token",
        provider: "openai",
        token: "tok-fresh",
      },
      agentDir: "/tmp/openclaw/agents/main",
    });
  });

  it("writes pasted Anthropic setup-tokens and logs the legacy warning", async () => {
    const runtime = createRuntime();
    deps.promptText.mockResolvedValue(`sk-ant-oat01-${"a".repeat(80)}`);

    await modelsAuthPasteTokenCommand({ provider: "anthropic" }, runtime, deps);

    expect(deps.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "anthropic:manual",
      credential: {
        type: "token",
        provider: "anthropic",
        token: `sk-ant-oat01-${"a".repeat(80)}`,
      },
      agentDir: "/tmp/openclaw/agents/main",
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Anthropic setup-token auth is a legacy/manual path in OpenClaw.",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Anthropic told OpenClaw users this path requires Extra Usage on the Claude account.",
    );
  });

  it("runs token auth for any token-capable provider plugin", async () => {
    const runtime = createRuntime();
    const runTokenAuth = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "moonshot:token",
          credential: {
            type: "token",
            provider: "moonshot",
            token: "moonshot-token",
          },
        },
      ],
    });
    deps.resolvePluginProviders.mockReturnValue([
      {
        id: "moonshot",
        label: "Moonshot",
        auth: [
          {
            id: "setup-token",
            label: "setup-token",
            kind: "token",
            run: runTokenAuth,
          },
        ],
      },
    ]);

    await modelsAuthSetupTokenCommand({ provider: "moonshot", yes: true }, runtime, deps);

    expect(runTokenAuth).toHaveBeenCalledOnce();
    expect(deps.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "moonshot:token",
      credential: {
        type: "token",
        provider: "moonshot",
        token: "moonshot-token",
      },
      agentDir: "/tmp/openclaw/agents/main",
    });
  });

  it("runs setup-token for Anthropic when the provider exposes the method", async () => {
    const runtime = createRuntime();
    const runTokenAuth = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "anthropic:default",
          credential: {
            type: "token",
            provider: "anthropic",
            token: `sk-ant-oat01-${"b".repeat(80)}`,
          },
        },
      ],
      defaultModel: "anthropic/claude-sonnet-4-6",
    });
    deps.resolvePluginProviders.mockReturnValue([
      {
        id: "anthropic",
        label: "Anthropic",
        auth: [
          {
            id: "setup-token",
            label: "setup-token",
            kind: "token",
            run: runTokenAuth,
          },
        ],
      },
    ]);

    await modelsAuthSetupTokenCommand({ provider: "anthropic", yes: true }, runtime, deps);

    expect(runTokenAuth).toHaveBeenCalledOnce();
    expect(deps.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "anthropic:default",
      credential: {
        type: "token",
        provider: "anthropic",
        token: `sk-ant-oat01-${"b".repeat(80)}`,
      },
      agentDir: "/tmp/openclaw/agents/main",
    });
  });
});

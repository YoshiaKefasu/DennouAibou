import { beforeAll, describe, expect, it, type Mock, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    resolveOpenClawAgentDir: vi.fn().mockReturnValue("/tmp/openclaw-agent"),
    resolveAgentDir: vi.fn().mockReturnValue("/tmp/openclaw-agent"),
    resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/openclaw-agent/workspace"),
    resolveAgentExplicitModelPrimary: vi.fn().mockReturnValue(undefined),
    resolveAgentEffectiveModelPrimary: vi.fn().mockReturnValue(undefined),
    resolveAgentModelFallbacksOverride: vi.fn().mockReturnValue(undefined),
    listAgentIds: vi.fn().mockReturnValue(["main", "jeremiah"]),
    resolveEnvApiKey: vi.fn((provider: string) => {
      if (provider === "openai") {
        return {
          apiKey: "sk-openai-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
          source: "shell env: OPENAI_API_KEY",
        };
      }
      if (provider === "anthropic") {
        return {
          apiKey: "sk-ant-oat01-ACCESS-TOKEN-1234567890", // pragma: allowlist secret
          source: "env: ANTHROPIC_OAUTH_TOKEN",
        };
      }
      return null;
    }),
    resolveProviderEnvApiKeyCandidates: vi.fn().mockReturnValue({
      anthropic: ["ANTHROPIC_API_KEY"],
      google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      minimax: ["MINIMAX_API_KEY"],
      "minimax-portal": ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      "openai-codex": ["OPENAI_OAUTH_TOKEN"],
      fal: ["FAL_KEY"],
    }),
    listKnownProviderEnvApiKeyNames: vi
      .fn()
      .mockReturnValue([
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "MINIMAX_API_KEY",
        "MINIMAX_OAUTH_TOKEN",
        "OPENAI_API_KEY",
        "OPENAI_OAUTH_TOKEN",
        "FAL_KEY",
      ]),
    hasUsableCustomProviderApiKey: vi.fn().mockReturnValue(false),
    resolveUsableCustomProviderApiKey: vi.fn().mockReturnValue(null),
    getCustomProviderApiKey: vi.fn().mockReturnValue(undefined),
    getShellEnvAppliedKeys: vi.fn().mockReturnValue(["OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]),
    shouldEnableShellEnvFallback: vi.fn().mockReturnValue(true),
    createConfigIO: vi.fn().mockReturnValue({
      configPath: "/tmp/openclaw-dev/dennou-aibou.json",
    }),
    loadConfig: vi.fn().mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] },
          models: { "anthropic/claude-opus-4-6": { alias: "Opus" } },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    }),
  };
});

let modelsStatusCommand: typeof import("./list.status-command.js").modelsStatusCommand;

vi.mock("../../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
}));
vi.mock("../../agents/agent-scope.js", () => ({
  listAgentEntries: vi.fn(() => []),
  listAgentIds: mocks.listAgentIds,
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveSessionAgentIds: vi.fn(({ agentId }: { agentId?: string }) => ({
    sessionAgentId: agentId ?? "main",
  })),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveAgentConfig: vi.fn(() => undefined),
  resolveAgentSkillsFilter: vi.fn(() => undefined),
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveAgentExplicitModelPrimary: mocks.resolveAgentExplicitModelPrimary,
  resolveAgentEffectiveModelPrimary: mocks.resolveAgentEffectiveModelPrimary,
  resolveAgentModelPrimary: vi.fn(() => undefined),
  resolveAgentModelFallbacksOverride: mocks.resolveAgentModelFallbacksOverride,
  resolveFallbackAgentId: vi.fn(() => undefined),
  resolveRunModelFallbacksOverride: vi.fn(() => undefined),
  hasConfiguredModelFallbacks: vi.fn(() => false),
  resolveEffectiveModelFallbacks: vi.fn(() => undefined),
  resolveAgentIdsByWorkspacePath: vi.fn(() => []),
  resolveAgentIdByWorkspacePath: vi.fn(() => undefined),
}));
vi.mock("../../agents/model-auth.js", () => ({
  resolveEnvApiKey: mocks.resolveEnvApiKey,
  hasUsableCustomProviderApiKey: mocks.hasUsableCustomProviderApiKey,
  resolveUsableCustomProviderApiKey: mocks.resolveUsableCustomProviderApiKey,
  getCustomProviderApiKey: mocks.getCustomProviderApiKey,
}));
vi.mock("../../agents/model-auth-env-vars.js", () => ({
  resolveProviderEnvApiKeyCandidates: mocks.resolveProviderEnvApiKeyCandidates,
  listKnownProviderEnvApiKeyNames: mocks.listKnownProviderEnvApiKeyNames,
}));
vi.mock("../../infra/shell-env.js", () => ({
  getShellEnvAppliedKeys: mocks.getShellEnvAppliedKeys,
  shouldEnableShellEnvFallback: mocks.shouldEnableShellEnvFallback,
}));
// Full factory: Bun cannot resolve the partial self-import for config.js.
vi.mock("../../config/config.js", () => ({
  createConfigIO: mocks.createConfigIO,
  loadConfig: mocks.loadConfig,
  getRuntimeConfigSourceSnapshot: vi.fn(() => null),
  projectConfigOntoRuntimeSourceSnapshot: vi.fn((value: unknown) => value),
  clearConfigCache: vi.fn(),
  clearRuntimeConfigSnapshot: vi.fn(),
  readConfigFileSnapshot: vi.fn(async () => ({ valid: false })),
  replaceConfigFile: vi.fn(),
  mutateConfigFile: vi.fn(),
  ConfigMutationConflictError: class ConfigMutationConflictError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ConfigMutationConflictError";
    }
  },
}));
vi.mock("./load-config.js", () => ({
  loadModelsConfig: vi.fn(async () => mocks.loadConfig()),
}));

async function loadFreshModelsStatusCommandModuleForTest() {
  ({ modelsStatusCommand } = await import("./list.status-command.js"));
}

const defaultResolveEnvApiKeyImpl:
  | ((provider: string) => { apiKey: string; source: string } | null)
  | undefined = mocks.resolveEnvApiKey.getMockImplementation();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

async function withAgentScopeOverrides<T>(
  overrides: {
    primary?: string;
    fallbacks?: string[];
    agentDir?: string;
  },
  run: () => Promise<T>,
) {
  const originalPrimary = mocks.resolveAgentExplicitModelPrimary.getMockImplementation();
  const originalEffectivePrimary = mocks.resolveAgentEffectiveModelPrimary.getMockImplementation();
  const originalFallbacks = mocks.resolveAgentModelFallbacksOverride.getMockImplementation();
  const originalAgentDir = mocks.resolveAgentDir.getMockImplementation();

  mocks.resolveAgentExplicitModelPrimary.mockReturnValue(overrides.primary);
  mocks.resolveAgentEffectiveModelPrimary.mockReturnValue(overrides.primary);
  mocks.resolveAgentModelFallbacksOverride.mockReturnValue(overrides.fallbacks);
  if (overrides.agentDir) {
    mocks.resolveAgentDir.mockReturnValue(overrides.agentDir);
  }

  try {
    return await run();
  } finally {
    if (originalPrimary) {
      mocks.resolveAgentExplicitModelPrimary.mockImplementation(originalPrimary);
    } else {
      mocks.resolveAgentExplicitModelPrimary.mockReturnValue(undefined);
    }
    if (originalEffectivePrimary) {
      mocks.resolveAgentEffectiveModelPrimary.mockImplementation(originalEffectivePrimary);
    } else {
      mocks.resolveAgentEffectiveModelPrimary.mockReturnValue(undefined);
    }
    if (originalFallbacks) {
      mocks.resolveAgentModelFallbacksOverride.mockImplementation(originalFallbacks);
    } else {
      mocks.resolveAgentModelFallbacksOverride.mockReturnValue(undefined);
    }
    if (originalAgentDir) {
      mocks.resolveAgentDir.mockImplementation(originalAgentDir);
    } else {
      mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw-agent");
    }
  }
}

describe("modelsStatusCommand auth overview", () => {
  beforeAll(async () => {
    await loadFreshModelsStatusCommandModuleForTest();
  });

  it("uses agent overrides and reports sources", async () => {
    const localRuntime = createRuntime();
    await withAgentScopeOverrides(
      {
        primary: "openai/gpt-4",
        fallbacks: ["openai/gpt-3.5"],
        agentDir: "/tmp/openclaw-agent-custom",
      },
      async () => {
        await modelsStatusCommand({ json: true, agent: "Jeremiah" }, localRuntime as never);
        expect(mocks.resolveAgentDir).toHaveBeenCalledWith(expect.anything(), "jeremiah");
        const payload = JSON.parse(String((localRuntime.log as Mock).mock.calls[0]?.[0]));
        expect(payload.agentId).toBe("jeremiah");
        expect(payload.agentDir).toBe("/tmp/openclaw-agent-custom");
        expect(payload.defaultModel).toBe("openai/gpt-4");
        expect(payload.fallbacks).toEqual(["openai/gpt-3.5"]);
        expect(payload.modelConfig).toEqual({
          defaultSource: "agent",
          fallbacksSource: "agent",
        });
      },
    );
  });

  it("labels defaults when --agent has no overrides", async () => {
    const localRuntime = createRuntime();
    await withAgentScopeOverrides(
      {
        primary: undefined,
        fallbacks: undefined,
      },
      async () => {
        await modelsStatusCommand({ agent: "main" }, localRuntime as never);
        const output = (localRuntime.log as Mock).mock.calls
          .map((call: unknown[]) => String(call[0]))
          .join("\n");
        expect(output).toContain("Default (defaults)");
        expect(output).toContain("Fallbacks (0) (defaults)");
      },
    );
  });

  it("reports defaults source in JSON when --agent has no overrides", async () => {
    const localRuntime = createRuntime();
    await withAgentScopeOverrides(
      {
        primary: undefined,
        fallbacks: undefined,
      },
      async () => {
        await modelsStatusCommand({ json: true, agent: "main" }, localRuntime as never);
        const payload = JSON.parse(String((localRuntime.log as Mock).mock.calls[0]?.[0]));
        expect(payload.modelConfig).toEqual({
          defaultSource: "defaults",
          fallbacksSource: "defaults",
        });
      },
    );
  });

  it("throws when agent id is unknown", async () => {
    const localRuntime = createRuntime();
    await expect(modelsStatusCommand({ agent: "unknown" }, localRuntime as never)).rejects.toThrow(
      'Unknown agent id "unknown".',
    );
  });
});

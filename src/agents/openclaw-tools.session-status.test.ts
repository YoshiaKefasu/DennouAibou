import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";

const loadSessionStoreMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const callGatewayMock = vi.fn();
const loadCombinedSessionStoreForGatewayMock = vi.fn();
const buildStatusMessageMock = vi.hoisted(() => vi.fn(() => "OpenClaw\n🧠 Model: GPT-5.4"));
const resolveQueueSettingsMock = vi.hoisted(() => vi.fn(() => ({ mode: "interrupt" })));
const resolveEnvApiKeyMock = vi.hoisted(() =>
  vi.fn((_provider?: string, _env?: NodeJS.ProcessEnv) => null),
);
const resolveUsableCustomProviderApiKeyMock = vi.hoisted(() =>
  vi.fn((_params?: { provider?: string }) => null as { apiKey: string; source: string } | null),
);

const createMockConfig = () => ({
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: {},
    },
  },
  tools: {
    agentToAgent: { enabled: false },
  },
});

let mockConfig: Record<string, unknown> = createMockConfig();

function createScopedSessionStores() {
  return new Map<string, Record<string, unknown>>([
    [
      "/tmp/main/sessions.json",
      {
        "agent:main:main": { sessionId: "s-main", updatedAt: 10 },
      },
    ],
    [
      "/tmp/support/sessions.json",
      {
        main: { sessionId: "s-support", updatedAt: 20 },
      },
    ],
  ]);
}

function installScopedSessionStores(syncUpdates = false) {
  const stores = createScopedSessionStores();
  loadSessionStoreMock.mockClear();
  updateSessionStoreMock.mockClear();
  callGatewayMock.mockClear();
  loadCombinedSessionStoreForGatewayMock.mockClear();
  loadSessionStoreMock.mockImplementation((storePath: string) => stores.get(storePath) ?? {});
  loadCombinedSessionStoreForGatewayMock.mockReturnValue({
    storePath: "(multiple)",
    store: Object.fromEntries([...stores.values()].flatMap((store) => Object.entries(store))),
  });
  if (syncUpdates) {
    updateSessionStoreMock.mockImplementation(
      (storePath: string, store: Record<string, unknown>) => {
        if (storePath) {
          stores.set(storePath, store);
        }
      },
    );
  }
  return stores;
}

async function createSessionsModuleMock() {
  const actual = await import("../config/sessions.js");
  return {
    ...actual,
    loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
    updateSessionStore: async (
      storePath: string,
      mutator: (store: Record<string, unknown>) => Promise<void> | void,
    ) => {
      const store = loadSessionStoreMock(storePath) as Record<string, unknown>;
      await mutator(store);
      updateSessionStoreMock(storePath, store);
      return store;
    },
    resolveStorePath: (_store: string | undefined, opts?: { agentId?: string }) =>
      opts?.agentId === "support" ? "/tmp/support/sessions.json" : "/tmp/main/sessions.json",
  };
}

function createGatewayCallModuleMock() {
  return {
    callGateway: (opts: unknown) => callGatewayMock(opts),
  };
}

async function createGatewaySessionUtilsModuleMock() {
  const actual = await import("../gateway/session-utils.js");
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: (cfg: unknown) =>
      loadCombinedSessionStoreForGatewayMock(cfg),
  };
}

async function createConfigModuleMock() {
  const actual = await import("../config/config.js");
  return {
    ...actual,
    loadConfig: () => mockConfig,
  };
}

function createModelCatalogModuleMock() {
  return {
    loadModelCatalog: async () => [
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        contextWindow: 200000,
      },
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        contextWindow: 400000,
      },
    ],
  };
}

function createModelAuthModuleMock() {
  return {
    resolveEnvApiKey: resolveEnvApiKeyMock,
    resolveUsableCustomProviderApiKey: resolveUsableCustomProviderApiKeyMock,
    resolveModelAuthMode: () => "api-key",
  };
}

vi.mock("../config/sessions.js", createSessionsModuleMock);
vi.mock("../gateway/call.js", createGatewayCallModuleMock);
vi.mock("../gateway/session-utils.js", createGatewaySessionUtilsModuleMock);
vi.mock("../config/config.js", createConfigModuleMock);
vi.mock("../agents/model-catalog.js", createModelCatalogModuleMock);
vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));
// Keep provider-runtime/plugin activation out of this focused tool test. The
// session_status surface only needs model selection semantics here, not real
// bundled provider registration.
vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders: () => [],
}));
vi.mock("../agents/model-auth.js", createModelAuthModuleMock);
vi.mock("../auto-reply/group-activation.js", () => ({
  normalizeGroupActivation: (value: unknown) => value ?? "always",
}));
vi.mock("../auto-reply/reply/queue.js", () => ({
  getFollowupQueueDepth: () => 0,
  resolveQueueSettings: resolveQueueSettingsMock,
}));
vi.mock("../auto-reply/status.js", () => ({
  buildStatusMessage: buildStatusMessageMock,
}));

let createSessionStatusTool: typeof import("./tools/session-status-tool.js").createSessionStatusTool;

beforeAll(async () => {
  ({ createSessionStatusTool } = await import("./tools/session-status-tool.js"));
});

function resetSessionStore(store: Record<string, SessionEntry>) {
  buildStatusMessageMock.mockClear();
  resolveQueueSettingsMock.mockClear();
  resolveQueueSettingsMock.mockReturnValue({ mode: "interrupt" });
  resolveEnvApiKeyMock.mockReset();
  resolveEnvApiKeyMock.mockReturnValue(null);
  resolveUsableCustomProviderApiKeyMock.mockReset();
  resolveUsableCustomProviderApiKeyMock.mockReturnValue(null);
  loadSessionStoreMock.mockClear();
  updateSessionStoreMock.mockClear();
  callGatewayMock.mockClear();
  loadCombinedSessionStoreForGatewayMock.mockClear();
  loadSessionStoreMock.mockReturnValue(store);
  loadCombinedSessionStoreForGatewayMock.mockReturnValue({
    storePath: "(multiple)",
    store,
  });
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string; params?: Record<string, unknown> };
    if (request.method === "sessions.resolve") {
      const key = typeof request.params?.key === "string" ? request.params.key.trim() : "";
      if (key && store[key]) {
        return { key };
      }
      const sessionId =
        typeof request.params?.sessionId === "string" ? request.params.sessionId.trim() : "";
      if (!sessionId) {
        return {};
      }
      const spawnedBy =
        typeof request.params?.spawnedBy === "string" ? request.params.spawnedBy.trim() : "";
      const matches = Object.entries(store).filter((entry): entry is [string, SessionEntry] => {
        return (
          entry[1].sessionId === sessionId &&
          (!spawnedBy ||
            entry[1].spawnedBy === spawnedBy ||
            entry[1].parentSessionKey === spawnedBy)
        );
      });
      return { key: resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId) };
    }
    if (request.method === "sessions.list") {
      return { sessions: [] };
    }
    return {};
  });
  mockConfig = createMockConfig();
}

function mockSpawnedSessionList(
  resolveSessions: (spawnedBy: string | undefined) => Array<Record<string, unknown>>,
) {
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string; params?: Record<string, unknown> };
    if (request.method === "sessions.list") {
      return { sessions: resolveSessions(request.params?.spawnedBy as string | undefined) };
    }
    return {};
  });
}
function expectSpawnedSessionLookupCalls(spawnedBy: string) {
  const expectedCall = {
    method: "sessions.list",
    params: {
      includeGlobal: false,
      includeUnknown: false,
      spawnedBy,
    },
  };
  expect(callGatewayMock).toHaveBeenCalledTimes(2);
  expect(callGatewayMock).toHaveBeenNthCalledWith(1, expectedCall);
  expect(callGatewayMock).toHaveBeenNthCalledWith(2, expectedCall);
}

function getSessionStatusTool(agentSessionKey = "main") {
  const tool = createSessionStatusTool({
    agentSessionKey,
    config: mockConfig as never,
  });
  expect(tool.name).toBe("session_status");
  return tool;
}

describe("session_status tool", () => {
  beforeEach(() => {
    buildStatusMessageMock.mockClear();
  });

  it("returns a status card for the current session", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call1", {});
    const details = result.details as { ok?: boolean; statusText?: string };
    expect(details.ok).toBe(true);
    expect(details.statusText).toContain("OpenClaw");
    expect(details.statusText).toContain("🧠 Model:");
    expect(details.statusText).not.toContain("OAuth/token status");
  });

  it("enables transcript usage fallback for session_status", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    await tool.execute("call-transcript-usage", {});

    expect(buildStatusMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        includeTranscriptUsage: true,
      }),
    );
  });

  it("errors for unknown session keys", async () => {
    resetSessionStore({
      main: { sessionId: "s1", updatedAt: 10 },
    });

    const tool = getSessionStatusTool();

    await expect(tool.execute("call2", { sessionKey: "nope" })).rejects.toThrow(
      "Unknown sessionId",
    );
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("resolves sessionKey=current to the requester session", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call-current", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("main");
  });

  it("resolves sessionKey=current to the requester agent session", async () => {
    installScopedSessionStores();

    const tool = getSessionStatusTool("agent:support:main");

    // "current" resolves to the support agent's own session via the "main" alias.
    const result = await tool.execute("call-current-child", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("main");
  });

  it("prefers a literal current session key in session_status", async () => {
    resetSessionStore({
      main: {
        sessionId: "s-main",
        updatedAt: 10,
      },
      "agent:main:current": {
        sessionId: "s-current",
        updatedAt: 20,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call-current-literal-key", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:current");
  });

  it("resolves a literal current sessionId in session_status", async () => {
    resetSessionStore({
      main: {
        sessionId: "s-main",
        updatedAt: 10,
      },
      "agent:main:other": {
        sessionId: "current",
        updatedAt: 20,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };

    const tool = getSessionStatusTool();

    const result = await tool.execute("call-current-literal-id", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:other");
  });

  it("keeps sessionKey=current bound to the requester subagent session", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
      },
    });

    const tool = getSessionStatusTool("agent:main:subagent:child");

    const result = await tool.execute("call-current-subagent", {
      sessionKey: "current",
      model: "anthropic/claude-sonnet-4-6",
    });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:subagent:child");
    expect(updateSessionStoreMock).toHaveBeenCalledWith(
      "/tmp/main/sessions.json",
      expect.objectContaining({
        "agent:main:subagent:child": expect.objectContaining({
          liveModelSwitchPending: true,
          modelOverride: "claude-sonnet-4-6",
        }),
      }),
    );
  });

  it("uses the runtime session model as the selected card model when no override is set", async () => {
    resetSessionStore({
      main: {
        sessionId: "runtime-model",
        updatedAt: 10,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
      },
    });

    const tool = getSessionStatusTool();

    await tool.execute("call-runtime-model", {});

    expect(buildStatusMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          model: expect.objectContaining({
            primary: "anthropic/claude-opus-4-6",
          }),
        }),
      }),
    );
  });

  it("infers configured custom providers for runtime-only models in session_status", async () => {
    resetSessionStore({
      main: {
        sessionId: "runtime-custom-provider",
        updatedAt: 10,
        model: "qwen-max",
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
      models: {
        providers: {
          "qwen-dashscope": {
            apiKey: "DASHSCOPE_API_KEY",
            models: [{ id: "qwen-max" }],
          },
        },
      },
      tools: {
        agentToAgent: { enabled: false },
      },
    };
    resolveUsableCustomProviderApiKeyMock.mockImplementation((params) =>
      params?.provider === "qwen-dashscope" ? { apiKey: "sk-test", source: "models.json" } : null,
    );

    const tool = getSessionStatusTool();

    await tool.execute("call-runtime-custom-provider", {});

    expect(buildStatusMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          model: expect.objectContaining({
            primary: "qwen-dashscope/qwen-max",
          }),
        }),
        modelAuth: "api-key (models.json)",
      }),
    );
  });

  it("preserves an unknown runtime provider in the selected status card model", async () => {
    resetSessionStore({
      main: {
        sessionId: "legacy-runtime-model",
        updatedAt: 10,
        model: "legacy-runtime-model",
      },
    });

    const tool = getSessionStatusTool();

    await tool.execute("call-legacy-runtime-model", {});

    expect(buildStatusMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          model: expect.objectContaining({
            primary: "legacy-runtime-model",
          }),
        }),
        sessionEntry: expect.objectContaining({
          model: "legacy-runtime-model",
          providerOverride: "",
        }),
        modelAuth: undefined,
      }),
    );
  });

  it("passes per-agent thinkingDefault through to the status card", async () => {
    resetSessionStore({
      "agent:kira:main": {
        sessionId: "agent-thinking",
        updatedAt: 10,
      },
    });
    const savedConfig = mockConfig;
    try {
      mockConfig = {
        session: { mainKey: "main", scope: "per-sender" },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            models: {},
          },
          list: [
            {
              id: "kira",
              model: "openai/gpt-5.4",
              thinkingDefault: "xhigh",
            },
          ],
        },
        tools: {
          agentToAgent: { enabled: false },
        },
      };

      const tool = getSessionStatusTool("agent:kira:main");

      await tool.execute("call-agent-thinking", {});

      expect(buildStatusMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "kira",
          agent: expect.objectContaining({
            thinkingDefault: "xhigh",
          }),
        }),
      );
    } finally {
      mockConfig = savedConfig;
    }
  });

  it("falls back to origin.provider when resolving queue settings", async () => {
    resetSessionStore({
      main: {
        sessionId: "status-origin-provider",
        updatedAt: 10,
        origin: { provider: "discord" },
      },
    });

    const tool = getSessionStatusTool();

    await tool.execute("call-origin-provider", {});

    expect(resolveQueueSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        sessionEntry: expect.objectContaining({
          origin: { provider: "discord" },
        }),
      }),
    );
  });

  it("resolves sessionId inputs", async () => {
    const sessionId = "sess-main";
    resetSessionStore({
      "agent:main:main": {
        sessionId,
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call3", { sessionKey: sessionId });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:main");
  });

  it("resolves duplicate sessionId inputs deterministically", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "current",
        updatedAt: 10,
      },
      "agent:main:other": {
        sessionId: "run-dup",
        updatedAt: 999,
      },
      "agent:main:acp:run-dup": {
        sessionId: "run-dup",
        updatedAt: 100,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };

    const tool = getSessionStatusTool();

    const result = await tool.execute("call-dup", { sessionKey: "run-dup" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:acp:run-dup");
  });

  it("uses non-standard session keys without sessionId resolution", async () => {
    resetSessionStore({
      "temp:slug-generator": {
        sessionId: "sess-temp",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call4", { sessionKey: "temp:slug-generator" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("temp:slug-generator");
  });

  it("blocks cross-agent session_status without agent-to-agent access", async () => {
    resetSessionStore({
      "agent:other:main": {
        sessionId: "s2",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool("agent:main:main");

    await expect(tool.execute("call5", { sessionKey: "agent:other:main" })).rejects.toThrow(
      "Agent-to-agent status is disabled",
    );
  });

  it("blocks same-agent session_status outside self visibility", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "self" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };

    const tool = getSessionStatusTool("agent:main:subagent:child");

    await expect(
      tool.execute("call-self-visibility", {
        sessionKey: "agent:main:main",
        model: "default",
      }),
    ).rejects.toThrow(
      "Session status visibility is restricted to the current session (tools.sessions.visibility=self).",
    );

    expect(loadSessionStoreMock).not.toHaveBeenCalled();
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("blocks same-agent bare main session_status outside self visibility", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "self" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };

    const tool = getSessionStatusTool("agent:main:subagent:child");

    await expect(
      tool.execute("call-self-visibility-bare-main", {
        sessionKey: "main",
        model: "default",
      }),
    ).rejects.toThrow(
      "Session status visibility is restricted to the current session (tools.sessions.visibility=self).",
    );

    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("blocks same-agent session_status outside tree visibility before mutation", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "tree" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };
    mockSpawnedSessionList(() => []);

    const tool = getSessionStatusTool("agent:main:subagent:child");

    await expect(
      tool.execute("call-tree-visibility", {
        sessionKey: "agent:main:main",
        model: "default",
      }),
    ).rejects.toThrow(
      "Session status visibility is restricted to the current session tree (tools.sessions.visibility=tree).",
    );

    expect(loadSessionStoreMock).not.toHaveBeenCalled();
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        spawnedBy: "agent:main:subagent:child",
      },
    });
  });

  it("allows same-agent session_status under agent visibility", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "agent" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };

    const tool = getSessionStatusTool("agent:main:subagent:child");

    const result = await tool.execute("call-agent-visibility", {
      sessionKey: "agent:main:main",
      model: "default",
    });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:main");
    expect(updateSessionStoreMock).toHaveBeenCalled();
  });

  it("blocks sessionId session_status outside tree visibility before mutation", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "tree" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.resolve") {
        if (request.params?.sessionId === "s-parent") {
          return { key: "agent:main:main" };
        }
        return {};
      }
      if (request.method === "sessions.list") {
        return { sessions: [] };
      }
      return {};
    });

    const tool = getSessionStatusTool("agent:main:subagent:child");

    await expect(
      tool.execute("call-tree-session-id-visibility", {
        sessionKey: "s-parent",
        model: "default",
      }),
    ).rejects.toThrow(
      "Session status visibility is restricted to the current session tree (tools.sessions.visibility=tree).",
    );

    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("scopes bare session keys to the requester agent", async () => {
    installScopedSessionStores(true);

    const tool = getSessionStatusTool("agent:support:main");

    const result = await tool.execute("call6", { sessionKey: "main" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("main");
  });

  it("resets per-session model override via model=default", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        authProfileOverride: "p1",
      },
    });

    const tool = getSessionStatusTool();

    await tool.execute("call3", { model: "default" });
    expect(updateSessionStoreMock).toHaveBeenCalled();
    const [, savedStore] = updateSessionStoreMock.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    const saved = savedStore.main as Record<string, unknown>;
    expect(saved.providerOverride).toBeUndefined();
    expect(saved.modelOverride).toBeUndefined();
    expect(saved.authProfileOverride).toBeUndefined();
    expect(saved.liveModelSwitchPending).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getReplyFromConfig, type GetReplyDeps } from "./reply/get-reply.js";
import { createMockTypingController } from "./reply/reply.test-helpers.js";
import type { MsgContext } from "./templating.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  runPreparedReply: vi.fn(),
}));

// Bun cannot resolve partial self-import factories, so these seams use full
// factories that export the complete module surface.
vi.mock("../agents/agent-scope.js", () => ({
  listAgentEntries: () => [],
  listAgentIds: () => ["main"],
  resolveDefaultAgentId: () => "main",
  resolveSessionAgentIds: ({ agentId }: { agentId?: string }) => ({
    sessionAgentId: agentId ?? "main",
  }),
  resolveSessionAgentId: () => "main",
  resolveAgentConfig: () => undefined,
  resolveAgentSkillsFilter: () => undefined,
  resolveAgentDir: () => "/tmp/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveAgentExplicitModelPrimary: () => undefined,
  resolveAgentEffectiveModelPrimary: () => undefined,
  resolveAgentModelPrimary: () => undefined,
  resolveAgentModelFallbacksOverride: () => undefined,
  resolveFallbackAgentId: () => undefined,
  resolveRunModelFallbacksOverride: () => undefined,
  hasConfiguredModelFallbacks: () => false,
  resolveEffectiveModelFallbacks: () => undefined,
  resolveAgentIdsByWorkspacePath: () => [],
  resolveAgentIdByWorkspacePath: () => undefined,
}));
vi.mock("../agents/model-selection.js", () => ({
  modelKey: (provider: string, model: string) => `${provider}/${model}`,
  legacyModelKey: () => null,
  findNormalizedProviderKey: (value: unknown) => value,
  findNormalizedProviderValue: (value: unknown) => value,
  normalizeProviderId: (id?: string) =>
    typeof id === "string" ? id.trim().toLowerCase() : undefined,
  normalizeProviderIdForAuth: (id?: string) =>
    typeof id === "string" ? id.trim().toLowerCase() : undefined,
  normalizeModelRef: (value: unknown) => value,
  parseModelRef: () => null,
  resolvePersistedModelRef: async () => null,
  inferUniqueProviderFromConfiguredModels: () => undefined,
  resolveAllowlistModelKey: () => null,
  buildConfiguredAllowlistKeys: () => [],
  buildModelAliasIndex: () => new Map(),
  resolveModelRefFromString: () => null,
  resolveConfiguredModelRef: () => null,
  resolveDefaultModelForAgent: () => ({ provider: "openai", model: "gpt-5" }),
  resolveSubagentConfiguredModelSelection: () => undefined,
  resolveSubagentSpawnModelSelection: () => undefined,
  buildAllowedModelSet: () => undefined,
  buildConfiguredModelCatalog: () => [],
  getModelRefStatus: () => undefined,
  resolveAllowedModelRef: () => null,
  resolveThinkingDefault: () => undefined,
  resolveReasoningDefault: () => undefined,
  resolveHooksGmailModel: () => undefined,
  normalizeModelSelection: (value: unknown) => value,
}));
vi.mock("../agents/timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(() => 60_000),
}));
vi.mock("../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/workspace",
  ensureAgentWorkspace: vi.fn(async () => ({ dir: "/tmp/workspace" })),
}));
vi.mock("../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: vi.fn(() => undefined),
}));
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));
vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("./command-auth.js", () => ({
  resolveCommandAuthorization: vi.fn(() => ({ isAuthorizedSender: true })),
}));
vi.mock("./reply/directive-handling.defaults.js", () => ({
  resolveDefaultModel: vi.fn(() => ({
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: new Map(),
  })),
}));
vi.mock("./reply/inbound-context.js", () => ({
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
}));
vi.mock("./reply/session-reset-model.runtime.js", () => ({
  applyResetModelOverride: vi.fn(async () => undefined),
}));
vi.mock("./reply/stage-sandbox-media.runtime.js", () => ({
  stageSandboxMedia: vi.fn(async () => undefined),
}));
vi.mock("./reply/typing.js", () => ({
  createTypingController: vi.fn(() => createMockTypingController()),
}));

vi.mock("./reply/get-reply-directives.js", () => ({
  resolveReplyDirectives: (...args: unknown[]) => mocks.resolveReplyDirectives(...args),
}));
vi.mock("./reply/get-reply-inline-actions.js", () => ({
  handleInlineActions: (...args: unknown[]) => mocks.handleInlineActions(...args),
}));
vi.mock("./reply/session.js", () => ({
  initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
  resolveSessionModelOverrideSnapshot: vi.fn(() => null),
}));
vi.mock("./reply/get-reply-run.js", () => ({
  runPreparedReply: (...args: unknown[]) => mocks.runPreparedReply(...args),
}));

const deps: Partial<GetReplyDeps> = {
  resolveReplyDirectives: mocks.resolveReplyDirectives as GetReplyDeps["resolveReplyDirectives"],
  handleInlineActions: mocks.handleInlineActions as GetReplyDeps["handleInlineActions"],
  initSessionState: mocks.initSessionState as GetReplyDeps["initSessionState"],
  runPreparedReply: mocks.runPreparedReply as GetReplyDeps["runPreparedReply"],
};

function createTelegramMessage(messageSid: string): MsgContext {
  return {
    Body: "ping",
    From: "+1004",
    To: "+2000",
    MessageSid: messageSid,
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
  };
}

function createReplyConfig(streamMode?: "block"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        workspace: "/tmp/workspace",
      },
    },
    channels: { telegram: { allowFrom: ["*"], ...(streamMode ? { streaming: streamMode } : {}) } },
    session: { store: "/tmp/sessions.json" },
  };
}

function createContinueDirectivesResult() {
  return {
    kind: "continue" as const,
    result: {
      commandSource: undefined,
      command: {
        surface: "telegram",
        channel: "telegram",
        channelId: "+2000",
        ownerList: [],
        senderIsOwner: true,
        isAuthorizedSender: true,
        senderId: "+1004",
        abortKey: "telegram:+2000",
        rawBodyNormalized: "ping",
        commandBodyNormalized: "ping",
        from: "+1004",
        to: "+2000",
        resetHookTriggered: false,
      },
      allowTextCommands: true,
      skillCommands: [],
      directives: {},
      cleanedBody: "ping",
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      defaultActivation: "always",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      execOverrides: undefined,
      blockStreamingEnabled: true,
      blockReplyChunking: undefined,
      resolvedBlockStreamingBreak: "message_end",
      provider: "anthropic",
      model: "claude-opus-4-6",
      modelState: {
        resolveDefaultThinkingLevel: async () => undefined,
      },
      contextTokens: 0,
      inlineStatusRequested: false,
      directiveAck: undefined,
      perMessageQueueMode: undefined,
      perMessageQueueOptions: undefined,
    },
  };
}

describe("block streaming", () => {
  beforeEach(() => {
    setTestEnv("DENNOU_TEST_FAST", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    mocks.runPreparedReply.mockReset();

    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult());
    mocks.handleInlineActions.mockImplementation(async (params) => ({
      kind: "continue",
      directives: params.directives,
      abortedLastRun: false,
    }));
    mocks.initSessionState.mockImplementation(async ({ ctx }: { ctx: MsgContext }) => ({
      sessionCtx: {
        ...ctx,
        CommandAuthorized: true,
      },
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:direct:+1004",
      sessionId: "session-1",
      isNewSession: true,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "ping",
      bodyStripped: "ping",
    }));
  });

  it("handles ordering, timeout fallback, and telegram streamMode block", async () => {
    const onReplyStart = vi.fn().mockResolvedValue(undefined);
    const onBlockReply = vi.fn().mockResolvedValue(undefined);

    mocks.runPreparedReply.mockImplementationOnce(async (params) => {
      await params.opts?.onReplyStart?.();
      await params.opts?.onBlockReply?.({ text: "first\n\nsecond" });
      return undefined;
    });

    const res = await getReplyFromConfig(
      createTelegramMessage("msg-123"),
      {
        onReplyStart,
        onBlockReply,
        disableBlockStreaming: false,
      },
      createReplyConfig(),
      deps,
    );

    expect(res).toBeUndefined();
    expect(mocks.runPreparedReply).toHaveBeenCalledTimes(1);
    expect(onReplyStart).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledWith({ text: "first\n\nsecond" });

    const onBlockReplyStreamMode = vi.fn().mockResolvedValue(undefined);
    mocks.runPreparedReply.mockImplementationOnce(async () => [{ text: "final" }]);

    const resStreamMode = await getReplyFromConfig(
      createTelegramMessage("msg-127"),
      {
        onBlockReply: onBlockReplyStreamMode,
      },
      createReplyConfig("block"),
      deps,
    );

    const streamPayload = Array.isArray(resStreamMode) ? resStreamMode[0] : resStreamMode;
    expect(streamPayload?.text).toBe("final");
    expect(onBlockReplyStreamMode).not.toHaveBeenCalled();
  });
});

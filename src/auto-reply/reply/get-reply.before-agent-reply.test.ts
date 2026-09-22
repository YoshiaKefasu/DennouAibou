import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { getReplyFromConfig } from "./get-reply.js";
import type { GetReplyDeps } from "./get-reply.js";

const mocks = {
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  runBeforeAgentReply: vi.fn(),
};

function getTestDeps(extra?: Partial<GetReplyDeps>): Partial<GetReplyDeps> {
  return {
    loadConfig: () => ({}),
    resolveSessionAgentId: () => "main",
    resolveAgentDir: () => "/tmp/agent",
    resolveAgentWorkspaceDir: () => "/tmp/workspace",
    resolveAgentSkillsFilter: () => undefined,
    resolveModelRefFromString: () => null,
    resolveAgentTimeoutMs: () => 60000,
    ensureAgentWorkspace: async () => ({ dir: "/tmp/workspace" }),
    resolveChannelModelOverride: () => null,
    resolveCommandAuthorization: () =>
      ({ isAuthorizedSender: true, ownerList: [], senderIsOwner: false }) as never,
    resolveDefaultModel: () => ({
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
    }),
    finalizeInboundContext: (ctx: Record<string, unknown>) => ctx as never,
    emitPreAgentMessageHooks: () => undefined,
    resolveSessionModelOverrideSnapshot: () => null,
    runPreparedReply: async () => undefined,
    resolveReplyDirectives: mocks.resolveReplyDirectives as never,
    handleInlineActions: mocks.handleInlineActions as never,
    initSessionState: mocks.initSessionState as never,
    getGlobalHookRunner: () =>
      ({
        hasHooks: (hookName: string) => hookName === "before_agent_reply",
        runBeforeAgentReply: mocks.runBeforeAgentReply as never,
      }) as never,
    ...extra,
  };
}

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:-100123",
    ChatType: "group",
    Body: "hello world",
    BodyForAgent: "hello world",
    RawBody: "hello world",
    CommandBody: "hello world",
    BodyForCommands: "hello world",
    SessionKey: "agent:main:telegram:-100123",
    From: "telegram:user:42",
    To: "telegram:-100123",
    Timestamp: 1710000000000,
    ...overrides,
  };
}

function createContinueDirectivesResult() {
  return {
    kind: "continue" as const,
    result: {
      commandSource: "text",
      command: {
        surface: "telegram",
        channel: "telegram",
        channelId: "telegram",
        ownerList: [],
        senderIsOwner: false,
        isAuthorizedSender: true,
        senderId: "42",
        abortKey: "agent:main:telegram:-100123",
        rawBodyNormalized: "hello world",
        commandBodyNormalized: "hello world",
        from: "telegram:user:42",
        to: "telegram:-100123",
        resetHookTriggered: false,
      },
      allowTextCommands: true,
      skillCommands: [],
      directives: {},
      cleanedBody: "hello world",
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      defaultActivation: "always",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      execOverrides: undefined,
      blockStreamingEnabled: false,
      blockReplyChunking: undefined,
      resolvedBlockStreamingBreak: undefined,
      provider: "openai",
      model: "gpt-4o-mini",
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

describe("getReplyFromConfig before_agent_reply wiring", () => {
  beforeEach(() => {
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    mocks.runBeforeAgentReply.mockReset();

    mocks.initSessionState.mockResolvedValue({
      sessionCtx: buildCtx({
        OriginatingChannel: "Telegram",
        Provider: "telegram",
      }),
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:-100123",
      sessionId: "session-1",
      isNewSession: false,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-chat",
      groupResolution: undefined,
      isGroup: true,
      triggerBodyNormalized: "hello world",
      bodyStripped: "hello world",
    });
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult());
    mocks.handleInlineActions.mockResolvedValue({
      kind: "continue",
      directives: {},
      abortedLastRun: false,
    });
  });

  it("returns a plugin reply and invokes the hook after inline actions", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "plugin reply" },
    });

    const result = await getReplyFromConfig(buildCtx(), undefined, {}, getTestDeps());

    expect(result).toEqual({ text: "plugin reply" });
    expect(mocks.runBeforeAgentReply).toHaveBeenCalledWith(
      { cleanedBody: "hello world" },
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:telegram:-100123",
        sessionId: "session-1",
        workspaceDir: "/tmp/workspace",
        messageProvider: "telegram",
        trigger: "user",
        channelId: "telegram",
      }),
    );
    expect(mocks.handleInlineActions.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runBeforeAgentReply.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("falls back to NO_REPLY when the hook claims without a reply payload", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({ handled: true });

    const result = await getReplyFromConfig(buildCtx(), undefined, {}, getTestDeps());

    expect(result).toEqual({ text: SILENT_REPLY_TOKEN });
  });
});

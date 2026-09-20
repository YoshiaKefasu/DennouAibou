import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import { getReplyFromConfig } from "./get-reply.js";
import type { GetReplyDeps } from "./get-reply.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  emitResetCommandHooks: vi.fn(),
  initSessionState: vi.fn(),
}));

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
    emitResetCommandHooks: mocks.emitResetCommandHooks as never,
    ...extra,
  };
}

function buildNativeResetContext(): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    Body: "/new",
    RawBody: "/new",
    CommandBody: "/new",
    CommandSource: "native",
    CommandAuthorized: true,
    SessionKey: "telegram:slash:123",
    CommandTargetSessionKey: "agent:main:telegram:direct:123",
    From: "telegram:123",
    To: "slash:123",
  };
}

function createContinueDirectivesResult(resetHookTriggered: boolean) {
  return {
    kind: "continue" as const,
    result: {
      commandSource: "/new",
      command: {
        surface: "telegram",
        channel: "telegram",
        channelId: "telegram",
        ownerList: [],
        senderIsOwner: true,
        isAuthorizedSender: true,
        senderId: "123",
        abortKey: "telegram:slash:123",
        rawBodyNormalized: "/new",
        commandBodyNormalized: "/new",
        from: "telegram:123",
        to: "slash:123",
        resetHookTriggered,
      },
      allowTextCommands: true,
      skillCommands: [],
      directives: {},
      cleanedBody: "/new",
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

describe("getReplyFromConfig reset-hook fallback", () => {
  beforeEach(() => {
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.emitResetCommandHooks.mockReset();
    mocks.initSessionState.mockReset();

    mocks.initSessionState.mockResolvedValue({
      sessionCtx: buildNativeResetContext(),
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:direct:123",
      sessionId: "session-1",
      isNewSession: true,
      resetTriggered: true,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "/new",
      bodyStripped: "",
    });

    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(false));
  });

  it("emits reset hooks when inline actions return early without marking resetHookTriggered", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });

    await getReplyFromConfig(buildNativeResetContext(), undefined, {}, getTestDeps());

    expect(mocks.emitResetCommandHooks).toHaveBeenCalledTimes(1);
    expect(mocks.emitResetCommandHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "new",
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
  });

  it("does not emit fallback hooks when resetHookTriggered is already set", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(true));

    await getReplyFromConfig(buildNativeResetContext(), undefined, {}, getTestDeps());

    expect(mocks.emitResetCommandHooks).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import { getReplyFromConfig } from "./get-reply.js";
import type { GetReplyDeps } from "./get-reply.js";

const mocks = vi.hoisted(() => ({
  applyMediaUnderstanding: vi.fn(async (..._args: unknown[]) => undefined),
  applyLinkUnderstanding: vi.fn(async (..._args: unknown[]) => undefined),
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async (..._args: unknown[]) => undefined),
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: (...args: unknown[]) => mocks.createInternalHookEvent(...args),
  triggerInternalHook: (...args: unknown[]) => mocks.triggerInternalHook(...args),
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
    resolveSessionModelOverrideSnapshot: () => null,
    runPreparedReply: async () => undefined,
    resolveReplyDirectives: mocks.resolveReplyDirectives as never,
    handleInlineActions: (async () => ({ kind: "reply", reply: { text: "ok" } })) as never,
    initSessionState: mocks.initSessionState as never,
    applyMediaUnderstanding: mocks.applyMediaUnderstanding as never,
    applyLinkUnderstanding: mocks.applyLinkUnderstanding as never,
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
    Body: "<media:audio>",
    BodyForAgent: "<media:audio>",
    RawBody: "<media:audio>",
    CommandBody: "<media:audio>",
    SessionKey: "agent:main:telegram:-100123",
    From: "telegram:user:42",
    To: "telegram:-100123",
    GroupChannel: "ops",
    Timestamp: 1710000000000,
    MediaPath: "/tmp/voice.ogg",
    MediaUrl: "https://example.test/voice.ogg",
    MediaType: "audio/ogg",
    ...overrides,
  };
}

describe("getReplyFromConfig message hooks", () => {
  beforeEach(() => {
    delete process.env.DENNOU_TEST_FAST;
    mocks.applyMediaUnderstanding.mockReset();
    mocks.applyLinkUnderstanding.mockReset();
    mocks.createInternalHookEvent.mockReset();
    mocks.triggerInternalHook.mockReset();
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();

    mocks.applyMediaUnderstanding.mockImplementation(async (...args: unknown[]) => {
      const { ctx } = args[0] as { ctx: MsgContext };
      ctx.Transcript = "voice transcript";
      ctx.Body = "[Audio]\nTranscript:\nvoice transcript";
      ctx.BodyForAgent = "[Audio]\nTranscript:\nvoice transcript";
    });
    mocks.applyLinkUnderstanding.mockResolvedValue(undefined);
    mocks.createInternalHookEvent.mockImplementation(
      (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
        type,
        action,
        sessionKey,
        context,
        timestamp: new Date(),
        messages: [],
      }),
    );
    mocks.triggerInternalHook.mockResolvedValue(undefined);
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.initSessionState.mockResolvedValue({
      sessionCtx: {},
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
      triggerBodyNormalized: "",
      bodyStripped: "",
    });
  });

  it("emits transcribed + preprocessed hooks with enriched context", async () => {
    const ctx = buildCtx();

    await getReplyFromConfig(ctx, undefined, {}, getTestDeps());

    expect(mocks.createInternalHookEvent).toHaveBeenCalledTimes(2);
    expect(mocks.createInternalHookEvent).toHaveBeenNthCalledWith(
      1,
      "message",
      "transcribed",
      "agent:main:telegram:-100123",
      expect.objectContaining({
        transcript: "voice transcript",
        channelId: "telegram",
        conversationId: "telegram:-100123",
      }),
    );
    expect(mocks.createInternalHookEvent).toHaveBeenNthCalledWith(
      2,
      "message",
      "preprocessed",
      "agent:main:telegram:-100123",
      expect.objectContaining({
        transcript: "voice transcript",
        isGroup: true,
        groupId: "telegram:-100123",
      }),
    );
    expect(mocks.triggerInternalHook).toHaveBeenCalledTimes(2);
  });

  it("emits only preprocessed when no transcript is produced", async () => {
    mocks.applyMediaUnderstanding.mockImplementationOnce(async (...args: unknown[]) => {
      const { ctx } = args[0] as { ctx: MsgContext };
      ctx.Transcript = undefined;
      ctx.Body = "<media:audio>";
      ctx.BodyForAgent = "<media:audio>";
    });

    await getReplyFromConfig(buildCtx(), undefined, {}, getTestDeps());

    expect(mocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    expect(mocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "preprocessed",
      "agent:main:telegram:-100123",
      expect.any(Object),
    );
  });

  it("skips message hooks in fast test mode", async () => {
    process.env.DENNOU_TEST_FAST = "1";

    await getReplyFromConfig(buildCtx(), undefined, {}, getTestDeps());

    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
    expect(mocks.applyLinkUnderstanding).not.toHaveBeenCalled();
    expect(mocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(mocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("skips message hooks when SessionKey is unavailable", async () => {
    await getReplyFromConfig(buildCtx({ SessionKey: undefined }), undefined, {}, getTestDeps());

    expect(mocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(mocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("skips media and link understanding on plain text without attachments or urls", async () => {
    await getReplyFromConfig(
      buildCtx({
        Body: "hello there",
        BodyForAgent: "hello there",
        RawBody: "hello there",
        CommandBody: "hello there",
        BodyForCommands: "hello there",
        MediaPath: undefined,
        MediaUrl: undefined,
        MediaPaths: undefined,
        MediaUrls: undefined,
        MediaTypes: undefined,
        Sticker: undefined,
        StickerMediaIncluded: undefined,
      }),
      undefined,
      {},
      getTestDeps(),
    );

    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
    expect(mocks.applyLinkUnderstanding).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { getReplyFromConfig } from "./get-reply.js";
import type { GetReplyDeps } from "./get-reply.js";

const mocks = {
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
  loadConfig: vi.fn(() => ({})),
};

function getTestDeps(extra?: Partial<GetReplyDeps>): Partial<GetReplyDeps> {
  return {
    loadConfig: mocks.loadConfig as never,
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
    handleInlineActions: (async () => ({ kind: "reply", reply: { text: "ok" } })) as never,
    initSessionState: mocks.initSessionState as never,
    ...extra,
  };
}

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    Body: "hello",
    BodyForAgent: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    SessionKey: "agent:main:telegram:123",
    From: "telegram:user:42",
    To: "telegram:123",
    Timestamp: 1710000000000,
    ...overrides,
  };
}

describe("getReplyFromConfig configOverride", () => {
  beforeEach(() => {
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    mocks.loadConfig.mockReset();

    mocks.loadConfig.mockReturnValue({});
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.initSessionState.mockResolvedValue({
      sessionCtx: {},
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:123",
      sessionId: "session-1",
      isNewSession: false,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-chat",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "",
      bodyStripped: "",
    });
  });

  it("merges configOverride over fresh loadConfig()", async () => {
    mocks.loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "resolved-telegram-token",
        },
      },
      agents: {
        defaults: {
          userTimezone: "UTC",
        },
      },
    } satisfies OpenClawConfig);

    await getReplyFromConfig(
      buildCtx(),
      undefined,
      {
        agents: {
          defaults: {
            userTimezone: "America/New_York",
          },
        },
      } as OpenClawConfig,
      getTestDeps(),
    );

    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          channels: expect.objectContaining({
            telegram: expect.objectContaining({
              botToken: "resolved-telegram-token",
            }),
          }),
          agents: expect.objectContaining({
            defaults: expect.objectContaining({
              userTimezone: "America/New_York",
            }),
          }),
        }),
      }),
    );
  });
});

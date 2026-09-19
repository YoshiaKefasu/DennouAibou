import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  executePollAction,
  executeSendAction,
  type OutboundSendServiceDeps,
} from "./outbound-send-service.js";

const dispatchChannelMessageAction = vi.fn();
const sendMessage = vi.fn();
const sendPoll = vi.fn();
const mediaReadFile = vi.fn(async () => Buffer.from("capability"));
const appendAssistantMessageToSessionTranscript = vi.fn(async () => ({
  ok: true,
  sessionFile: "x",
}));
const resolveAgentScopedOutboundMediaAccess = vi.fn(() => ({
  localRoots: ["/tmp/agent-roots"],
  readFile: mediaReadFile,
}));

/**
 * Inject the outbound-send boundaries instead of mocking `./message.js`,
 * `../../media/read-capability.js`, `../../config/sessions.js`, and the channel
 * action dispatcher at module level.
 */
const deps: OutboundSendServiceDeps = {
  dispatchChannelMessageAction: dispatchChannelMessageAction as unknown as NonNullable<
    OutboundSendServiceDeps["dispatchChannelMessageAction"]
  >,
  resolveAgentScopedOutboundMediaAccess:
    resolveAgentScopedOutboundMediaAccess as unknown as NonNullable<
      OutboundSendServiceDeps["resolveAgentScopedOutboundMediaAccess"]
    >,
  appendAssistantMessageToSessionTranscript:
    appendAssistantMessageToSessionTranscript as unknown as NonNullable<
      OutboundSendServiceDeps["appendAssistantMessageToSessionTranscript"]
    >,
  sendMessage: sendMessage as unknown as NonNullable<OutboundSendServiceDeps["sendMessage"]>,
  sendPoll: sendPoll as unknown as NonNullable<OutboundSendServiceDeps["sendPoll"]>,
};

describe("executeSendAction", () => {
  function pluginActionResult(messageId: string) {
    return {
      ok: true,
      value: { messageId },
      continuePrompt: "",
      output: "",
      sessionId: "s1",
      model: "gpt-5.4",
      usage: {},
    };
  }

  function expectMirrorWrite(
    expected: Partial<{
      agentId: string;
      sessionKey: string;
      text: string;
      idempotencyKey: string;
      mediaUrls: string[];
    }>,
  ) {
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining(expected),
    );
  }

  async function executePluginMirroredSend(params: {
    mirror?: Partial<{
      sessionKey: string;
      agentId?: string;
      idempotencyKey?: string;
    }>;
    mediaUrls?: string[];
  }) {
    dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("msg-plugin"));

    await executeSendAction(
      {
        ctx: {
          cfg: {},
          channel: "demo-outbound",
          params: { to: "channel:123", message: "hello" },
          dryRun: false,
          mirror: {
            sessionKey: "agent:main:demo-outbound:channel:123",
            ...params.mirror,
          },
        },
        to: "channel:123",
        message: "hello",
        mediaUrls: params.mediaUrls,
      },
      deps,
    );
  }

  beforeEach(() => {
    dispatchChannelMessageAction.mockReset();
    sendMessage.mockReset();
    sendPoll.mockReset();
    mediaReadFile.mockClear();
    appendAssistantMessageToSessionTranscript.mockClear();
    resolveAgentScopedOutboundMediaAccess.mockClear();
    resolveAgentScopedOutboundMediaAccess.mockReturnValue({
      localRoots: ["/tmp/agent-roots"],
      readFile: mediaReadFile,
    });
  });

  it("forwards ctx.agentId to sendMessage on core outbound path", async () => {
    dispatchChannelMessageAction.mockResolvedValue(null);
    sendMessage.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    await executeSendAction(
      {
        ctx: {
          cfg: {},
          channel: "demo-outbound",
          params: {},
          agentId: "work",
          dryRun: false,
        },
        to: "channel:123",
        message: "hello",
      },
      deps,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "work",
        channel: "demo-outbound",
        to: "channel:123",
        content: "hello",
      }),
    );
  });

  it("uses plugin poll action when available", async () => {
    dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("poll-plugin"));

    const result = await executePollAction(
      {
        ctx: {
          cfg: {},
          channel: "demo-outbound",
          params: {},
          dryRun: false,
        },
        resolveCorePoll: () => ({
          to: "channel:123",
          question: "Lunch?",
          options: ["Pizza", "Sushi"],
          maxSelections: 1,
        }),
      },
      deps,
    );

    expect(result.handledBy).toBe("plugin");
    expect(sendPoll).not.toHaveBeenCalled();
  });

  it("does not invoke shared poll parsing before plugin poll dispatch", async () => {
    dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("poll-plugin"));
    const resolveCorePoll = vi.fn(() => {
      throw new Error("shared poll fallback should not run");
    });

    const result = await executePollAction(
      {
        ctx: {
          cfg: {},
          channel: "demo-outbound",
          params: {
            pollQuestion: "Lunch?",
            pollOption: ["Pizza", "Sushi"],
            pollDurationSeconds: 90,
            pollPublic: true,
          },
          dryRun: false,
        },
        resolveCorePoll,
      },
      deps,
    );

    expect(result.handledBy).toBe("plugin");
    expect(resolveCorePoll).not.toHaveBeenCalled();
    expect(sendPoll).not.toHaveBeenCalled();
  });

  it("passes agent-scoped media local roots to plugin dispatch", async () => {
    dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("msg-plugin"));

    await executeSendAction(
      {
        ctx: {
          cfg: {},
          channel: "demo-outbound",
          params: { to: "channel:123", message: "hello" },
          agentId: "agent-1",
          dryRun: false,
        },
        to: "channel:123",
        message: "hello",
      },
      deps,
    );

    expect(resolveAgentScopedOutboundMediaAccess).toHaveBeenCalledWith({
      cfg: {},
      agentId: "agent-1",
      mediaSources: [],
    });
    expect(dispatchChannelMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/agent-roots"],
        mediaReadFile,
      }),
    );
  });

  it("passes concrete media sources when widening plugin dispatch roots", async () => {
    dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("msg-plugin"));

    await executeSendAction(
      {
        ctx: {
          cfg: {},
          channel: "demo-outbound",
          params: {
            to: "channel:123",
            message: "hello",
            media: "/Users/peter/Pictures/photo.png",
          },
          agentId: "agent-1",
          dryRun: false,
        },
        to: "channel:123",
        message: "hello",
        mediaUrl: "/Users/peter/Pictures/photo.png",
      },
      deps,
    );

    expect(resolveAgentScopedOutboundMediaAccess).toHaveBeenCalledWith({
      cfg: {},
      agentId: "agent-1",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });
  });

  it("passes mirror idempotency keys through plugin-handled sends", async () => {
    await executePluginMirroredSend({
      mirror: {
        idempotencyKey: "idem-plugin-send-1",
      },
    });

    expectMirrorWrite({
      sessionKey: "agent:main:demo-outbound:channel:123",
      text: "hello",
      idempotencyKey: "idem-plugin-send-1",
    });
  });

  it("falls back to message and media params for plugin-handled mirror writes", async () => {
    await executePluginMirroredSend({
      mirror: {
        agentId: "agent-9",
      },
      mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
    });

    expectMirrorWrite({
      agentId: "agent-9",
      sessionKey: "agent:main:demo-outbound:channel:123",
      text: "hello",
      mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
    });
  });

  it("skips plugin dispatch during dry-run sends and forwards gateway + silent to sendMessage", async () => {
    sendMessage.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "gateway",
      mediaUrl: null,
    });

    await executeSendAction(
      {
        ctx: {
          cfg: {},
          channel: "demo-outbound",
          params: { to: "channel:123", message: "hello" },
          dryRun: true,
          silent: true,
          gateway: {
            url: "http://127.0.0.1:18789",
            token: "tok",
            timeoutMs: 5000,
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
        },
        to: "channel:123",
        message: "hello",
      },
      deps,
    );

    expect(dispatchChannelMessageAction).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "channel:123",
        content: "hello",
        dryRun: true,
        silent: true,
        gateway: expect.objectContaining({
          url: "http://127.0.0.1:18789",
          token: "tok",
          timeoutMs: 5000,
        }),
      }),
    );
  });

  it("forwards poll args to sendPoll on core outbound path", async () => {
    dispatchChannelMessageAction.mockResolvedValue(null);
    sendPoll.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      durationSeconds: null,
      durationHours: null,
      via: "gateway",
    });

    await executePollAction(
      {
        ctx: {
          cfg: {},
          channel: "demo-outbound",
          params: {},
          accountId: "acc-1",
          dryRun: false,
        },
        resolveCorePoll: () => ({
          to: "channel:123",
          question: "Lunch?",
          options: ["Pizza", "Sushi"],
          maxSelections: 1,
          durationSeconds: 300,
          threadId: "thread-1",
          isAnonymous: true,
        }),
      },
      deps,
    );

    expect(sendPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "demo-outbound",
        accountId: "acc-1",
        to: "channel:123",
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 1,
        durationSeconds: 300,
        threadId: "thread-1",
        isAnonymous: true,
      }),
    );
  });

  it("skips plugin dispatch during dry-run polls and forwards durationHours + silent", async () => {
    sendPoll.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      durationSeconds: null,
      durationHours: 6,
      via: "gateway",
    });

    await executePollAction(
      {
        ctx: {
          cfg: {},
          channel: "demo-outbound",
          params: {},
          dryRun: true,
          silent: true,
          gateway: {
            url: "http://127.0.0.1:18789",
            token: "tok",
            timeoutMs: 5000,
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
        },
        resolveCorePoll: () => ({
          to: "channel:123",
          question: "Lunch?",
          options: ["Pizza", "Sushi"],
          maxSelections: 1,
          durationHours: 6,
        }),
      },
      deps,
    );

    expect(dispatchChannelMessageAction).not.toHaveBeenCalled();
    expect(sendPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "channel:123",
        question: "Lunch?",
        durationHours: 6,
        dryRun: true,
        silent: true,
        gateway: expect.objectContaining({
          url: "http://127.0.0.1:18789",
          token: "tok",
          timeoutMs: 5000,
        }),
      }),
    );
  });
});

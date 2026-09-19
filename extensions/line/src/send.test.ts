import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineSendDeps } from "./send.js";
import * as sendModule from "./send.js";

// Inject the LINE send boundaries instead of mocking `@line/bot-sdk`, the
// plugin-sdk modules, `./accounts.js`, and `./channel-access-token.js` at module
// level (Bun cannot intercept ESM imports, so those mocks fail under `bun test`).
const pushMessageMock = vi.fn();
const replyMessageMock = vi.fn();
const showLoadingAnimationMock = vi.fn();
const getProfileMock = vi.fn();
const loadConfigMock = vi.fn(() => ({}));
const resolveLineAccountMock = vi.fn(() => ({ accountId: "default" }));
const resolveLineChannelAccessTokenMock = vi.fn(() => "line-token");
const recordChannelActivityMock = vi.fn();
const logVerboseMock = vi.fn();
const createMessagingApiClientMock = vi.fn(() => ({
  pushMessage: pushMessageMock,
  replyMessage: replyMessageMock,
  showLoadingAnimation: showLoadingAnimationMock,
  getProfile: getProfileMock,
}));

const deps: LineSendDeps = {
  loadConfig: loadConfigMock as unknown as NonNullable<LineSendDeps["loadConfig"]>,
  resolveLineAccount: resolveLineAccountMock as unknown as NonNullable<
    LineSendDeps["resolveLineAccount"]
  >,
  resolveLineChannelAccessToken: resolveLineChannelAccessTokenMock as unknown as NonNullable<
    LineSendDeps["resolveLineChannelAccessToken"]
  >,
  recordChannelActivity: recordChannelActivityMock as unknown as NonNullable<
    LineSendDeps["recordChannelActivity"]
  >,
  logVerbose: logVerboseMock as unknown as NonNullable<LineSendDeps["logVerbose"]>,
  createMessagingApiClient: createMessagingApiClientMock as unknown as NonNullable<
    LineSendDeps["createMessagingApiClient"]
  >,
};

describe("LINE send helpers", () => {
  beforeEach(() => {
    pushMessageMock.mockReset();
    replyMessageMock.mockReset();
    showLoadingAnimationMock.mockReset();
    getProfileMock.mockReset();
    loadConfigMock.mockReset();
    resolveLineAccountMock.mockReset();
    resolveLineChannelAccessTokenMock.mockReset();
    recordChannelActivityMock.mockReset();
    logVerboseMock.mockReset();
    createMessagingApiClientMock.mockReset();

    loadConfigMock.mockReturnValue({});
    resolveLineAccountMock.mockReturnValue({ accountId: "default" });
    resolveLineChannelAccessTokenMock.mockReturnValue("line-token");
    createMessagingApiClientMock.mockImplementation(() => ({
      pushMessage: pushMessageMock,
      replyMessage: replyMessageMock,
      showLoadingAnimation: showLoadingAnimationMock,
      getProfile: getProfileMock,
    }));
    pushMessageMock.mockResolvedValue({});
    replyMessageMock.mockResolvedValue({});
    showLoadingAnimationMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("limits quick reply items to 13", () => {
    const labels = Array.from({ length: 20 }, (_, index) => `Option ${index + 1}`);
    const quickReply = sendModule.createQuickReplyItems(labels);

    expect(quickReply.items).toHaveLength(13);
  });

  it("pushes images via normalized LINE target", async () => {
    const result = await sendModule.pushImageMessage(
      "line:user:U123",
      "https://example.com/original.jpg",
      undefined,
      { verbose: true, deps },
    );

    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "U123",
      messages: [
        {
          type: "image",
          originalContentUrl: "https://example.com/original.jpg",
          previewImageUrl: "https://example.com/original.jpg",
        },
      ],
    });
    expect(recordChannelActivityMock).toHaveBeenCalledWith({
      channel: "line",
      accountId: "default",
      direction: "outbound",
    });
    expect(logVerboseMock).toHaveBeenCalledWith("line: pushed image to U123");
    expect(result).toEqual({ messageId: "push", chatId: "U123" });
  });

  it("replies when reply token is provided", async () => {
    const result = await sendModule.sendMessageLine("line:group:C1", "Hello", {
      replyToken: "reply-token",
      mediaUrl: "https://example.com/media.jpg",
      verbose: true,
      deps,
    });

    expect(replyMessageMock).toHaveBeenCalledTimes(1);
    expect(pushMessageMock).not.toHaveBeenCalled();
    expect(replyMessageMock).toHaveBeenCalledWith({
      replyToken: "reply-token",
      messages: [
        {
          type: "image",
          originalContentUrl: "https://example.com/media.jpg",
          previewImageUrl: "https://example.com/media.jpg",
        },
        {
          type: "text",
          text: "Hello",
        },
      ],
    });
    expect(logVerboseMock).toHaveBeenCalledWith("line: replied to C1");
    expect(result).toEqual({ messageId: "reply", chatId: "C1" });
  });

  it("sends video with explicit image preview URL", async () => {
    await sendModule.sendMessageLine("line:user:U100", "Video", {
      mediaUrl: "https://example.com/video.mp4",
      mediaKind: "video",
      previewImageUrl: "https://example.com/preview.jpg",
      trackingId: "track-1",
      deps,
    });

    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "U100",
      messages: [
        {
          type: "video",
          originalContentUrl: "https://example.com/video.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
          trackingId: "track-1",
        },
        {
          type: "text",
          text: "Video",
        },
      ],
    });
  });

  it("throws when video preview URL is missing", async () => {
    await expect(
      sendModule.sendMessageLine("line:user:U200", "Video", {
        mediaUrl: "https://example.com/video.mp4",
        mediaKind: "video",
        deps,
      }),
    ).rejects.toThrow(/require previewimageurl/i);
  });

  it("omits trackingId for non-user destinations", async () => {
    await sendModule.sendMessageLine("line:group:C100", "Video", {
      mediaUrl: "https://example.com/video.mp4",
      mediaKind: "video",
      previewImageUrl: "https://example.com/preview.jpg",
      trackingId: "track-group",
      deps,
    });

    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "C100",
      messages: [
        {
          type: "video",
          originalContentUrl: "https://example.com/video.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
        },
        {
          type: "text",
          text: "Video",
        },
      ],
    });
  });

  it("throws when push messages are empty", async () => {
    await expect(sendModule.pushMessagesLine("U123", [], { deps })).rejects.toThrow(
      "Message must be non-empty for LINE sends",
    );
  });

  it("logs HTTP body when push fails", async () => {
    const err = new Error("LINE push failed") as Error & {
      status: number;
      statusText: string;
      body: string;
    };
    err.status = 400;
    err.statusText = "Bad Request";
    err.body = "invalid flex payload";
    pushMessageMock.mockRejectedValueOnce(err);

    await expect(
      sendModule.pushMessagesLine("U999", [{ type: "text", text: "hello" }], { deps }),
    ).rejects.toThrow("LINE push failed");

    expect(logVerboseMock).toHaveBeenCalledWith(
      "line: push message failed (400 Bad Request): invalid flex payload",
    );
  });

  it("caches profile results by default", async () => {
    getProfileMock.mockResolvedValue({
      displayName: "Peter",
      pictureUrl: "https://example.com/peter.jpg",
    });

    const first = await sendModule.getUserProfile("U-cache", { deps });
    const second = await sendModule.getUserProfile("U-cache", { deps });

    expect(first).toEqual({
      displayName: "Peter",
      pictureUrl: "https://example.com/peter.jpg",
    });
    expect(second).toEqual(first);
    expect(getProfileMock).toHaveBeenCalledTimes(1);
  });

  it("continues when loading animation is unsupported", async () => {
    showLoadingAnimationMock.mockRejectedValueOnce(new Error("unsupported"));

    await expect(
      sendModule.showLoadingAnimation("line:room:R1", { deps }),
    ).resolves.toBeUndefined();

    expect(logVerboseMock).toHaveBeenCalledWith(
      expect.stringContaining("line: loading animation failed (non-fatal)"),
    );
  });

  it("pushes quick-reply text and caps to 13 buttons", async () => {
    await sendModule.pushTextMessageWithQuickReplies(
      "U-quick",
      "Pick one",
      Array.from({ length: 20 }, (_, index) => `Choice ${index + 1}`),
      { deps },
    );

    expect(pushMessageMock).toHaveBeenCalledTimes(1);
    const firstCall = pushMessageMock.mock.calls[0] as [
      { messages: Array<{ quickReply?: { items: unknown[] } }> },
    ];
    expect(firstCall[0].messages[0].quickReply?.items).toHaveLength(13);
  });
});

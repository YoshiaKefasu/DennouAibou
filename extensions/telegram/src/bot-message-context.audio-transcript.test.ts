import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeFirstAudioMock = vi.fn();
const DEFAULT_MODEL = "anthropic/claude-opus-4-5";
const DEFAULT_WORKSPACE = "/tmp/openclaw";
const DEFAULT_MENTION_PATTERN = "\\bbot\\b";

vi.mock("./media-understanding.runtime.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");

async function buildDirectVoiceContext(params: {
  messageId: number;
  chatId: number;
  date: number;
  fromId: number;
  firstName: string;
  fileId: string;
  mediaPath: string;
}) {
  return buildTelegramMessageContextForTest({
    message: {
      message_id: params.messageId,
      chat: { id: params.chatId, type: "private", first_name: params.firstName },
      date: params.date,
      text: undefined,
      from: { id: params.fromId, first_name: params.firstName },
      voice: { file_id: params.fileId },
    },
    allMedia: [{ path: params.mediaPath, contentType: "audio/ogg" }],
    cfg: {
      agents: { defaults: { model: DEFAULT_MODEL, workspace: DEFAULT_WORKSPACE } },
      channels: { telegram: {} },
    },
  });
}

async function buildGroupVoiceContext(params: {
  messageId: number;
  chatId: number;
  title: string;
  date: number;
  fromId: number;
  firstName: string;
  fileId: string;
  mediaPath: string;
  groupDisableAudioPreflight?: boolean;
  topicDisableAudioPreflight?: boolean;
  forceWasMentioned?: boolean;
}) {
  const groupConfig = {
    requireMention: true,
    ...(params.groupDisableAudioPreflight === undefined
      ? {}
      : { disableAudioPreflight: params.groupDisableAudioPreflight }),
  };
  const topicConfig =
    params.topicDisableAudioPreflight === undefined
      ? undefined
      : { disableAudioPreflight: params.topicDisableAudioPreflight };

  return buildTelegramMessageContextForTest({
    message: {
      message_id: params.messageId,
      chat: { id: params.chatId, type: "supergroup", title: params.title },
      date: params.date,
      text: undefined,
      from: { id: params.fromId, first_name: params.firstName },
      voice: { file_id: params.fileId },
    },
    allMedia: [{ path: params.mediaPath, contentType: "audio/ogg" }],
    options: params.forceWasMentioned ? { forceWasMentioned: true } : undefined,
    cfg: {
      agents: { defaults: { model: DEFAULT_MODEL, workspace: DEFAULT_WORKSPACE } },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [DEFAULT_MENTION_PATTERN] } },
    },
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => true,
    resolveTelegramGroupConfig: () => ({
      groupConfig,
      topicConfig,
    }),
  });
}

function expectAudioPlaceholderRendered(ctx: Awaited<ReturnType<typeof buildGroupVoiceContext>>) {
  expect(ctx).not.toBeNull();
  expect(ctx?.ctxPayload?.BodyForAgent).toBe("<media:audio>");
  expect(ctx?.ctxPayload?.Body).toContain("<media:audio>");
}

describe("buildTelegramMessageContext audio transcript body", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
  });

  it("skips DM preflight and keeps the audio marker in the body", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("hello from a voice note");

    const ctx = await buildDirectVoiceContext({
      messageId: 10,
      chatId: 42,
      date: 1_700_000_010,
      fromId: 42,
      firstName: "Pat",
      fileId: "voice-dm-1",
      mediaPath: "/tmp/voice-dm.ogg",
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(ctx?.ctxPayload?.BodyForAgent).toBe("<media:audio>");
    expect(ctx?.ctxPayload?.Body).toContain("<media:audio>");
    expect(ctx?.ctxPayload?.Body).not.toContain("hello from a voice note");
  });

  it("keeps the audio marker in the body when group preflight finds a mention", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("hey bot please help");

    const ctx = await buildGroupVoiceContext({
      messageId: 1,
      chatId: -1001234567890,
      title: "Test Group",
      date: 1_700_000_000,
      fromId: 42,
      firstName: "Alice",
      fileId: "voice-1",
      mediaPath: "/tmp/voice.ogg",
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(ctx?.ctxPayload?.BodyForAgent).toBe("<media:audio>");
    expect(ctx?.ctxPayload?.Body).toContain("<media:audio>");
    expect(ctx?.ctxPayload?.Body).not.toContain("hey bot please help");
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });

  it("skips preflight transcription when disableAudioPreflight is true", async () => {
    const ctx = await buildGroupVoiceContext({
      messageId: 2,
      chatId: -1001234567891,
      title: "Test Group 2",
      date: 1_700_000_100,
      fromId: 43,
      firstName: "Bob",
      fileId: "voice-2",
      mediaPath: "/tmp/voice2.ogg",
      groupDisableAudioPreflight: true,
      forceWasMentioned: true,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expectAudioPlaceholderRendered(ctx);
  });

  it("uses topic disableAudioPreflight=false to override group disableAudioPreflight=true", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("topic override transcript");

    const ctx = await buildGroupVoiceContext({
      messageId: 3,
      chatId: -1001234567892,
      title: "Test Group 3",
      date: 1_700_000_200,
      fromId: 44,
      firstName: "Cara",
      fileId: "voice-3",
      mediaPath: "/tmp/voice3.ogg",
      groupDisableAudioPreflight: true,
      topicDisableAudioPreflight: false,
      forceWasMentioned: true,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expectAudioPlaceholderRendered(ctx);
    expect(ctx?.ctxPayload?.Body).not.toContain("topic override transcript");
  });

  it("uses topic disableAudioPreflight=true to override group disableAudioPreflight=false", async () => {
    const ctx = await buildGroupVoiceContext({
      messageId: 4,
      chatId: -1001234567893,
      title: "Test Group 4",
      date: 1_700_000_300,
      fromId: 45,
      firstName: "Dan",
      fileId: "voice-4",
      mediaPath: "/tmp/voice4.ogg",
      groupDisableAudioPreflight: false,
      topicDisableAudioPreflight: true,
      forceWasMentioned: true,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expectAudioPlaceholderRendered(ctx);
  });
});

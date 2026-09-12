import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeFirstAudioMock = vi.fn();
const loadModelCatalogMock = vi.fn();
const findModelInCatalogMock = vi.fn();
const modelSupportsAudioMock = vi.fn();
const resolveDefaultModelForAgentMock = vi.fn();
const DEFAULT_MODEL = "anthropic/claude-opus-4-5";
const DEFAULT_WORKSPACE = "/tmp/openclaw";
const DEFAULT_MENTION_PATTERN = "\\bbot\\b";

vi.mock("./media-understanding.runtime.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

vi.mock("./bot-message-context.agent.runtime.js", () => ({
  findModelInCatalog: (...args: unknown[]) => findModelInCatalogMock(...args),
  loadModelCatalog: (...args: unknown[]) => loadModelCatalogMock(...args),
  modelSupportsAudio: (...args: unknown[]) => modelSupportsAudioMock(...args),
  resolveDefaultModelForAgent: (...args: unknown[]) => resolveDefaultModelForAgentMock(...args),
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
    options: { forceWasMentioned: true },
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

function expectTranscriptRendered(
  ctx: Awaited<ReturnType<typeof buildGroupVoiceContext>>,
  transcript: string,
) {
  expect(ctx).not.toBeNull();
  expect(ctx?.ctxPayload?.BodyForAgent).toBe(transcript);
  expect(ctx?.ctxPayload?.Body).toContain(transcript);
  expect(ctx?.ctxPayload?.Body).not.toContain("<media:audio>");
}

function expectAudioPlaceholderRendered(ctx: Awaited<ReturnType<typeof buildGroupVoiceContext>>) {
  expect(ctx).not.toBeNull();
  expect(ctx?.ctxPayload?.Body).toContain("<media:audio>");
}

describe("buildTelegramMessageContext audio transcript body", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
    loadModelCatalogMock.mockReset().mockResolvedValue([]);
    findModelInCatalogMock.mockReset().mockReturnValue(undefined);
    modelSupportsAudioMock.mockReset().mockReturnValue(false);
    resolveDefaultModelForAgentMock.mockReset().mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
  });

  it("skips DM preflight when the active model supports native audio", async () => {
    modelSupportsAudioMock.mockReturnValue(true);

    const ctx = await buildDirectVoiceContext({
      messageId: 10,
      chatId: 42,
      date: 1_700_000_010,
      fromId: 42,
      firstName: "Pat",
      fileId: "voice-native-1",
      mediaPath: "/tmp/voice-native.ogg",
    });

    expect(loadModelCatalogMock).toHaveBeenCalledTimes(1);
    expect(resolveDefaultModelForAgentMock).toHaveBeenCalledTimes(1);
    expect(findModelInCatalogMock).toHaveBeenCalledTimes(1);
    expect(modelSupportsAudioMock).toHaveBeenCalledTimes(1);
    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(ctx?.ctxPayload?.BodyForAgent).toBe("<media:audio>");
    expect(ctx?.ctxPayload?.Body).toContain("<media:audio>");
  });

  it("runs DM preflight when the active model does not support native audio", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("hello from a non-native voice note");

    const ctx = await buildDirectVoiceContext({
      messageId: 11,
      chatId: 43,
      date: 1_700_000_011,
      fromId: 43,
      firstName: "Quinn",
      fileId: "voice-nonnative-1",
      mediaPath: "/tmp/voice-nonnative.ogg",
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(ctx?.ctxPayload?.BodyForAgent).toBe("hello from a non-native voice note");
    expect(ctx?.ctxPayload?.Body).toContain("hello from a non-native voice note");
    expect(ctx?.ctxPayload?.Body).not.toContain("<media:audio>");
  });

  it("runs DM preflight when the active model cannot be resolved", async () => {
    loadModelCatalogMock.mockRejectedValueOnce(new Error("catalog unavailable"));
    transcribeFirstAudioMock.mockResolvedValueOnce("fallback transcript");

    const ctx = await buildDirectVoiceContext({
      messageId: 12,
      chatId: 44,
      date: 1_700_000_012,
      fromId: 44,
      firstName: "Riley",
      fileId: "voice-fallback-1",
      mediaPath: "/tmp/voice-fallback.ogg",
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(ctx?.ctxPayload?.BodyForAgent).toBe("fallback transcript");
  });

  it("uses preflight transcript as BodyForAgent for mention-gated group voice messages", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("hey bot please help");

    const ctx = await buildGroupVoiceContext({
      messageId: 1,
      chatId: -1001234567890,
      title: "Test Group",
      date: 1700000000,
      fromId: 42,
      firstName: "Alice",
      fileId: "voice-1",
      mediaPath: "/tmp/voice.ogg",
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expectTranscriptRendered(ctx, "hey bot please help");
  });

  it("skips preflight transcription when disableAudioPreflight is true", async () => {
    transcribeFirstAudioMock.mockClear();

    const ctx = await buildGroupVoiceContext({
      messageId: 2,
      chatId: -1001234567891,
      title: "Test Group 2",
      date: 1700000100,
      fromId: 43,
      firstName: "Bob",
      fileId: "voice-2",
      mediaPath: "/tmp/voice2.ogg",
      groupDisableAudioPreflight: true,
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
      date: 1700000200,
      fromId: 44,
      firstName: "Cara",
      fileId: "voice-3",
      mediaPath: "/tmp/voice3.ogg",
      groupDisableAudioPreflight: true,
      topicDisableAudioPreflight: false,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expectTranscriptRendered(ctx, "topic override transcript");
  });

  it("uses topic disableAudioPreflight=true to override group disableAudioPreflight=false", async () => {
    transcribeFirstAudioMock.mockClear();

    const ctx = await buildGroupVoiceContext({
      messageId: 4,
      chatId: -1001234567893,
      title: "Test Group 4",
      date: 1700000300,
      fromId: 45,
      firstName: "Dan",
      fileId: "voice-4",
      mediaPath: "/tmp/voice4.ogg",
      groupDisableAudioPreflight: false,
      topicDisableAudioPreflight: true,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expectAudioPlaceholderRendered(ctx);
  });
});

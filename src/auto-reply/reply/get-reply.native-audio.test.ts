import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import { registerGetReplyCommonMocks } from "./get-reply.test-mocks.js";

// Native-audio (skipAudio) decision for inbound media:
//
// `dennou.models.json` is the master model config: it may declare extended
// modalities (`input: ["text", "image", "audio"]`) that the PI SDK's
// models.json schema cannot carry. The SDK-facing `models.json` is auto-
// projected from it with "audio" stripped, and the in-memory catalog entry
// gets the audio modality restored. `modelSupportsAudio` keys purely off the
// catalog entry's `input` — it must NOT hardcode model ids/names. When the
// entry declares audio, Deepgram/STT fallback is skipped (skipAudio: true)
// and the raw audio is inlined to the model instead.
//
// The shared get-reply mocks fix the active model to openai/gpt-4o-mini, so
// the catalog entries here use that same provider/model id and vary only the
// declared `input` modalities (plus a gemini-flavored name on one entry to
// prove the decision is never name-driven).

const mocks = vi.hoisted(() => ({
  applyMediaUnderstanding: vi.fn(async (..._args: unknown[]) => undefined),
  applyLinkUnderstanding: vi.fn(async (..._args: unknown[]) => undefined),
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async (..._args: unknown[]) => undefined),
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
  loadModelCatalog: vi.fn(),
  hasInlineableNativeAudio: vi.fn(),
}));

registerGetReplyCommonMocks();

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: mocks.createInternalHookEvent,
  triggerInternalHook: mocks.triggerInternalHook,
}));
vi.mock("../../link-understanding/apply.js", () => ({
  applyLinkUnderstanding: mocks.applyLinkUnderstanding,
}));
vi.mock("../../link-understanding/apply.runtime.js", () => ({
  applyLinkUnderstanding: mocks.applyLinkUnderstanding,
}));
vi.mock("../../media-understanding/apply.js", () => ({
  applyMediaUnderstanding: mocks.applyMediaUnderstanding,
}));
vi.mock("../../media-understanding/apply.runtime.js", () => ({
  applyMediaUnderstanding: mocks.applyMediaUnderstanding,
}));
vi.mock("../../media/native-audio.js", () => ({
  hasInlineableNativeAudio: mocks.hasInlineableNativeAudio,
}));
vi.mock("../../agents/model-catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-catalog.js")>(
    "../../agents/model-catalog.js",
  );
  return {
    ...actual,
    loadModelCatalog: mocks.loadModelCatalog,
  };
});
vi.mock("./commands-core.js", () => ({
  emitResetCommandHooks: vi.fn(async () => undefined),
}));
vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: mocks.resolveReplyDirectives,
}));
vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: vi.fn(async () => ({ kind: "reply", reply: { text: "ok" } })),
}));
vi.mock("./session.js", () => ({
  initSessionState: mocks.initSessionState,
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;

async function loadFreshGetReplyModuleForTest() {
  vi.resetModules();
  ({ getReplyFromConfig } = await import("./get-reply.js"));
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

const ACTIVE_MODEL_ID = "gpt-4o-mini";
const ACTIVE_MODEL_PROVIDER = "openai";

const CATALOG_WITH_AUDIO = [
  {
    id: ACTIVE_MODEL_ID,
    name: "Gemini 3 Pro Preview",
    provider: ACTIVE_MODEL_PROVIDER,
    input: ["text", "image", "audio"],
  },
];

const CATALOG_WITHOUT_AUDIO = [
  {
    id: ACTIVE_MODEL_ID,
    name: "Gemini 3 Pro Preview",
    provider: ACTIVE_MODEL_PROVIDER,
    input: ["text", "image"],
  },
];

describe("getReplyFromConfig native audio (Deepgram skip)", () => {
  beforeEach(async () => {
    await loadFreshGetReplyModuleForTest();
    delete process.env.DENNOU_TEST_FAST;
    mocks.applyMediaUnderstanding.mockReset();
    mocks.applyLinkUnderstanding.mockReset();
    mocks.createInternalHookEvent.mockReset();
    mocks.triggerInternalHook.mockReset();
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    mocks.loadModelCatalog.mockReset();
    mocks.hasInlineableNativeAudio.mockReset();

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
    mocks.hasInlineableNativeAudio.mockResolvedValue(true);
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

  it("skips Deepgram (skipAudio: true) when the model entry declares audio input", async () => {
    // dennou.models.json master: the catalog entry carries "audio" even though
    // the SDK-facing models.json cannot.
    mocks.loadModelCatalog.mockResolvedValue(CATALOG_WITH_AUDIO);

    await getReplyFromConfig(buildCtx(), undefined, {});

    // hasInlineableNativeAudio is consulted because modelSupportsAudio()
    // recognizes the declared audio modality on the catalog entry.
    expect(mocks.hasInlineableNativeAudio).toHaveBeenCalledTimes(1);
    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledWith(
      expect.objectContaining({ skipAudio: true }),
    );
  });

  it("falls back to Deepgram (skipAudio: false) when the model entry lacks audio input", async () => {
    // Even for a gemini-flavored name, absence of the declared modality must
    // keep the STT fallback: the decision is config-driven, never name-driven.
    mocks.loadModelCatalog.mockResolvedValue(CATALOG_WITHOUT_AUDIO);

    await getReplyFromConfig(buildCtx(), undefined, {});

    expect(mocks.hasInlineableNativeAudio).not.toHaveBeenCalled();
    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledWith(
      expect.objectContaining({ skipAudio: false }),
    );
  });
});

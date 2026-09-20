import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import { getReplyFromConfig } from "./get-reply.js";
import type { GetReplyDeps } from "./get-reply.js";

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
  resolveSessionModelOverrideSnapshot: vi.fn(),
  loadModelCatalog: vi.fn(),
  hasInlineableNativeAudio: vi.fn(),
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
    runPreparedReply: async () => undefined,
    resolveReplyDirectives: mocks.resolveReplyDirectives as never,
    handleInlineActions: (async () => ({ kind: "reply", reply: { text: "ok" } })) as never,
    initSessionState: mocks.initSessionState as never,
    resolveSessionModelOverrideSnapshot: mocks.resolveSessionModelOverrideSnapshot as never,
    applyMediaUnderstanding: mocks.applyMediaUnderstanding as never,
    applyLinkUnderstanding: mocks.applyLinkUnderstanding as never,
    loadModelCatalog: mocks.loadModelCatalog as never,
    hasInlineableNativeAudio: mocks.hasInlineableNativeAudio as never,
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
  beforeEach(() => {
    delete process.env.DENNOU_TEST_FAST;
    mocks.applyMediaUnderstanding.mockReset();
    mocks.applyLinkUnderstanding.mockReset();
    mocks.createInternalHookEvent.mockReset();
    mocks.triggerInternalHook.mockReset();
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    mocks.resolveSessionModelOverrideSnapshot.mockReset();
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
    mocks.resolveSessionModelOverrideSnapshot.mockReturnValue(null);
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

    await getReplyFromConfig(buildCtx(), undefined, {}, getTestDeps());

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

    await getReplyFromConfig(buildCtx(), undefined, {}, getTestDeps());

    expect(mocks.hasInlineableNativeAudio).not.toHaveBeenCalled();
    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledWith(
      expect.objectContaining({ skipAudio: false }),
    );
  });

  it("applies a session-stored audio-capable override (skipAudio: true) before media understanding", async () => {
    // User previously switched `/model agy-gemini-3.8-flash` (native audio).
    // The persisted session override must be resolved from the session entry
    // BEFORE media understanding, so the native-audio decision uses the
    // overridden model instead of the global default (openai/gpt-4o-mini,
    // which has no audio input).
    mocks.loadModelCatalog.mockResolvedValue([
      {
        id: "agy-gemini-3.8-flash",
        name: "AGY Gemini 3.8 Flash",
        provider: "google",
        input: ["text", "image", "audio"],
      },
    ]);
    mocks.resolveSessionModelOverrideSnapshot.mockReturnValue({
      sessionEntry: {
        sessionId: "session-1",
        modelOverride: "agy-gemini-3.8-flash",
        providerOverride: "google",
      },
      sessionStore: {},
      sessionKey: "agent:main:telegram:-100123",
    });

    await getReplyFromConfig(buildCtx(), undefined, {}, getTestDeps());

    expect(mocks.resolveSessionModelOverrideSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ SessionKey: "agent:main:telegram:-100123" }),
      }),
    );
    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledWith(
      expect.objectContaining({
        activeModel: { provider: "google", model: "agy-gemini-3.8-flash" },
        skipAudio: true,
      }),
    );
    expect(mocks.hasInlineableNativeAudio).toHaveBeenCalledTimes(1);
  });

  it("keeps Deepgram (skipAudio: false) when the session override lacks audio input", async () => {
    // The session override takes precedence over the global default for the
    // media decision in both directions: a non-audio override must NOT get
    // native audio inlining just because the default model would.
    mocks.loadModelCatalog.mockResolvedValue([
      {
        id: "agy-gemini-3.8-flash",
        name: "AGY Gemini 3.8 Flash",
        provider: "google",
        input: ["text", "image"],
      },
    ]);
    mocks.resolveSessionModelOverrideSnapshot.mockReturnValue({
      sessionEntry: {
        sessionId: "session-1",
        modelOverride: "agy-gemini-3.8-flash",
        providerOverride: "google",
      },
      sessionStore: {},
      sessionKey: "agent:main:telegram:-100123",
    });

    await getReplyFromConfig(buildCtx(), undefined, {}, getTestDeps());

    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledWith(
      expect.objectContaining({
        activeModel: { provider: "google", model: "agy-gemini-3.8-flash" },
        skipAudio: false,
      }),
    );
    expect(mocks.hasInlineableNativeAudio).not.toHaveBeenCalled();
  });
});

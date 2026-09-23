import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import {
  applyMediaUnderstanding as applyMediaUnderstandingImpl,
  type ApplyMediaUnderstandingDeps,
} from "./apply.js";
import { normalizeMediaProviderId } from "./provider-registry.js";
import { clearMediaUnderstandingBinaryCacheForTests } from "./runner.js";
import { createSafeAudioFixtureBuffer } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Call-time dependency fakes (injected through `deps`, no module mocks)
// ---------------------------------------------------------------------------

type ResolveApiKeyForProvider = typeof import("../agents/model-auth.js").resolveApiKeyForProvider;

const resolveApiKeyForProviderMock = vi.fn<ResolveApiKeyForProvider>(async () => ({
  apiKey: "test-key", // pragma: allowlist secret
  source: "test",
  mode: "api-key",
}));
const mockDeliverOutboundPayloads = vi.fn();

function createRegistryMediaProviders(): Record<string, MediaUnderstandingProvider> {
  const createAudioProvider = (id: string): MediaUnderstandingProvider => ({
    id,
    capabilities: ["audio"],
    transcribeAudio: async () => ({ text: "transcribed text" }),
  });
  return {
    groq: createAudioProvider("groq"),
    deepgram: createAudioProvider("deepgram"),
  };
}

// Replaces the real registry builder (which walks bundled plugin discovery and
// re-materializes the active plugin registry) with the in-test provider set.
function buildMediaUnderstandingRegistryForTest(
  overrides?: Record<string, MediaUnderstandingProvider>,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  for (const [key, provider] of Object.entries(createRegistryMediaProviders())) {
    registry.set(normalizeMediaProviderId(key), provider);
  }
  for (const [key, provider] of Object.entries(overrides ?? {})) {
    const normalizedKey = normalizeMediaProviderId(key);
    const existing = registry.get(normalizedKey);
    registry.set(
      normalizedKey,
      existing
        ? {
            ...existing,
            ...provider,
            capabilities: provider.capabilities ?? existing.capabilities,
          }
        : provider,
    );
  }
  return registry;
}

const echoTranscriptDeps: ApplyMediaUnderstandingDeps = {
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
  buildMediaUnderstandingRegistry: buildMediaUnderstandingRegistryForTest,
  deliverOutboundPayloads: (...args) => mockDeliverOutboundPayloads(...args),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const applyMediaUnderstanding = (
  params: Parameters<typeof applyMediaUnderstandingImpl>[0],
): ReturnType<typeof applyMediaUnderstandingImpl> =>
  applyMediaUnderstandingImpl({ ...params, deps: { ...params.deps, ...echoTranscriptDeps } });

const TEMP_MEDIA_PREFIX = "openclaw-echo-transcript-test-";
let suiteTempMediaRootDir = "";
let installedWhatsAppRegistry = false;

// Note: under Vitest, test/setup-openclaw-runtime.ts registers a whatsapp
// channel stub, so `whatsapp` is a deliverable message channel. The Bun preload
// installs no plugin registry, so the same stub is registered here only when the
// runtime has none — behaviour is untouched under Vitest.
function ensureWhatsAppChannelRegistered(): void {
  if (isDeliverableMessageChannel("whatsapp")) {
    return;
  }
  installedWhatsAppRegistry = true;
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "whatsapp",
        plugin: createChannelTestPluginBase({ id: "whatsapp", label: "WhatsApp" }),
        source: "test",
      },
    ]),
  );
}

async function createTempAudioFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(suiteTempMediaRootDir, "case-"));
  const filePath = path.join(dir, "note.ogg");
  await fs.writeFile(filePath, createSafeAudioFixtureBuffer(2048));
  return filePath;
}

function createAudioCtxWithProvider(mediaPath: string, extra?: Partial<MsgContext>): MsgContext {
  return {
    Body: "<media:audio>",
    MediaPath: mediaPath,
    MediaType: "audio/ogg",
    Provider: "whatsapp",
    From: "+10000000001",
    AccountId: "acc1",
    ...extra,
  };
}

function createAudioConfigWithEcho(opts?: {
  echoTranscript?: boolean;
  echoFormat?: string;
  transcribedText?: string;
}): {
  cfg: OpenClawConfig;
  providers: Record<string, { id: string; transcribeAudio: () => Promise<{ text: string }> }>;
} {
  const cfg: OpenClawConfig = {
    tools: {
      media: {
        audio: {
          enabled: true,
          maxBytes: 1024 * 1024,
          models: [{ provider: "groq" }],
          echoTranscript: opts?.echoTranscript ?? true,
          ...(opts?.echoFormat !== undefined ? { echoFormat: opts.echoFormat } : {}),
        },
      },
    },
  };
  const providers = {
    groq: {
      id: "groq",
      transcribeAudio: async () => ({ text: opts?.transcribedText ?? "hello world" }),
    },
  };
  return { cfg, providers };
}

function expectSingleEchoDeliveryCall() {
  expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
  const callArgs = mockDeliverOutboundPayloads.mock.calls[0]?.[0];
  expect(callArgs).toBeDefined();
  return callArgs as {
    to?: string;
    channel?: string;
    accountId?: string;
    payloads: Array<{ text?: string }>;
  };
}

function createAudioConfigWithoutEchoFlag() {
  const { cfg, providers } = createAudioConfigWithEcho();
  const audio = cfg.tools?.media?.audio as { echoTranscript?: boolean } | undefined;
  if (audio && "echoTranscript" in audio) {
    delete audio.echoTranscript;
  }
  return { cfg, providers };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyMediaUnderstanding – echo transcript", () => {
  beforeAll(async () => {
    ensureWhatsAppChannelRegistered();
    const baseDir = resolvePreferredOpenClawTmpDir();
    await fs.mkdir(baseDir, { recursive: true });
    suiteTempMediaRootDir = await fs.mkdtemp(path.join(baseDir, TEMP_MEDIA_PREFIX));
  });

  beforeEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    mockDeliverOutboundPayloads.mockClear();
    mockDeliverOutboundPayloads.mockResolvedValue([{ channel: "whatsapp", messageId: "echo-1" }]);
    clearMediaUnderstandingBinaryCacheForTests();
  });

  afterAll(async () => {
    if (installedWhatsAppRegistry) {
      resetPluginRuntimeStateForTest();
      installedWhatsAppRegistry = false;
    }
    if (!suiteTempMediaRootDir) {
      return;
    }
    await fs.rm(suiteTempMediaRootDir, { recursive: true, force: true });
    suiteTempMediaRootDir = "";
  });

  it("does NOT echo when echoTranscript is false (default)", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho({ echoTranscript: false });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does NOT echo when echoTranscript is absent (default)", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithoutEchoFlag();

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("echoes transcript with default format when echoTranscript is true", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho({
      echoTranscript: true,
      transcribedText: "hello world",
    });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    const callArgs = expectSingleEchoDeliveryCall();
    expect(callArgs.channel).toBe("whatsapp");
    expect(callArgs.to).toBe("+10000000001");
    expect(callArgs.accountId).toBe("acc1");
    expect(callArgs.payloads).toHaveLength(1);
    expect(callArgs.payloads[0].text).toBe('📝 "hello world"');
  });

  it("uses custom echoFormat when provided", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho({
      echoTranscript: true,
      echoFormat: "🎙️ Heard: {transcript}",
      transcribedText: "custom message",
    });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    const callArgs = expectSingleEchoDeliveryCall();
    expect(callArgs.payloads[0].text).toBe("🎙️ Heard: custom message");
  });

  it("does NOT echo when there are no audio attachments", async () => {
    // Image-only context — no audio attachment
    const dir = await fs.mkdtemp(path.join(suiteTempMediaRootDir, "img-"));
    const imgPath = path.join(dir, "photo.jpg");
    await fs.writeFile(imgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    const ctx: MsgContext = {
      Body: "<media:image>",
      MediaPath: imgPath,
      MediaType: "image/jpeg",
      Provider: "whatsapp",
      From: "+10000000001",
    };

    const { cfg, providers } = createAudioConfigWithEcho({
      echoTranscript: true,
      transcribedText: "should not appear",
    });
    cfg.tools!.media!.image = { enabled: false };

    await applyMediaUnderstanding({ ctx, cfg, providers });

    // No audio outputs → Transcript not set → no echo
    expect(ctx.Transcript).toBeUndefined();
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does NOT echo when transcription fails", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho({ echoTranscript: true });
    providers.groq.transcribeAudio = async () => {
      throw new Error("transcription provider failure");
    };

    // Should not throw; transcription failure is swallowed by runner
    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(ctx.Transcript).toBeUndefined();
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does NOT echo when channel is not deliverable", async () => {
    const mediaPath = await createTempAudioFile();
    // Use an internal/non-deliverable channel
    const ctx = createAudioCtxWithProvider(mediaPath, {
      Provider: "internal-system",
      From: "some-source",
    });
    const { cfg, providers } = createAudioConfigWithEcho({ echoTranscript: true });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    // Transcript should be set (transcription succeeded)
    expect(ctx.Transcript).toBe("hello world");
    // But echo should be skipped
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does NOT echo when ctx has no From or OriginatingTo", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx: MsgContext = {
      Body: "<media:audio>",
      MediaPath: mediaPath,
      MediaType: "audio/ogg",
      Provider: "whatsapp",
      // From and OriginatingTo intentionally absent
    };
    const { cfg, providers } = createAudioConfigWithEcho({ echoTranscript: true });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(ctx.Transcript).toBe("hello world");
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("uses OriginatingTo when From is absent", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx: MsgContext = {
      Body: "<media:audio>",
      MediaPath: mediaPath,
      MediaType: "audio/ogg",
      Provider: "whatsapp",
      OriginatingTo: "+19999999999",
    };
    const { cfg, providers } = createAudioConfigWithEcho({ echoTranscript: true });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    const callArgs = expectSingleEchoDeliveryCall();
    expect(callArgs.to).toBe("+19999999999");
  });

  it("echo delivery failure does not throw or break transcription", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho({ echoTranscript: true });

    mockDeliverOutboundPayloads.mockRejectedValueOnce(new Error("delivery timeout"));

    // Should not throw
    const result = await applyMediaUnderstanding({ ctx, cfg, providers });

    // Transcription itself succeeded
    expect(result.appliedAudio).toBe(true);
    expect(ctx.Transcript).toBe("hello world");
    // Deliver was attempted
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  AudioTranscriptionRequest,
  MediaUnderstandingProvider,
} from "../../media-understanding/types.js";
import { createAudioTool } from "./audio-tool.js";

// Keep these tests focused on the tool instead of paying the full plugin
// capability registry build (slow in the test environment). The registry
// override mirrors the engine unit tests: a plain Map keyed by provider id.
vi.mock("../../media-understanding/runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../media-understanding/runner.js")>(
    "../../media-understanding/runner.js",
  );
  return {
    ...actual,
    buildProviderRegistry: (
      overrides?: Record<string, MediaUnderstandingProvider>,
    ): Map<string, MediaUnderstandingProvider> => new Map(Object.entries(overrides ?? {})),
  };
});

// Fake engine provider: replaces the network STT call, so tests exercise the
// real media-understanding pipeline (attachment cache, file read, min-size
// check, prompt wiring) without touching external services.
function createFakeAudioProvider(transcript = "hello from fake stt"): MediaUnderstandingProvider {
  return {
    id: "deepgram",
    capabilities: ["audio"],
    transcribeAudio: async (req: AudioTranscriptionRequest) => ({
      text: req.prompt ? `${transcript} [prompt=${req.prompt}]` : transcript,
      model: req.model,
    }),
  };
}

function createAudioConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-4o-mini" },
      },
    },
    models: {
      providers: {
        deepgram: {
          baseUrl: "https://api.deepgram.com",
          apiKey: "test-key",
          models: [],
        },
      },
    },
    tools: {
      media: {
        audio: {
          enabled: true,
          models: [{ provider: "deepgram", model: "nova-3" }],
        },
      },
    },
  };
}

function createSafeAudioFixtureBuffer(size = 2048, fill = 0x52): Buffer {
  return Buffer.alloc(size, fill);
}

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

async function withTempAudioFile(
  cb: (args: { workspaceDir: string; audioPath: string }) => Promise<void>,
  options?: { relativeDir?: string; parentDir?: string },
): Promise<void> {
  const parentDir = options?.parentDir ?? os.tmpdir();
  const workspaceParent = await fs.mkdtemp(path.join(parentDir, "openclaw-workspace-audio-"));
  try {
    const workspaceDir = path.join(workspaceParent, "workspace");
    const relativeDir = options?.relativeDir ?? "";
    const audioDir = relativeDir ? path.join(workspaceDir, relativeDir) : workspaceDir;
    await fs.mkdir(audioDir, { recursive: true });
    const audioPath = path.join(audioDir, relativeDir ? "note.wav" : "voice.wav");
    await fs.writeFile(audioPath, createSafeAudioFixtureBuffer());
    await cb({ workspaceDir, audioPath });
  } finally {
    await fs.rm(workspaceParent, { recursive: true, force: true });
  }
}

function requireAudioTool(
  tool: ReturnType<typeof createAudioTool>,
): NonNullable<ReturnType<typeof createAudioTool>> {
  if (!tool) {
    throw new Error("expected audio tool");
  }
  return tool;
}

describe("audio tool", () => {
  beforeEach(() => {
    vi.stubEnv("PATH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("transcribes a local audio file with the configured engine", async () => {
    await withTempAgentDir(async (agentDir) => {
      await withTempAudioFile(async ({ workspaceDir, audioPath }) => {
        const cfg = createAudioConfig();
        const tool = requireAudioTool(
          createAudioTool({
            config: cfg,
            agentDir,
            workspaceDir,
            providers: { deepgram: createFakeAudioProvider() },
          }),
        );

        const result = await tool.execute("t1", { path: audioPath });

        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("hello from fake stt");
        const details = result.details as { path?: string; provider?: string; model?: string };
        expect(details.path).toBe(audioPath);
        expect(details.provider).toBe("deepgram");
        expect(details.model).toBe("nova-3");
      });
    });
  });

  it("forwards the tool prompt and defaults it when omitted", async () => {
    await withTempAgentDir(async (agentDir) => {
      await withTempAudioFile(async ({ workspaceDir, audioPath }) => {
        const cfg = createAudioConfig();
        const tool = requireAudioTool(
          createAudioTool({
            config: cfg,
            agentDir,
            workspaceDir,
            providers: { deepgram: createFakeAudioProvider() },
          }),
        );

        const withPrompt = await tool.execute("t1", {
          path: audioPath,
          prompt: "What is the tone?",
        });
        expect((withPrompt.content[0] as { text: string }).text).toContain(
          "[prompt=What is the tone?]",
        );

        const withoutPrompt = await tool.execute("t2", { path: audioPath });
        expect((withoutPrompt.content[0] as { text: string }).text).toContain(
          "[prompt=Transcribe and describe the audio content.]",
        );
      });
    });
  });

  it("resolves relative audio paths against workspaceDir", async () => {
    await withTempAgentDir(async (agentDir) => {
      await withTempAudioFile(
        async ({ workspaceDir }) => {
          const cfg = createAudioConfig();
          const tool = requireAudioTool(
            createAudioTool({
              config: cfg,
              agentDir,
              workspaceDir,
              providers: { deepgram: createFakeAudioProvider() },
            }),
          );

          const result = await tool.execute("t1", { path: "notes/note.wav" });

          const details = result.details as { path?: string };
          expect(details.path).toBe(path.join(workspaceDir, "notes", "note.wav"));
          expect((result.content[0] as { text: string }).text).toContain("hello from fake stt");
        },
        { relativeDir: "notes" },
      );
    });
  });

  it("rejects missing path and unsupported references", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg = createAudioConfig();
      const tool = requireAudioTool(createAudioTool({ config: cfg, agentDir }));

      await expect(tool.execute("t1", {} as never)).rejects.toThrow(/path required/i);
      await expect(tool.execute("t2", { path: "" })).rejects.toThrow(/path required/i);

      const unsupported = await tool.execute("t3", { path: "ftp://example.com/a.mp3" });
      expect(unsupported.details).toMatchObject({ error: "unsupported_audio_reference" });
    });
  });

  it("honors fsPolicy.workspaceOnly for local audio paths", async () => {
    await withTempAgentDir(async (agentDir) => {
      await withTempAudioFile(async ({ workspaceDir }) => {
        const cfg = createAudioConfig();
        const tool = requireAudioTool(
          createAudioTool({
            config: cfg,
            agentDir,
            workspaceDir,
            fsPolicy: { workspaceOnly: true },
            providers: { deepgram: createFakeAudioProvider() },
          }),
        );

        // File inside the workspace is allowed.
        const inside = await tool.execute("t1", { path: "voice.wav" });
        expect((inside.content[0] as { text: string }).text).toContain("hello from fake stt");

        // File outside the workspace is blocked by the inbound path policy.
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-outside-"));
        const outsidePath = path.join(outsideDir, "secret.wav");
        await fs.writeFile(outsidePath, createSafeAudioFixtureBuffer());
        try {
          const result = await tool.execute("t2", { path: outsidePath });
          expect(result.details).toMatchObject({ error: "no_transcript" });
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      });
    });
  });

  it("stays disabled when audio understanding is explicitly disabled in config", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        tools: { media: { audio: { enabled: false } } },
      };
      expect(createAudioTool({ config: cfg, agentDir })).toBeNull();
    });
  });

  it("exposes an Anthropic-safe schema without union keywords", async () => {
    await withTempAgentDir(async (agentDir) => {
      const tool = requireAudioTool(createAudioTool({ config: createAudioConfig(), agentDir }));
      const schema = JSON.parse(JSON.stringify(tool.parameters)) as {
        type?: unknown;
        properties?: Record<string, { type?: unknown }>;
        required?: string[];
      };
      expect(schema.type).toBe("object");
      expect(schema.properties?.path?.type).toBe("string");
      expect(schema.properties?.prompt?.type).toBe("string");
      expect(schema.required).toEqual(["path"]);
      expect(JSON.stringify(schema)).not.toMatch(/anyOf|oneOf|allOf/);
    });
  });
});

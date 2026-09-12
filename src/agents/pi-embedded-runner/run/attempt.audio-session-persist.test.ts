import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  resetEmbeddedAttemptHarness,
  type MutableSession,
} from "./attempt.spawn-workspace.test-support.js";

const AUDIO_MODEL = {
  api: "openai-completions",
  provider: "openai",
  compat: {},
  contextWindow: 8192,
  input: ["text", "audio"],
} as unknown as Model<Api>;

/**
 * Minimal but valid RIFF/WAVE fixture so mime sniffing identifies the payload
 * as audio/wav (matching how real inbound voice notes reach the pipeline).
 */
function createWavFixtureBuffer(payloadSize = 4096): Buffer {
  const dataSize = payloadSize;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(payloadSize, 0x52)]);
}

function findAudioPart(parts: unknown[]): { type: "audio"; data: string; mimeType: string } | null {
  const part = parts.find((entry) => (entry as { type?: unknown } | null)?.type === "audio");
  return part ? (part as { type: "audio"; data: string; mimeType: string }) : null;
}

describe("audio base64 session persistence (runEmbeddedAttempt wiring)", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempPaths(tempPaths);
  });

  it("passes native audio blocks through the session prompt images options", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-attempt-"));
    tempPaths.push(workspaceDir);
    const audioPath = path.join(workspaceDir, "voice.wav");
    const fixture = createWavFixtureBuffer();
    await fs.writeFile(audioPath, fixture);

    let promptImages: unknown[] | undefined;
    const sessionPrompt: (
      session: MutableSession,
      prompt: string,
      options?: { images?: unknown[] },
    ) => Promise<void> = async (session, _prompt, options) => {
      promptImages = options?.images;
      session.messages = [
        ...session.messages,
        { role: "assistant", content: "done", timestamp: 2 } as unknown as AgentMessage,
      ];
    };

    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
        compact: async () => ({ ok: false, compacted: false, reason: "test" }),
        info: { id: "test-ctx-engine", name: "Test Context Engine", version: "0.0.1" },
      },
      sessionKey: "agent:main:test:audio-persist",
      sessionPrompt,
      tempPaths,
      attemptOverrides: {
        model: AUDIO_MODEL,
        provider: "openai",
        modelId: "gpt-4o-audio",
        nativeAudioPaths: [audioPath],
        nativeAudioTypes: ["audio/wav"],
        nativeAudioMimeType: "audio/wav",
        config: {},
        workspaceDir,
      },
    });

    // The user message the PI SDK builds from { images: [...] } carries the
    // audio block, which means the session JSONL user entry will include the
    // base64 payload (`{ type: "audio", data, mimeType }`) instead of only a
    // text placeholder.
    expect(promptImages).toBeDefined();
    const audioBlock = findAudioPart(promptImages ?? []);
    expect(audioBlock).not.toBeNull();
    expect(audioBlock?.mimeType).toBe("audio/wav");
    expect(Buffer.from(audioBlock?.data ?? "", "base64")).toEqual(fixture);
  });

  it("leaves the prompt images option empty when no native audio attaches", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-attempt-"));
    tempPaths.push(workspaceDir);

    let promptImages: unknown[] | undefined;
    const sessionPrompt: (
      session: MutableSession,
      prompt: string,
      options?: { images?: unknown[] },
    ) => Promise<void> = async (session, _prompt, options) => {
      promptImages = options?.images;
      session.messages = [
        ...session.messages,
        { role: "assistant", content: "done", timestamp: 2 } as unknown as AgentMessage,
      ];
    };

    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
        compact: async () => ({ ok: false, compacted: false, reason: "test" }),
        info: { id: "test-ctx-engine", name: "Test Context Engine", version: "0.0.1" },
      },
      sessionKey: "agent:main:test:audio-persist-empty",
      sessionPrompt,
      tempPaths,
      attemptOverrides: {
        model: AUDIO_MODEL,
        provider: "openai",
        modelId: "gpt-4o-audio",
        workspaceDir,
      },
    });

    expect(findAudioPart(promptImages ?? [])).toBeNull();
  });
});

describe("audio base64 session persistence (SessionManager JSONL round-trip)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-jsonl-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("persists and reloads a user message whose content contains the audio base64 block", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const sm = SessionManager.open(sessionFile);

    // Mirrors pi-coding-agent's AgentSession.prompt(): user content is built
    // from `[{ type: "text" }, ...options.images]` and persisted through
    // sessionManager.appendMessage on message_end.
    const audioBlock = {
      type: "audio",
      data: Buffer.from("fake-ogg-payload").toString("base64"),
      mimeType: "audio/ogg",
    };
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "hear this clip" }, audioBlock],
      timestamp: Date.now(),
    };
    sm.appendMessage(userMessage as never);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "stop",
      timestamp: Date.now(),
    } as never);

    const entries = sm.getEntries();
    const userEntry = entries.find(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    expect(userEntry).toBeDefined();
    const content = (userEntry as { message: { content: unknown[] } }).message.content;
    const persistedAudio = findAudioPart(content);
    expect(persistedAudio).not.toBeNull();
    expect(persistedAudio?.mimeType).toBe("audio/ogg");
    expect(persistedAudio?.data).toBe(audioBlock.data);
    expect(Buffer.from(persistedAudio?.data ?? "", "base64").toString()).toBe("fake-ogg-payload");

    // The on-disk JSONL must contain the same block verbatim.
    const rawFile = await fs.readFile(sessionFile, "utf8");
    const rawUserLine = rawFile
      .split("\n")
      .find((line) => line.includes('"role":"user"') || line.includes('"role": "user"'));
    expect(rawUserLine).not.toBeUndefined();
    expect(rawUserLine).toContain('"type":"audio"');
    expect(rawUserLine).toContain(audioBlock.data);
  });
});

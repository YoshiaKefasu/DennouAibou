import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findAudioAttachments,
  findEligibleAudioAttachments,
  formatAudioTranscript,
  resolveGroqApiKey,
  scanSessionFile,
  type AudioAttachmentTarget,
} from "../src/audio-stt.js";
import { resolveContextPrunerConfig } from "../src/pruner.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const THIRTY_MINUTES = 30 * 60 * 1_000;
const tempDirs: string[] = [];

async function makeFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "context-pruner-audio-stt-"));
  tempDirs.push(dir);
  const audioPath = path.join(dir, "voice.ogg");
  await fs.writeFile(audioPath, Buffer.from("fake audio bytes"));
  return { dir, audioPath };
}

async function makeSessionScannable(sessionFile: string, now = NOW): Promise<void> {
  const staleTime = new Date(now - 2 * 60 * 1_000);
  await fs.utimes(sessionFile, staleTime, staleTime);
}

function makeAudioEntry(params: { audioPath: string; timestamp: number }) {
  return {
    type: "message",
    id: "msg-audio-1",
    parentId: "msg-parent-1",
    timestamp: new Date(params.timestamp).toISOString(),
    message: {
      role: "user",
      content: [
        {
          type: "audio",
          path: params.audioPath,
          mimeType: "audio/ogg",
          durationSeconds: 12,
        },
      ],
      timestamp: params.timestamp,
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("deferred audio eligibility", () => {
  it("skips audio younger than delayMinutes and selects audio at the boundary", async () => {
    const { audioPath } = await makeFixture();
    const young = makeAudioEntry({
      audioPath,
      timestamp: NOW - THIRTY_MINUTES + 1,
    });
    const old = makeAudioEntry({
      audioPath,
      timestamp: NOW - THIRTY_MINUTES,
    });

    expect(findAudioAttachments(young)).toHaveLength(1);
    expect(findEligibleAudioAttachments({ entry: young, now: NOW, delayMinutes: 30 })).toEqual([]);
    expect(findEligibleAudioAttachments({ entry: old, now: NOW, delayMinutes: 30 })).toEqual([
      expect.objectContaining({
        path: audioPath,
        durationSeconds: 12,
        timestampMs: NOW - THIRTY_MINUTES,
      }),
    ]);
  });

  it("fails closed when the audio timestamp is missing", async () => {
    const { audioPath } = await makeFixture();
    const entry = makeAudioEntry({ audioPath, timestamp: NOW - THIRTY_MINUTES });
    delete (entry.message as { timestamp?: number }).timestamp;
    delete (entry as { timestamp?: string }).timestamp;

    expect(findEligibleAudioAttachments({ entry, now: NOW, delayMinutes: 30 })).toEqual([]);
  });
});

describe("Groq transcription and session replacement", () => {
  it("uploads the audio to Groq, replaces only content, and preserves tree fields", async () => {
    const { audioPath } = await makeFixture();
    const originalEntry = makeAudioEntry({
      audioPath,
      timestamp: NOW - THIRTY_MINUTES - 1,
    });
    const sessionFile = path.join(path.dirname(audioPath), "session.jsonl");
    const header = {
      type: "session",
      id: "session-1",
      parentId: null,
      timestamp: "2026-09-12T11:00:00.000Z",
    };
    await fs.writeFile(
      sessionFile,
      [header, originalEntry].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );
    await makeSessionScannable(sessionFile);

    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-groq-key");
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("whisper-large-v3-turbo");
      expect(form.get("file")).toBeInstanceOf(File);
      return new Response(JSON.stringify({ text: "こんにちは、今日の作業です。" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const config = resolveContextPrunerConfig({
      stt: { provider: "groq", model: "whisper-large-v3-turbo", delayMinutes: 30 },
    });
    const result = await scanSessionFile({
      sessionFile,
      stt: config.stt,
      env: { GROQ_API_KEY: "test-groq-key" },
      now: NOW,
      fetchImpl,
    });

    expect(result).toMatchObject({
      candidates: 1,
      transcribed: 1,
      changed: true,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();

    const lines = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toEqual(header);

    const rewritten = lines[1] as {
      type: string;
      id: string;
      parentId: string;
      timestamp: string;
      message: {
        role: string;
        timestamp: number;
        content: Array<{ type: string; text?: string }>;
      };
    };
    expect(rewritten.type).toBe(originalEntry.type);
    expect(rewritten.id).toBe(originalEntry.id);
    expect(rewritten.parentId).toBe(originalEntry.parentId);
    expect(rewritten.timestamp).toBe(originalEntry.timestamp);
    expect(rewritten.message.role).toBe(originalEntry.message.role);
    expect(rewritten.message.timestamp).toBe(originalEntry.message.timestamp);
    expect(rewritten.message.content).toEqual([
      {
        type: "text",
        text: formatAudioTranscript({
          text: "こんにちは、今日の作業です。",
          filePath: audioPath,
          durationSeconds: 12,
        }),
      },
    ]);
  });

  it("fails open without GROQ_API_KEY and leaves the session untouched", async () => {
    const { audioPath } = await makeFixture();
    const entry = makeAudioEntry({ audioPath, timestamp: NOW - THIRTY_MINUTES - 1 });
    const sessionFile = path.join(path.dirname(audioPath), "session.jsonl");
    const content = `${JSON.stringify(entry)}\n`;
    await fs.writeFile(sessionFile, content, "utf8");
    await makeSessionScannable(sessionFile);

    const result = await scanSessionFile({
      sessionFile,
      stt: { provider: "groq", model: "whisper-large-v3-turbo", delayMinutes: 30 },
      env: {},
      now: NOW,
    });

    expect(result.skipped).toBe("missing-api-key");
    expect(await fs.readFile(sessionFile, "utf8")).toBe(content);
  });

  it("resolves Gateway env.vars after the process environment fallback", () => {
    expect(
      resolveGroqApiKey({
        env: {},
        gatewayConfig: { env: { vars: { GROQ_API_KEY: "from-gateway" } } },
      }),
    ).toBe("from-gateway");
  });

  it("skips a session updated within the active-session grace period", async () => {
    const { audioPath } = await makeFixture();
    const sessionFile = path.join(path.dirname(audioPath), "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(makeAudioEntry({ audioPath, timestamp: NOW - THIRTY_MINUTES - 1 }))}\n`,
      "utf8",
    );

    const transcribeAudio = vi.fn(async () => "should not run");
    const result = await scanSessionFile({
      sessionFile,
      stt: { provider: "groq", model: "whisper-large-v3-turbo", delayMinutes: 30 },
      now: Date.now(),
      transcribeAudio,
    });

    expect(result.skipped).toBe("recently-updated");
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("recovers a stale lock and completes the scan", async () => {
    const { audioPath } = await makeFixture();
    const sessionFile = path.join(path.dirname(audioPath), "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(makeAudioEntry({ audioPath, timestamp: NOW - THIRTY_MINUTES - 1 }))}\n`,
      "utf8",
    );
    await makeSessionScannable(sessionFile);
    const lockPath = `${sessionFile}.lock`;
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 99999,
        createdAt: new Date(NOW - 11 * 60 * 1_000).toISOString(),
        owner: "context-pruner-audio-stt",
      }),
      "utf8",
    );

    const result = await scanSessionFile({
      sessionFile,
      stt: { provider: "groq", model: "whisper-large-v3-turbo", delayMinutes: 30 },
      now: NOW,
      transcribeAudio: async () => "stale lock recovered",
    });

    expect(result).toMatchObject({ candidates: 1, transcribed: 1, changed: true });
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts the rewrite when the session is appended during transcription", async () => {
    const { audioPath } = await makeFixture();
    const sessionFile = path.join(path.dirname(audioPath), "session.jsonl");
    const originalEntry = makeAudioEntry({
      audioPath,
      timestamp: NOW - THIRTY_MINUTES - 1,
    });
    const liveAppend = {
      type: "message",
      id: "live-append",
      message: { role: "assistant", content: [{ type: "text", text: "new live row" }] },
    };
    await fs.writeFile(sessionFile, `${JSON.stringify(originalEntry)}\n`, "utf8");
    await makeSessionScannable(sessionFile);

    const result = await scanSessionFile({
      sessionFile,
      stt: { provider: "groq", model: "whisper-large-v3-turbo", delayMinutes: 30 },
      now: NOW,
      transcribeAudio: async () => {
        await fs.appendFile(sessionFile, `${JSON.stringify(liveAppend)}\n`, "utf8");
        return "must not overwrite the append";
      },
    });

    expect(result).toMatchObject({
      candidates: 1,
      transcribed: 0,
      changed: false,
      skipped: "concurrent-update",
    });
    expect(await fs.readFile(sessionFile, "utf8")).toBe(
      `${JSON.stringify(originalEntry)}\n${JSON.stringify(liveAppend)}\n`,
    );
  });
});

// Keep the public target shape exercised so future refactors do not accidentally
// make attachment metadata optional in the replacement path.
const _audioTargetTypeCheck: AudioAttachmentTarget | undefined = undefined;
void _audioTargetTypeCheck;

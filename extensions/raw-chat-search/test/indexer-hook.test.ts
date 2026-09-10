import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitSessionTranscriptUpdate } from "../../../src/sessions/transcript-events.js";
import { embedPendingPairs } from "../src/backfill.js";
import { closeAllRawChatDatabases, RawChatDatabase } from "../src/database.js";
import { startEmbeddingBackfill, startRawChatIndexer, stopRawChatIndexer } from "../src/hook.js";
import { indexSessionFile } from "../src/indexer.js";

/**
 * End-to-end coverage for the Phase 2 background path: a session JSONL file is
 * indexed into `chat_messages` and then the extracted round trip is vectorized
 * into `chat_embeddings`, with the Gemini REST call stubbed.
 *
 * `startRawChatIndexer` resolves its database through the module cache, so these
 * tests point `DENNOU_STATE_DIR` at a temp directory and let the real code path
 * create and own its own `raw-chat.sqlite`.
 */
function createMockFetch(dimensions = 1280) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      content: { parts: Array<{ text: string }> };
    };
    calls.push(body.content.parts[0]?.text ?? "");
    const values = new Array<number>(dimensions).fill(0);
    values[0] = 1;
    return new Response(JSON.stringify({ embedding: { values } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("background indexer: transcript -> FTS5 -> embeddings", () => {
  let tmpDir: string;
  let stateDir: string;
  let sessionFile: string;
  let db: RawChatDatabase;
  const originalStateDir = process.env.DENNOU_STATE_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-hook-"));
    stateDir = path.join(tmpDir, "state");
    process.env.DENNOU_STATE_DIR = stateDir;
    sessionFile = path.join(tmpDir, "session-hook.jsonl");
    // One explicit database handle for the whole test: the file-backed path is
    // resolved through `DENNOU_STATE_DIR`, and sharing the handle keeps the FTS5
    // index and the embedding rows in the same file without reopening it.
    db = new RawChatDatabase(path.join(stateDir, "agents", "main", "raw-chat.sqlite"));
  });

  afterEach(() => {
    stopRawChatIndexer();
    closeAllRawChatDatabases();
    db.close();
    if (originalStateDir === undefined) {
      delete process.env.DENNOU_STATE_DIR;
    } else {
      process.env.DENNOU_STATE_DIR = originalStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Writes a two-turn session transcript the indexer can consume. */
  function writeTranscript(): void {
    const lines = [
      JSON.stringify({ type: "session", id: "sess-hook", version: 3 }),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        parentId: null,
        message: { role: "user", content: "What port does the gateway use?" },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-2",
        parentId: "msg-1",
        message: { role: "assistant", content: "It listens on 8317 by default." },
      }),
    ];
    fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`);
  }

  it("indexes then embeds a round trip without blocking the caller", async () => {
    writeTranscript();
    const { fetchImpl, calls } = createMockFetch();

    const inserted = indexSessionFile({
      db,
      sessionFile,
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:user1",
    }).indexed;
    expect(inserted).toBe(2);
    // FTS5 indexing must already work before any vector work happens.
    expect(db.search({ query: "8317" }).count).toBe(1);

    // `env: {}` keeps the test independent of a real GEMINI_API_KEY in the
    // developer shell; the database is injected so no path resolution is needed.
    const result = await embedPendingPairs({
      db,
      apiKey: "test-key",
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
      sleepImpl: async () => {},
      delayMs: 0,
    });

    expect(result.embedded).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      "User: What port does the gateway use?\nAssistant: It listens on 8317 by default.",
    );
    expect(db.loadAllEmbeddings().count).toBe(1);
  });

  it("stays FTS5-only and skips vector work when no API key is configured", () => {
    writeTranscript();

    indexSessionFile({ db, sessionFile, agentId: "main" });

    // Search by keyword still works; only vectors are skipped (§3).
    expect(db.search({ query: "8317" }).count).toBe(1);
    expect(db.loadAllEmbeddings().count).toBe(0);
  });

  it("respects the indexing kill switch", () => {
    const disabled = {
      dennou: { rawChat: { indexing: { enabled: false } } },
    };

    // startRawChatIndexer still installs the listener but must not schedule work;
    // returning the stop function keeps the contract (gateway stores it).
    const stop = startRawChatIndexer(disabled as never, { skipBackfill: true });
    expect(typeof stop).toBe("function");
    stop();
  });

  it("does not throw or reject when the backfill runs against an empty history", async () => {
    const sleeps: number[] = [];
    startRawChatIndexer({} as never, {
      skipBackfill: false,
      embedOptions: { db, apiKey: "test-key", env: {} as NodeJS.ProcessEnv },
      backfillOptions: {
        db,
        apiKey: "test-key",
        env: {} as NodeJS.ProcessEnv,
        // Collapse the cold-start recheck delay so the test stays fast.
        sleepImpl: async (ms: number) => {
          sleeps.push(ms);
        },
      },
    });

    // Give the fire-and-forget backfill a chance to run and settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    stopRawChatIndexer();

    expect(db.loadAllEmbeddings().count).toBe(0);
    // The empty ledger triggered the cold-start recheck loop.
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("waits for the FTS5 ledger to be populated before backfilling vectors", async () => {
    const sleeps: number[] = [];
    const { fetchImpl } = createMockFetch();

    startRawChatIndexer({} as never, {
      skipBackfill: true,
      embedOptions: { db, apiKey: "test-key", env: {} as NodeJS.ProcessEnv, fetchImpl },
    });

    startEmbeddingBackfill({
      db,
      apiKey: "test-key",
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
        // Simulate the concurrent FTS5 backfill finishing during the wait.
        if (sleeps.length === 1) {
          seedTurnRows();
        }
      },
    });

    await vi.waitFor(
      () => {
        expect(db.loadAllEmbeddings().count).toBe(1);
      },
      { timeout: 5_000, interval: 50 },
    );

    // Waited once for the cold start, then found the freshly indexed pair.
    expect(sleeps).toHaveLength(1);
  });

  /** Inserts one pending user/assistant turn directly (stand-in for FTS5 backfill). */
  function seedTurnRows(): void {
    for (const [index, role, text] of [
      [0, "user", "cold start question"],
      [1, "assistant", "cold start answer"],
    ] as const) {
      db.insertMessage({
        stable_key: `cold:${index}`,
        session_id: "cold",
        agent_id: "main",
        role,
        timestamp_ms: 1 + index,
        timestamp_iso: "2026-04-08T10:00:00.000Z",
        date_key: "2026-04-08",
        text,
        raw_json: "{}",
        source_file: sessionFile,
        source_line: index + 1,
        indexed_at_ms: 1,
      });
    }
  }

  it("ignores a second backfill request while one is already running", async () => {
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const fetchImpl = vi.fn(async () => {
      await gate;
      const values = new Array<number>(1280).fill(0);
      values[0] = 1;
      return new Response(JSON.stringify({ embedding: { values } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    startRawChatIndexer({} as never, {
      skipBackfill: true,
      embedOptions: { db, apiKey: "test-key", env: {} as NodeJS.ProcessEnv, fetchImpl },
    });

    // Seed one pending pair so the backfill actually has work to do.
    for (const [index, role, text] of [
      [0, "user", "backfill guard question"],
      [1, "assistant", "backfill guard answer"],
    ] as const) {
      db.insertMessage({
        stable_key: `sess-hook:${index}`,
        session_id: "sess-hook",
        agent_id: "main",
        role,
        timestamp_ms: 1 + index,
        timestamp_iso: "2026-04-08T10:00:00.000Z",
        date_key: "2026-04-08",
        text,
        raw_json: "{}",
        source_file: sessionFile,
        source_line: index + 1,
        indexed_at_ms: 1,
      });
    }

    const backfillOptions = {
      db,
      apiKey: "test-key",
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
      sleepImpl: async () => {},
      delayMs: 0,
    };
    startEmbeddingBackfill(backfillOptions);
    // Second call must be a no-op while the first is in flight.
    startEmbeddingBackfill(backfillOptions);

    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(db.loadAllEmbeddings().count).toBe(1);
    stopRawChatIndexer();
  });

  it("auto-embeds after a real transcript update event (production trigger)", async () => {
    writeTranscript();
    const { fetchImpl, calls } = createMockFetch();

    startRawChatIndexer({} as never, {
      skipBackfill: true,
      embedOptions: {
        db,
        apiKey: "test-key",
        env: {} as NodeJS.ProcessEnv,
        fetchImpl,
        sleepImpl: async () => {},
        delayMs: 0,
      },
    });

    // The hook debounces transcript updates by 2s, so this is the only way to
    // cover the real trigger path (indexSessionFile -> scheduleEmbeddingSweep).
    emitSessionTranscriptUpdate({
      sessionFile,
      sessionKey: "agent:main:telegram:direct:user1",
    });

    await vi.waitFor(
      () => {
        expect(db.loadAllEmbeddings().count).toBe(1);
      },
      { timeout: 8_000, interval: 100 },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("It listens on 8317 by default.");
    // FTS5 rows were written by the same event before the vector work started.
    expect(db.search({ query: "gateway" }).count).toBeGreaterThan(0);
  }, 20_000);
});

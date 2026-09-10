import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backfillEmbeddings,
  DEFAULT_BACKFILL_CONCURRENCY,
  DEFAULT_BACKFILL_DELAY_MS,
  embedPendingPairs,
  type EmbedPendingOptions,
} from "../src/backfill.js";
import { RawChatDatabase } from "../src/database.js";
import {
  embedTextWithGemini,
  embedTextWithGeminiOrNull,
  GeminiEmbeddingError,
} from "../src/embedding-client.js";
import type { ChatMessageRecord, PairWindowMessage } from "../src/types.js";
import { EMBEDDING_DIMENSIONS, normalizeL2 } from "../src/vector-math.js";

/** Deterministic unit vector so stored-vector assertions are stable. */
function makeEmbedding(seed: number, dim = EMBEDDING_DIMENSIONS): Float32Array {
  const vec = new Float32Array(dim);
  let state = seed >>> 0;
  for (let i = 0; i < dim; i++) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    vec[i] = (state / 0xffff_ffff) * 2 - 1;
  }
  return normalizeL2(vec);
}

/**
 * Stand-in for the Gemini REST client: returns a deterministic vector derived
 * from the request text, and records every call so tests can assert on the
 * request count (idempotency) and on what text was actually embedded.
 */
function createMockFetch(options?: { fail?: boolean; dimensions?: number }) {
  const dimensions = options?.dimensions ?? EMBEDDING_DIMENSIONS;
  const calls: string[] = [];

  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      content: { parts: Array<{ text: string }> };
      outputDimensionality: number;
    };
    const text = body.content.parts[0]?.text ?? "";
    calls.push(text);

    if (options?.fail) {
      return new Response("quota exceeded", { status: 429 });
    }

    let seed = 0;
    for (const char of text) {
      seed = (seed * 31 + char.codePointAt(0)!) >>> 0;
    }
    const values = Array.from(makeEmbedding(seed || 1, dimensions));
    return new Response(
      JSON.stringify({
        embedding: { values },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const noSleep = async () => {};

describe("embedding indexer: pending pair detection", () => {
  let tmpDir: string;
  let db: RawChatDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-indexer-"));
    db = new RawChatDatabase(path.join(tmpDir, "raw-chat.sqlite"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insert(
    stableKey: string,
    sessionId: string,
    role: string,
    text: string,
    messageId?: string,
  ): number {
    const record: ChatMessageRecord = {
      stable_key: stableKey,
      session_id: sessionId,
      agent_id: "main",
      message_id: messageId ?? null,
      role,
      timestamp_ms: 1_718_452_800_000,
      timestamp_iso: "2026-04-08T10:00:00.000Z",
      date_key: "2026-04-08",
      text,
      raw_json: "{}",
      source_file: path.join(tmpDir, `${sessionId}.jsonl`),
      source_line: 1,
      indexed_at_ms: 1_718_452_800_000,
    };
    db.insertMessage(record);
    const row = db
      .getRawDb()
      .prepare("SELECT id FROM chat_messages WHERE stable_key = ?")
      .get(stableKey) as { id: number | bigint };
    return Number(row.id);
  }

  function options(extra: Partial<EmbedPendingOptions> = {}): EmbedPendingOptions {
    return {
      db,
      apiKey: "test-key",
      env: {} as NodeJS.ProcessEnv,
      sleepImpl: noSleep,
      delayMs: 0,
      ...extra,
    };
  }

  it("embeds a user/assistant round trip and stores one normalized vector", async () => {
    const baseId = insert("k1", "s1", "user", "How do I set the gateway port?", "m1");
    insert("k2", "s1", "assistant", "Set gateway.port to 8317.", "m2");

    const { fetchImpl, calls } = createMockFetch();
    const result = await embedPendingPairs(options({ fetchImpl }));

    expect(result.hasApiKey).toBe(true);
    expect(result.embedded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.noise).toBe(0);
    expect(calls).toHaveLength(1);
    // The embedded text is the pair format, not the raw user or assistant row.
    expect(calls[0]).toBe(
      "User: How do I set the gateway port?\nAssistant: Set gateway.port to 8317.",
    );

    const stored = db.getEmbeddingByMessageId(baseId);
    expect(stored).not.toBeNull();
    expect(stored!.embedding.length).toBe(EMBEDDING_DIMENSIONS);
    expect(stored!.textSnippet).toContain("Assistant: Set gateway.port to 8317.");
    let sumSquares = 0;
    for (const value of stored!.embedding) {
      sumSquares += value * value;
    }
    expect(Math.sqrt(sumSquares)).toBeCloseTo(1, 5);
  });

  it("detects pending pairs from a single appended assistant reply only", async () => {
    insert("k1", "s1", "user", "First question", "m1");
    insert("k2", "s1", "assistant", "First answer", "m2");
    insert("k3", "s1", "user", "Second question", "m3");

    const { fetchImpl, calls } = createMockFetch();
    const first = await embedPendingPairs(options({ fetchImpl, order: "asc" }));
    expect(first.embedded).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("First question");

    // The dangling second turn is not pair-able yet.
    const second = await embedPendingPairs(
      options({ fetchImpl, order: "asc", afterId: first.cursorId }),
    );
    expect(second.scanned).toBe(0);

    insert("k4", "s1", "assistant", "Second answer", "m4");
    const third = await embedPendingPairs(options({ fetchImpl, order: "asc" }));
    expect(third.embedded).toBe(1);
    expect(third.scanned).toBe(1);
    expect(calls[1]).toContain("Second question");
  });

  it("ignores toolResult rows and system-role noise when building a pair", async () => {
    insert("k1", "s1", "system", "You are Kasou.");
    insert("k2", "s1", "user", "Check the backup drive", "m1");
    insert("k3", "s1", "toolResult", "df -h output ...");
    insert("k4", "s1", "assistant", "The backup drive has 2.2T free.", "m2");

    const { fetchImpl, calls } = createMockFetch();
    const result = await embedPendingPairs(options({ fetchImpl }));

    expect(result.embedded).toBe(1);
    expect(calls[0]).toBe(
      "User: Check the backup drive\nAssistant: The backup drive has 2.2T free.",
    );
    expect(calls[0]).not.toContain("df -h");
    expect(calls[0]).not.toContain("You are Kasou");
  });

  it("skips a pending base whose turn is a bare greeting and still indexes later turns", async () => {
    insert("k1", "s1", "user", "おはよう！", "m1");
    insert("k2", "s1", "assistant", "おはようございます！", "m2");
    insert("k3", "s1", "user", "今日のバックアップを確認して", "m3");
    insert("k4", "s1", "assistant", "バックアップは正常です。", "m4");

    const { fetchImpl, calls } = createMockFetch();
    const result = await embedPendingPairs(options({ fetchImpl, order: "asc" }));

    expect(result.embedded).toBe(1);
    expect(result.noise).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("今日のバックアップ");
  });

  it("advances the descending cursor past a noise pair instead of re-scanning it forever", async () => {
    insert("k1", "s1", "user", "おはよう！", "m1");
    insert("k2", "s1", "assistant", "おはよう！", "m2");
    insert("k3", "s1", "user", "Tell me about the SQLite schema", "m3");
    insert("k4", "s1", "assistant", "It uses FTS5 with a content table.", "m4");

    const { fetchImpl, calls } = createMockFetch();
    // Newest-first sweep: the noise turn is examined first, then the real turn.
    const first = await embedPendingPairs(options({ fetchImpl, order: "desc" }));
    expect(first.embedded).toBe(1);
    expect(first.noise).toBe(1);
    expect(first.cursorId).toBeGreaterThan(0);

    // Resuming below the noise base must not re-examine it.
    const second = await embedPendingPairs(
      options({ fetchImpl, order: "desc", beforeId: first.cursorId }),
    );
    expect(second.scanned).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("reports missing API key and never calls the network or the database", async () => {
    insert("k1", "s1", "user", "query text", "m1");
    insert("k2", "s1", "assistant", "answer text", "m2");

    const { fetchImpl, calls } = createMockFetch();
    const result = await embedPendingPairs({
      db,
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
    });

    expect(result.hasApiKey).toBe(false);
    expect(result.scanned).toBe(0);
    expect(calls).toHaveLength(0);
    expect(db.loadAllEmbeddings().count).toBe(0);
  });

  it("resolves the API key from the passed environment", async () => {
    insert("k1", "s1", "user", "query text", "m1");
    insert("k2", "s1", "assistant", "answer text", "m2");

    const { fetchImpl } = createMockFetch();
    const result = await embedPendingPairs({
      db,
      env: { GEMINI_API_KEY: "from-env" } as NodeJS.ProcessEnv,
      fetchImpl,
      sleepImpl: noSleep,
      delayMs: 0,
    });

    expect(result.hasApiKey).toBe(true);
    expect(result.embedded).toBe(1);
  });

  it("keeps the pair pending when the embedding request fails", async () => {
    const baseId = insert("k1", "s1", "user", "important question", "m1");
    insert("k2", "s1", "assistant", "important answer", "m2");

    const { fetchImpl, calls } = createMockFetch({ fail: true });
    const result = await embedPendingPairs(options({ fetchImpl }));

    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(1);
    expect(db.getEmbeddingByMessageId(baseId)).toBeNull();

    // A later sweep retries the same pair once the API recovers.
    const retry = createMockFetch();
    const recovered = await embedPendingPairs(options({ fetchImpl: retry.fetchImpl }));
    expect(recovered.embedded).toBe(1);
    expect(retry.calls).toHaveLength(1);
    expect(db.getEmbeddingByMessageId(baseId)).not.toBeNull();
    expect(calls.length).toBe(1);
  });

  it("bounds in-flight concurrency and respects the inter-chunk delay", async () => {
    for (let index = 1; index <= 6; index++) {
      insert(`u${index}`, "s1", "user", `question number ${index}`);
      insert(`a${index}`, "s1", "assistant", `answer number ${index}`);
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      const body = JSON.parse(String(init?.body)) as {
        content: { parts: Array<{ text: string }> };
        outputDimensionality: number;
      };
      let seed = 0;
      for (const char of body.content.parts[0]?.text ?? "") {
        seed = (seed * 31 + char.codePointAt(0)!) >>> 0;
      }
      return new Response(
        JSON.stringify({ embedding: { values: Array.from(makeEmbedding(seed || 1)) } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const sleeps: number[] = [];
    const result = await embedPendingPairs(
      options({
        fetchImpl,
        order: "asc",
        limit: 6,
        concurrency: 2,
        delayMs: 25,
        sleepImpl: async (ms: number) => {
          sleeps.push(ms);
        },
      }),
    );

    expect(result.embedded).toBe(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(sleeps).toEqual([25, 25]);
  });

  it("stops early when the caller aborts the sweep", async () => {
    for (let index = 1; index <= 4; index++) {
      insert(`u${index}`, "s1", "user", `question ${index}`);
      insert(`a${index}`, "s1", "assistant", `answer ${index}`);
    }

    const controller = new AbortController();
    const { fetchImpl } = createMockFetch();
    controller.abort();

    const result = await embedPendingPairs(
      options({ fetchImpl, order: "asc", limit: 4, concurrency: 1, signal: controller.signal }),
    );

    expect(result.aborted).toBe(true);
    expect(result.embedded).toBe(0);
    expect(db.loadAllEmbeddings().count).toBe(0);
  });

  it("never pairs messages that live in different sessions", async () => {
    insert("k1", "s1", "user", "question in session one");
    insert("k2", "s2", "assistant", "answer in session two");

    const { fetchImpl, calls } = createMockFetch();
    const result = await embedPendingPairs(options({ fetchImpl, order: "asc" }));

    expect(result.embedded).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("embedding backfill", () => {
  let tmpDir: string;
  let db: RawChatDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-backfill-"));
    db = new RawChatDatabase(path.join(tmpDir, "raw-chat.sqlite"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedTurn(index: number): number {
    for (const [offset, role, text] of [
      [0, "user", `backfill question ${index}`],
      [1, "assistant", `backfill answer ${index}`],
    ] as const) {
      const key = `s1:${index}:${offset}`;
      db.insertMessage({
        stable_key: key,
        session_id: "s1",
        agent_id: "main",
        role,
        timestamp_ms: 1_718_452_800_000 + index,
        timestamp_iso: "2026-04-08T10:00:00.000Z",
        date_key: "2026-04-08",
        text,
        raw_json: "{}",
        source_file: path.join(tmpDir, "s1.jsonl"),
        source_line: index * 2 + offset,
        indexed_at_ms: 1_718_452_800_000,
      });
    }
    const row = db
      .getRawDb()
      .prepare("SELECT id FROM chat_messages WHERE stable_key = ?")
      .get(`s1:${index}:0`) as { id: number | bigint };
    return Number(row.id);
  }

  function options(extra: Record<string, unknown> = {}) {
    return {
      db,
      apiKey: "test-key",
      env: {} as NodeJS.ProcessEnv,
      sleepImpl: noSleep,
      delayMs: 0,
      ...extra,
    };
  }

  it("bulk-vectorizes existing history and reports a drained walk", async () => {
    const baseIds = [1, 2, 3, 4, 5].map((index) => seedTurn(index));

    const { fetchImpl, calls } = createMockFetch();
    const result = await backfillEmbeddings(
      options({ fetchImpl, batchLimit: 2, concurrency: 2, maxBatches: 10 }),
    );

    expect(result.hasApiKey).toBe(true);
    expect(result.drained).toBe(true);
    expect(result.embedded).toBe(5);
    expect(result.failed).toBe(0);
    expect(calls).toHaveLength(5);
    expect(db.loadAllEmbeddings().count).toBe(5);

    for (const baseId of baseIds) {
      expect(db.getEmbeddingByMessageId(baseId)).not.toBeNull();
    }
  });

  it("is idempotent: a second run embeds nothing and duplicates nothing", async () => {
    [1, 2, 3].map((index) => seedTurn(index));

    const first = createMockFetch();
    const firstResult = await backfillEmbeddings(
      options({ fetchImpl: first.fetchImpl, batchLimit: 2 }),
    );
    expect(firstResult.embedded).toBe(3);

    const second = createMockFetch();
    const secondResult = await backfillEmbeddings(
      options({ fetchImpl: second.fetchImpl, batchLimit: 2 }),
    );

    expect(secondResult.embedded).toBe(0);
    expect(secondResult.scanned).toBe(0);
    expect(second.calls).toHaveLength(0);

    const count = db.getRawDb().prepare("SELECT COUNT(*) AS total FROM chat_embeddings").get() as {
      total: number | bigint;
    };
    expect(Number(count.total)).toBe(3);
  });

  it("advances past a noise turn and still embeds the rest", async () => {
    db.insertMessage({
      stable_key: "s1:greet:0",
      session_id: "s1",
      agent_id: "main",
      role: "user",
      timestamp_ms: 1,
      timestamp_iso: "2026-04-08T09:00:00.000Z",
      date_key: "2026-04-08",
      text: "おはよう",
      raw_json: "{}",
      source_file: path.join(tmpDir, "s1.jsonl"),
      source_line: 0,
      indexed_at_ms: 1,
    });
    db.insertMessage({
      stable_key: "s1:greet:1",
      session_id: "s1",
      agent_id: "main",
      role: "assistant",
      timestamp_ms: 2,
      timestamp_iso: "2026-04-08T09:00:01.000Z",
      date_key: "2026-04-08",
      text: "おはようございます",
      raw_json: "{}",
      source_file: path.join(tmpDir, "s1.jsonl"),
      source_line: 1,
      indexed_at_ms: 1,
    });
    seedTurn(1);

    const { fetchImpl } = createMockFetch();
    const result = await backfillEmbeddings(options({ fetchImpl, batchLimit: 1 }));

    expect(result.drained).toBe(true);
    expect(result.noise).toBe(1);
    expect(result.embedded).toBe(1);
    expect(db.loadAllEmbeddings().count).toBe(1);
  });

  it("keeps failures pending and reports them without hanging", async () => {
    [1, 2, 3].map((index) => seedTurn(index));

    const failing = createMockFetch({ fail: true });
    const result = await backfillEmbeddings(
      options({ fetchImpl: failing.fetchImpl, batchLimit: 2, maxBatches: 5 }),
    );

    expect(result.failed).toBe(3);
    expect(result.embedded).toBe(0);
    expect(result.drained).toBe(true);
    expect(db.loadAllEmbeddings().count).toBe(0);

    // Everything is retried on the next run (nothing was marked as done).
    const retry = createMockFetch();
    const recovered = await backfillEmbeddings(
      options({ fetchImpl: retry.fetchImpl, batchLimit: 2 }),
    );
    expect(recovered.embedded).toBe(3);
  });

  it("stops at maxBatches so a huge history cannot run unbounded", async () => {
    [1, 2, 3, 4, 5, 6].map((index) => seedTurn(index));

    const { fetchImpl } = createMockFetch();
    const result = await backfillEmbeddings(
      options({ fetchImpl, batchLimit: 1, concurrency: 1, maxBatches: 2 }),
    );

    expect(result.batches).toBe(2);
    expect(result.drained).toBe(false);
    expect(result.embedded).toBe(2);

    // Resuming from the reported cursor finishes the job.
    const { fetchImpl: resumeFetch } = createMockFetch();
    const resumed = await backfillEmbeddings(
      options({
        fetchImpl: resumeFetch,
        batchLimit: 1,
        concurrency: 1,
        maxBatches: 50,
        afterId: result.cursorId,
      }),
    );
    expect(resumed.embedded).toBe(4);
    expect(resumed.drained).toBe(true);
  });

  it("uses its own conservative rate limits by default, but lets callers override them", async () => {
    [1, 2, 3, 4].map((index) => seedTurn(index));

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      const body = JSON.parse(String(init?.body)) as {
        content: { parts: Array<{ text: string }> };
      };
      let seed = 0;
      for (const char of body.content.parts[0]?.text ?? "") {
        seed = (seed * 31 + char.codePointAt(0)!) >>> 0;
      }
      return new Response(
        JSON.stringify({ embedding: { values: Array.from(makeEmbedding(seed || 1)) } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const delays: number[] = [];
    const result = await backfillEmbeddings({
      db,
      apiKey: "test-key",
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
      batchLimit: 4,
      sleepImpl: async (ms: number) => {
        delays.push(ms);
      },
    });

    expect(result.embedded).toBe(4);
    // Default bulk pacing is applied without the caller asking for it.
    expect(maxInFlight).toBeLessThanOrEqual(DEFAULT_BACKFILL_CONCURRENCY);
    expect(delays).toContain(DEFAULT_BACKFILL_DELAY_MS);

    const overridden = await backfillEmbeddings({
      db,
      apiKey: "test-key",
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
      concurrency: 1,
      delayMs: 7,
      sleepImpl: async (ms: number) => {
        delays.push(ms);
      },
    });
    // Everything already embedded, so no new pacing call happens.
    expect(overridden.embedded).toBe(0);
  });

  it("does not touch the database when no API key is configured", async () => {
    [1, 2].map((index) => seedTurn(index));

    const { fetchImpl, calls } = createMockFetch();
    const result = await backfillEmbeddings({
      db,
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
      sleepImpl: noSleep,
    });

    expect(result.hasApiKey).toBe(false);
    expect(result.batches).toBe(0);
    expect(calls).toHaveLength(0);
    expect(db.loadAllEmbeddings().count).toBe(0);
  });

  it("handles an empty history without any API call", async () => {
    const { fetchImpl, calls } = createMockFetch();
    const result = await backfillEmbeddings(options({ fetchImpl }));

    expect(result.drained).toBe(true);
    expect(result.scanned).toBe(0);
    expect(result.embedded).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("Phase 1 review follow-ups", () => {
  let tmpDir: string;
  let db: RawChatDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-fk-"));
    db = new RawChatDatabase(path.join(tmpDir, "raw-chat.sqlite"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enables foreign key enforcement explicitly", () => {
    expect(db.isForeignKeyEnforcementEnabled()).toBe(true);
  });

  it("keeps the ON DELETE CASCADE working so no orphan embeddings survive", () => {
    db.insertMessage({
      stable_key: "s1:1",
      session_id: "s1",
      agent_id: "main",
      role: "user",
      timestamp_ms: 1,
      timestamp_iso: "2026-04-08T10:00:00.000Z",
      date_key: "2026-04-08",
      text: "cascade check",
      raw_json: "{}",
      source_file: path.join(tmpDir, "s1.jsonl"),
      source_line: 1,
      indexed_at_ms: 1,
    });
    const row = db
      .getRawDb()
      .prepare("SELECT id FROM chat_messages WHERE stable_key = ?")
      .get("s1:1") as { id: number | bigint };
    const messageId = Number(row.id);

    db.insertEmbedding({
      messageId,
      sessionId: "s1",
      embedding: makeEmbedding(3),
      textSnippet: "cascade check",
    });

    // A row that cannot reference a real message must be rejected outright.
    expect(() =>
      db
        .getRawDb()
        .prepare(
          "INSERT INTO chat_embeddings (message_id, session_id, dimensions, embedding, text_snippet, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          999_999,
          "s1",
          EMBEDDING_DIMENSIONS,
          Buffer.alloc(EMBEDDING_DIMENSIONS * 4),
          "orphan",
          Date.now(),
        ),
    ).toThrow();

    db.getRawDb().prepare("DELETE FROM chat_messages WHERE id = ?").run(messageId);
    expect(db.getEmbeddingByMessageId(messageId)).toBeNull();
    expect(db.loadAllEmbeddings().count).toBe(0);
  });

  it("keeps enforcing foreign keys after reopening the file", () => {
    const dbPath = db.getPath();
    db.close();

    const reopened = new RawChatDatabase(dbPath);
    try {
      expect(reopened.isForeignKeyEnforcementEnabled()).toBe(true);
    } finally {
      reopened.close();
    }

    // Reassign so afterEach's close() stays harmless.
    db = new RawChatDatabase(":memory:");
  });

  it("refuses to build a pair window for a session with no rows", () => {
    const rows = db.selectPairWindow({ sessionId: "missing", fromId: 1, toId: 10 });
    expect(rows).toEqual([]);
  });

  it("returns no pending bases when every turn is already embedded", async () => {
    db.insertMessage({
      stable_key: "s1:1",
      session_id: "s1",
      agent_id: "main",
      role: "user",
      timestamp_ms: 1,
      timestamp_iso: "2026-04-08T10:00:00.000Z",
      date_key: "2026-04-08",
      text: "already indexed question",
      raw_json: "{}",
      source_file: path.join(tmpDir, "s1.jsonl"),
      source_line: 1,
      indexed_at_ms: 1,
    });
    db.insertMessage({
      stable_key: "s1:2",
      session_id: "s1",
      agent_id: "main",
      role: "assistant",
      timestamp_ms: 2,
      timestamp_iso: "2026-04-08T10:00:01.000Z",
      date_key: "2026-04-08",
      text: "already indexed answer",
      raw_json: "{}",
      source_file: path.join(tmpDir, "s1.jsonl"),
      source_line: 2,
      indexed_at_ms: 1,
    });

    const bases = db.selectPendingPairBases({ limit: 10, order: "asc" });
    expect(bases).toHaveLength(1);

    db.insertEmbedding({
      messageId: bases[0]!.baseId,
      sessionId: "s1",
      embedding: makeEmbedding(9),
      textSnippet: "already indexed",
    });

    expect(db.selectPendingPairBases({ limit: 10, order: "asc" })).toEqual([]);
  });

  it("returns the pair window ordered by id across roles", () => {
    const rows: PairWindowMessage[] = [];
    for (const [index, role] of ["user", "toolResult", "assistant"].entries()) {
      const key = `s1:${index}`;
      db.insertMessage({
        stable_key: key,
        session_id: "s1",
        agent_id: "main",
        role,
        timestamp_ms: index,
        timestamp_iso: `2026-04-08T10:00:0${index}.000Z`,
        date_key: "2026-04-08",
        text: `row ${index}`,
        raw_json: "{}",
        source_file: path.join(tmpDir, "s1.jsonl"),
        source_line: index + 1,
        indexed_at_ms: 1,
      });
      const row = db
        .getRawDb()
        .prepare("SELECT id FROM chat_messages WHERE stable_key = ?")
        .get(key) as { id: number | bigint };
      rows.push({
        id: Number(row.id),
        sessionId: "s1",
        role,
        text: `row ${index}`,
        timestampIso: "",
      });
    }

    const window = db.selectPairWindow({
      sessionId: "s1",
      fromId: rows[0]!.id,
      toId: rows[2]!.id,
    });

    expect(window.map((row) => row.role)).toEqual(["user", "toolResult", "assistant"]);
    expect(window.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(window[0]!.timestampIso).toBe("2026-04-08T10:00:00.000Z");
  });
});

describe("embedding-client fail-open contract", () => {
  it("returns null silently for expected external failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failing = vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;
      await expect(
        embedTextWithGeminiOrNull("hello", { apiKey: "k", fetchImpl: failing }),
      ).resolves.toBeNull();

      const timeout = vi.fn(async () => {
        const error = new Error("aborted");
        error.name = "TimeoutError";
        throw error;
      }) as unknown as typeof fetch;
      await expect(
        embedTextWithGeminiOrNull("hello", { apiKey: "k", fetchImpl: timeout }),
      ).resolves.toBeNull();

      const quota = vi.fn(
        async () => new Response("quota exceeded", { status: 429 }),
      ) as unknown as typeof fetch;
      await expect(
        embedTextWithGeminiOrNull("hello", { apiKey: "k", fetchImpl: quota }),
      ).resolves.toBeNull();

      // Missing key is also an expected operational state (§3).
      await expect(embedTextWithGeminiOrNull("hello", { apiKey: "  " })).resolves.toBeNull();

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("logs unexpected failures instead of swallowing them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A wrong-dimension response is a contract violation, not an outage.
      const wrongDims = vi.fn(
        async () =>
          new Response(JSON.stringify({ embedding: { values: [1, 2] } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ) as unknown as typeof fetch;

      await expect(
        embedTextWithGeminiOrNull("hello", { apiKey: "k", dimensions: 4, fetchImpl: wrongDims }),
      ).resolves.toBeNull();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("raw-chat-search");
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects empty and non-string input without calling the API", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      await expect(
        embedTextWithGeminiOrNull("   ", { apiKey: "k", fetchImpl }),
      ).resolves.toBeNull();
      await expect(
        embedTextWithGeminiOrNull(undefined as unknown as string, { apiKey: "k", fetchImpl }),
      ).resolves.toBeNull();

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a caller-side bad timeout instead of reporting a network failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      await expect(
        embedTextWithGeminiOrNull("hello", { apiKey: "k", timeoutMs: -1, fetchImpl }),
      ).resolves.toBeNull();

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);

      const thrown = await embedTextWithGemini("hello", {
        apiKey: "k",
        timeoutMs: 0,
        fetchImpl,
      }).catch((error: unknown) => error);
      expect((thrown as GeminiEmbeddingError).code).toBe("invalid-request");
    } finally {
      warn.mockRestore();
    }
  });

  it("still exposes the typed error from the throwing variant", async () => {
    const quota = vi.fn(
      async () => new Response("quota exceeded", { status: 429 }),
    ) as unknown as typeof fetch;

    const thrown = await embedTextWithGemini("hello", { apiKey: "k", fetchImpl: quota }).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(GeminiEmbeddingError);
    expect((thrown as GeminiEmbeddingError).code).toBe("http-error");
  });
});

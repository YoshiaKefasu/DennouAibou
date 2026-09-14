import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RawChatDatabase } from "../src/database.js";
import {
  blobToEmbedding,
  embedTextWithGemini,
  embedTextWithGeminiOrNull,
  embeddingToBlob,
  GEMINI_EMBEDDING_ENDPOINT,
  GEMINI_EMBEDDING_TIMEOUT_MS,
  GeminiEmbeddingError,
  resolveGeminiApiKey,
} from "../src/embedding-client.js";
import type { ChatMessageRecord } from "../src/types.js";
import { cosineSimilarity, EMBEDDING_DIMENSIONS, normalizeL2 } from "../src/vector-math.js";

function message(stableKey: string, text: string): ChatMessageRecord {
  return {
    stable_key: stableKey,
    session_id: "sess-1",
    agent_id: "main",
    role: "user",
    timestamp_ms: 1_718_452_800_000,
    timestamp_iso: "2024-06-15T12:00:00.000Z",
    date_key: "2024-06-15",
    text,
    raw_json: "{}",
    source_file: "/tmp/sess-1.jsonl",
    source_line: 1,
    indexed_at_ms: 1_718_452_800_000,
  };
}

function makeEmbedding(seed: number, dim = EMBEDDING_DIMENSIONS): Float32Array {
  const vec = new Float32Array(dim);
  let state = seed >>> 0;
  for (let i = 0; i < dim; i++) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    vec[i] = (state / 0xffff_ffff) * 2 - 1;
  }
  return normalizeL2(vec);
}

describe("chat_embeddings schema", () => {
  let tmpDir: string;
  let db: RawChatDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-embed-"));
    db = new RawChatDatabase(path.join(tmpDir, "raw-chat.sqlite"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertMessageRow(text: string): number {
    db.insertMessage(message(`sess-1:${text}`, text));
    const row = db
      .getRawDb()
      .prepare("SELECT id FROM chat_messages WHERE stable_key = ?")
      .get(`sess-1:${text}`) as { id: number | bigint };
    return Number(row.id);
  }

  it("creates the table and its session index", () => {
    const table = db
      .getRawDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("chat_embeddings");
    expect(table).toBeDefined();

    const index = db
      .getRawDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_chat_embeddings_session");
    expect(index).toBeDefined();
  });

  it("normalizes the vector on write so stored rows are unit vectors", () => {
    const messageId = insertMessageRow("needs normalization");
    db.insertEmbedding({
      messageId,
      sessionId: "sess-1",
      embedding: new Float32Array([3, 4, ...new Array(1278).fill(0)]),
      textSnippet: "needs normalization",
    });

    const record = db.getEmbeddingByMessageId(messageId);
    expect(record?.embedding[0]).toBeCloseTo(0.6, 6);
    expect(record?.embedding[1]).toBeCloseTo(0.8, 6);
    let sumSquares = 0;
    for (const value of record!.embedding) {
      sumSquares += value * value;
    }
    expect(Math.sqrt(sumSquares)).toBeCloseTo(1, 5);
  });

  it("inserts and reads back an embedding by message id", () => {
    const messageId = insertMessageRow("hello world");
    const embedding = makeEmbedding(1);

    db.insertEmbedding({
      messageId,
      sessionId: "sess-1",
      embedding,
      textSnippet: "hello world",
    });

    const record = db.getEmbeddingByMessageId(messageId);
    expect(record).not.toBeNull();
    expect(record?.messageId).toBe(messageId);
    expect(record?.textSnippet).toBe("hello world");
    expect(record?.embedding.length).toBe(EMBEDDING_DIMENSIONS);
    expect(cosineSimilarity(embedding, record!.embedding)).toBeCloseTo(1, 5);
  });

  it("returns null for a message without an embedding", () => {
    const messageId = insertMessageRow("no vector yet");
    expect(db.getEmbeddingByMessageId(messageId)).toBeNull();
  });

  it("upserts instead of duplicating on message_id conflict", () => {
    const messageId = insertMessageRow("upsert me");
    db.insertEmbedding({
      messageId,
      sessionId: "sess-1",
      embedding: makeEmbedding(1),
      textSnippet: "first",
    });
    db.insertEmbedding({
      messageId,
      sessionId: "sess-1",
      embedding: makeEmbedding(2),
      textSnippet: "second",
    });

    const count = db.getRawDb().prepare("SELECT COUNT(*) AS total FROM chat_embeddings").get() as {
      total: number | bigint;
    };
    expect(Number(count.total)).toBe(1);
    expect(db.getEmbeddingByMessageId(messageId)?.textSnippet).toBe("second");
  });

  it("rejects an embedding whose length does not match dimensions", () => {
    const messageId = insertMessageRow("bad dims");
    expect(() =>
      db.insertEmbedding({
        messageId,
        sessionId: "sess-1",
        dimensions: 1280,
        embedding: new Float32Array(16),
        textSnippet: "bad dims",
      }),
    ).toThrow(/does not match dimensions/);
  });

  it("loads all embeddings as one flat Float32Array", () => {
    const firstId = insertMessageRow("first");
    const secondId = insertMessageRow("second");
    const first = makeEmbedding(11);
    const second = makeEmbedding(22);

    db.insertEmbedding({
      messageId: firstId,
      sessionId: "sess-1",
      embedding: first,
      textSnippet: "first",
    });
    db.insertEmbedding({
      messageId: secondId,
      sessionId: "sess-1",
      embedding: second,
      textSnippet: "second",
    });

    const loaded = db.loadAllEmbeddings();
    expect(loaded.count).toBe(2);
    expect(loaded.dim).toBe(EMBEDDING_DIMENSIONS);
    expect(loaded.vectors.length).toBe(2 * EMBEDDING_DIMENSIONS);
    expect(loaded.messageIds).toEqual([firstId, secondId]);

    const row0 = loaded.vectors.subarray(0, EMBEDDING_DIMENSIONS);
    const row1 = loaded.vectors.subarray(EMBEDDING_DIMENSIONS, 2 * EMBEDDING_DIMENSIONS);
    expect(cosineSimilarity(row0, first)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(row1, second)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(row0, row1)).toBeLessThan(0.99);
  });

  it("filters loaded embeddings by session and returns empty for unknown sessions", () => {
    const firstId = insertMessageRow("a");
    const secondId = insertMessageRow("b");
    db.insertEmbedding({
      messageId: firstId,
      sessionId: "sess-1",
      embedding: makeEmbedding(1),
      textSnippet: "a",
    });
    db.insertEmbedding({
      messageId: secondId,
      sessionId: "sess-2",
      embedding: makeEmbedding(2),
      textSnippet: "b",
    });

    const sessionOne = db.loadAllEmbeddings("sess-1");
    expect(sessionOne.count).toBe(1);
    expect(sessionOne.messageIds).toEqual([firstId]);

    const missing = db.loadAllEmbeddings("sess-404");
    expect(missing.count).toBe(0);
    expect(missing.dim).toBe(0);
    expect(missing.vectors.length).toBe(0);
  });

  it("returns an empty load result when nothing is stored", () => {
    const loaded = db.loadAllEmbeddings();
    expect(loaded).toEqual({ messageIds: [], vectors: new Float32Array(0), count: 0, dim: 0 });
  });

  it("skips rows whose dimensions differ from the dominant dimension", () => {
    const alignedId = insertMessageRow("aligned");
    const oddId = insertMessageRow("odd");
    db.insertEmbedding({
      messageId: alignedId,
      sessionId: "sess-1",
      embedding: makeEmbedding(7),
      textSnippet: "aligned",
    });
    db.insertEmbedding({
      messageId: oddId,
      sessionId: "sess-1",
      dimensions: 8,
      embedding: makeEmbedding(8, 8),
      textSnippet: "odd",
    });

    const loaded = db.loadAllEmbeddings();
    expect(loaded.dim).toBe(EMBEDDING_DIMENSIONS);
    expect(loaded.count).toBe(1);
    expect(loaded.messageIds).toEqual([alignedId]);
  });

  it("lists messages that still need an embedding", () => {
    const firstId = insertMessageRow("indexed");
    const secondId = insertMessageRow("pending");
    db.insertEmbedding({
      messageId: firstId,
      sessionId: "sess-1",
      embedding: makeEmbedding(3),
      textSnippet: "indexed",
    });

    const rows = db
      .getRawDb()
      .prepare(
        `SELECT m.id FROM chat_messages m
         LEFT JOIN chat_embeddings e ON e.message_id = m.id
         WHERE e.id IS NULL ORDER BY m.id ASC`,
      )
      .all() as Array<{ id: number | bigint }>;
    expect(rows.map((row) => Number(row.id))).toEqual([secondId]);
  });

  it("cascades deletes from chat_messages to chat_embeddings", () => {
    const messageId = insertMessageRow("delete me");
    db.insertEmbedding({
      messageId,
      sessionId: "sess-1",
      embedding: makeEmbedding(4),
      textSnippet: "delete me",
    });
    expect(db.getEmbeddingByMessageId(messageId)).not.toBeNull();

    db.getRawDb().prepare("DELETE FROM chat_messages WHERE id = ?").run(messageId);

    expect(db.getEmbeddingByMessageId(messageId)).toBeNull();
    expect(db.loadAllEmbeddings().count).toBe(0);
  });

  it("persists embeddings across a file-backed reopen", () => {
    const persistedDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-embed-reopen-"));
    const dbPath = path.join(persistedDir, "raw-chat.sqlite");
    const fileDb = new RawChatDatabase(dbPath);
    try {
      fileDb.insertMessage(message("sess-1:persisted", "persisted"));
      const row = fileDb
        .getRawDb()
        .prepare("SELECT id FROM chat_messages WHERE stable_key = ?")
        .get("sess-1:persisted") as { id: number | bigint };
      fileDb.insertEmbedding({
        messageId: Number(row.id),
        sessionId: "sess-1",
        embedding: makeEmbedding(5),
        textSnippet: "persisted",
      });
    } finally {
      fileDb.close();
    }

    const reopened = new RawChatDatabase(dbPath);
    try {
      const loaded = reopened.loadAllEmbeddings();
      expect(loaded.count).toBe(1);
      expect(loaded.dim).toBe(EMBEDDING_DIMENSIONS);
    } finally {
      reopened.close();
      fs.rmSync(persistedDir, { recursive: true, force: true });
    }
  });
});

describe("Gemini Embedding 2 client", () => {
  const baseOptions = { apiKey: "test-key", dimensions: 4, timeoutMs: 400 };

  afterEach(() => {
    restoreTestEnvs();
  });

  it("resolves the API key from the argument first, then GEMINI_API_KEY", () => {
    setTestEnv("GEMINI_API_KEY", "env-key");
    expect(resolveGeminiApiKey("explicit-key")).toBe("explicit-key");
    expect(resolveGeminiApiKey()).toBe("env-key");
    expect(resolveGeminiApiKey("   ")).toBe("env-key");
  });

  it("returns undefined when no key is configured", () => {
    expect(resolveGeminiApiKey(undefined, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("matches the design-spec endpoint, timeout, and default dimensions", async () => {
    expect(GEMINI_EMBEDDING_ENDPOINT).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
    );
    expect(GEMINI_EMBEDDING_TIMEOUT_MS).toBe(400);

    const values = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    values[0] = 1;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { outputDimensionality: number };
      expect(body.outputDimensionality).toBe(EMBEDDING_DIMENSIONS);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ embedding: { values } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const embedding = await embedTextWithGemini("hello", { apiKey: "test-key", fetchImpl });
    expect(embedding.length).toBe(EMBEDDING_DIMENSIONS);
    expect(embedding[0]).toBeCloseTo(1, 6);
  });

  it("posts to the gemini-embedding-2 endpoint and normalizes the result", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        outputDimensionality: number;
      };
      expect(body.model).toBe("models/gemini-embedding-2");
      expect(body.outputDimensionality).toBe(4);

      return new Response(JSON.stringify({ embedding: { values: [3, 4, 0, 0] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const embedding = await embedTextWithGemini("hello", { ...baseOptions, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
    );
    expect(embedding.length).toBe(4);
    expect(embedding[0]).toBeCloseTo(0.6, 6);
    expect(embedding[1]).toBeCloseTo(0.8, 6);
  });

  it("throws a missing-api-key error when no key is available", async () => {
    setTestEnv("GEMINI_API_KEY", "");
    await expect(
      embedTextWithGemini("hello", { apiKey: "  ", fetchImpl: vi.fn() as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "missing-api-key" });
  });

  it("throws a timeout error when the request aborts", async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }) as unknown as typeof fetch;

    await expect(embedTextWithGemini("hello", { ...baseOptions, fetchImpl })).rejects.toMatchObject(
      {
        code: "timeout",
      },
    );
  });

  it("aborts a hanging request at the configured timeout", async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch;

    const startedAt = Date.now();
    const error = await embedTextWithGemini("hello", {
      apiKey: "test-key",
      dimensions: 4,
      timeoutMs: 50,
      fetchImpl,
    }).catch((err: unknown) => err);
    const elapsedMs = Date.now() - startedAt;

    expect(error).toBeInstanceOf(GeminiEmbeddingError);
    expect((error as GeminiEmbeddingError).code).toBe("timeout");
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("throws an http-error on a non-OK response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("quota exceeded", { status: 429 }),
    ) as unknown as typeof fetch;

    const error = await embedTextWithGemini("hello", { ...baseOptions, fetchImpl }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(GeminiEmbeddingError);
    expect((error as GeminiEmbeddingError).code).toBe("http-error");
    expect((error as GeminiEmbeddingError).message).toContain("429");
  });

  it("throws an invalid-response error when the vector length is wrong", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ embedding: { values: [1, 2] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(embedTextWithGemini("hello", { ...baseOptions, fetchImpl })).rejects.toMatchObject(
      {
        code: "invalid-response",
      },
    );
  });

  it("returns null instead of throwing in the fail-open variant", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(
      embedTextWithGeminiOrNull("hello", { ...baseOptions, fetchImpl }),
    ).resolves.toBeNull();
  });

  it("round-trips an embedding through the BLOB helpers", () => {
    const embedding = makeEmbedding(77);
    const blob = embeddingToBlob(embedding);
    expect(blob.byteLength).toBe(EMBEDDING_DIMENSIONS * 4);
    expect(cosineSimilarity(embedding, blobToEmbedding(blob, EMBEDDING_DIMENSIONS))).toBeCloseTo(
      1,
      5,
    );
  });
});

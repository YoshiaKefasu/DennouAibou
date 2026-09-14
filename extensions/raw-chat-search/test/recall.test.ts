import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rawChatSearchPlugin from "../index.js";
import {
  closeAllRawChatDatabases,
  getRawChatDatabase,
  type RawChatDatabase,
} from "../src/database.js";
import {
  DEFAULT_CONTEXT_WINDOW_ROUNDS,
  DEFAULT_RECALL_TIMEOUT_MS,
  HIGH_RELEVANCE_THRESHOLD,
  MEDIUM_RELEVANCE_THRESHOLD,
  performVectorRecall,
} from "../src/recall.js";
import type { ChatMessageRecord } from "../src/types.js";
import { EMBEDDING_DIMENSIONS, normalizeL2 } from "../src/vector-math.js";

const SESSION_ID = "recall-session";

type FetchStub = typeof fetch;

type HookHandler = (
  event: { prompt: string; messages: unknown[] },
  ctx: {
    agentId?: string;
    sessionId?: string;
  },
) => Promise<unknown>;

function createEmbeddingResponse(values: ArrayLike<number>): Response {
  return new Response(JSON.stringify({ embedding: { values: Array.from(values) } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createFetchStub(values: ArrayLike<number>): FetchStub {
  return vi.fn(async () => createEmbeddingResponse(values)) as unknown as FetchStub;
}

function axisVector(first: number, second = 0): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  vector[0] = first;
  vector[1] = second;
  return normalizeL2(vector);
}

function message(
  stableKey: string,
  role: string,
  text: string,
  sessionId = SESSION_ID,
): ChatMessageRecord {
  return {
    stable_key: stableKey,
    session_id: sessionId,
    agent_id: "main",
    role,
    timestamp_ms: 1_717_200_000_000,
    timestamp_iso: "2024-06-01T12:00:00.000Z",
    date_key: "2024-06-01",
    text,
    raw_json: "{}",
    source_file: "recall-test.jsonl",
    source_line: 1,
    indexed_at_ms: 1_717_200_000_000,
  };
}

function insertMessage(db: RawChatDatabase, stableKey: string, role: string, text: string): number {
  db.insertMessage(message(stableKey, role, text));
  const row = db
    .getRawDb()
    .prepare("SELECT id FROM chat_messages WHERE stable_key = ?")
    .get(stableKey) as { id: number | bigint };
  return Number(row.id);
}

function seedContext(db: RawChatDatabase): number {
  insertMessage(db, "context-1", "user", "Earlier question");
  insertMessage(db, "context-2", "assistant", "Earlier answer");
  const targetId = insertMessage(db, "context-3", "user", "How do I configure the gateway port?");
  insertMessage(db, "context-4", "assistant", "Set gateway.port to 8317.");
  insertMessage(db, "context-5", "user", "I will apply that setting now.");
  return targetId;
}

function registerBeforePromptBuildHook(): {
  handler: HookHandler;
  logger: { warn: ReturnType<typeof vi.fn> };
} {
  let handler: HookHandler | undefined;
  const logger = { warn: vi.fn() };
  const api = {
    logger,
    on: vi.fn((name: string, registered: HookHandler) => {
      if (name === "before_prompt_build") {
        handler = registered;
      }
    }),
    registerTool: vi.fn(),
    registerService: vi.fn(),
  };

  rawChatSearchPlugin.register(api as never);
  if (!handler) {
    throw new Error("before_prompt_build handler was not registered");
  }
  return { handler, logger };
}

describe("RAW_CHAT_SEARCH Phase 3 vector recall", () => {
  let tmpDir: string;
  let stateDir: string;
  let db: RawChatDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-recall-"));
    stateDir = path.join(tmpDir, "state");
    setTestEnv("DENNOU_STATE_DIR", stateDir);
    db = getRawChatDatabase("main");
  });

  afterEach(() => {
    closeAllRawChatDatabases();
    restoreTestGlobals();
    restoreTestEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function recallOptions(fetchImpl: FetchStub) {
    return {
      apiKey: "test-key",
      env: { ...process.env } as NodeJS.ProcessEnv,
      fetchImpl,
    };
  }

  it("uses the documented defaults", () => {
    expect(HIGH_RELEVANCE_THRESHOLD).toBe(0.85);
    expect(MEDIUM_RELEVANCE_THRESHOLD).toBe(0.6);
    expect(DEFAULT_RECALL_TIMEOUT_MS).toBe(400);
    expect(DEFAULT_CONTEXT_WINDOW_ROUNDS).toBe(2);
  });

  it("injects a high-relevance verbatim mini-conversation", async () => {
    const targetId = seedContext(db);
    db.insertEmbedding({
      messageId: targetId,
      sessionId: SESSION_ID,
      embedding: axisVector(1),
      textSnippet: "gateway port pair",
    });

    const result = await performVectorRecall({
      prompt: "Please remind me how the gateway port was configured.",
      agentId: "main",
      sessionId: SESSION_ID,
      options: recallOptions(createFetchStub(axisVector(1))),
    });

    expect(result.recalled).toBe(true);
    expect(result.type).toBe("verbatim");
    expect(result.bestScore).toBeGreaterThanOrEqual(HIGH_RELEVANCE_THRESHOLD);
    expect(result.matchedIds).toEqual([targetId]);
    expect(result.injectedContext).toContain('<recalled-memory type="verbatim" relevance="high">');
    expect(result.injectedContext).toContain(`ID: 1-5`);
    expect(result.injectedContext).toContain(
      "User (2024-06-01): How do I configure the gateway port?",
    );
    expect(result.injectedContext).toContain("Kasou (2024-06-01): Set gateway.port to 8317.");
    expect(result.injectedContext).toContain("前後に続きがあります");
  });

  it("announces medium-relevance matches as a short hint", async () => {
    const firstId = insertMessage(db, "medium-1", "user", "Gateway port configuration");
    const secondId = insertMessage(db, "medium-2", "user", "Gateway listening address");
    db.insertEmbedding({
      messageId: firstId,
      sessionId: SESSION_ID,
      embedding: axisVector(0.7, Math.sqrt(1 - 0.7 ** 2)),
      textSnippet: "gateway port",
    });
    db.insertEmbedding({
      messageId: secondId,
      sessionId: SESSION_ID,
      embedding: axisVector(0.65, Math.sqrt(1 - 0.65 ** 2)),
      textSnippet: "gateway address",
    });

    const result = await performVectorRecall({
      prompt: "What did we discuss about the gateway?",
      agentId: "main",
      sessionId: SESSION_ID,
      options: recallOptions(createFetchStub(axisVector(1))),
    });

    expect(result.recalled).toBe(true);
    expect(result.type).toBe("hint");
    expect(result.bestScore).toBeGreaterThanOrEqual(MEDIUM_RELEVANCE_THRESHOLD);
    expect(result.bestScore).toBeLessThan(HIGH_RELEVANCE_THRESHOLD);
    expect(result.matchedIds).toEqual([firstId, secondId]);
    expect(result.injectedContext).toContain('<recalled-memory type="hint" relevance="medium">');
    expect(result.injectedContext).toContain(`過去の会話が 2 件`);
    expect(result.injectedContext).toContain(`ID: ${firstId}, ${secondId}`);
  });

  it("does not inject a low-relevance match", async () => {
    const messageId = insertMessage(db, "low-1", "user", "Unrelated topic");
    db.insertEmbedding({
      messageId,
      sessionId: SESSION_ID,
      embedding: axisVector(0.5, Math.sqrt(1 - 0.5 ** 2)),
      textSnippet: "unrelated",
    });

    const result = await performVectorRecall({
      prompt: "A query with no relevant memory",
      agentId: "main",
      sessionId: SESSION_ID,
      options: recallOptions(createFetchStub(axisVector(1))),
    });

    expect(result.recalled).toBe(false);
    expect(result.type).toBe("none");
    expect(result.injectedContext).toBeUndefined();
    expect(result.bestScore).toBeLessThan(MEDIUM_RELEVANCE_THRESHOLD);
    expect(result.matchedIds).toEqual([]);
  });

  it.each([
    [
      "timeout",
      async () => {
        const fetchImpl = vi.fn(async () => {
          const error = new Error("timed out");
          error.name = "TimeoutError";
          throw error;
        }) as unknown as FetchStub;
        return fetchImpl;
      },
    ],
    [
      "API error",
      async () =>
        vi.fn(async () => new Response("quota exceeded", { status: 429 })) as unknown as FetchStub,
    ],
  ])("fails open on an embedding %s", async (_name, makeFetch) => {
    const fetchImpl = await makeFetch();
    const result = await performVectorRecall({
      prompt: "This query should not block the reply",
      agentId: "main",
      sessionId: SESSION_ID,
      options: recallOptions(fetchImpl),
    });

    expect(result).toEqual({
      recalled: false,
      type: "none",
      bestScore: 0,
      matchedIds: [],
    });
  });

  it("returns none immediately for an empty or very short prompt", async () => {
    const fetchImpl = createFetchStub(axisVector(1));
    await expect(
      performVectorRecall({
        prompt: "  あ ",
        options: recallOptions(fetchImpl),
      }),
    ).resolves.toMatchObject({ recalled: false, type: "none" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bypasses recall when DENNOU_SKIP_VECTOR_RECALL is enabled", async () => {
    const fetchImpl = createFetchStub(axisVector(1));
    setTestGlobal("fetch", fetchImpl);
    setTestEnv("DENNOU_SKIP_VECTOR_RECALL", "1");
    const { handler } = registerBeforePromptBuildHook();

    await expect(
      handler(
        { prompt: "Please recall the gateway port", messages: [] },
        { agentId: "main", sessionId: SESSION_ID },
      ),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("integrates the verbatim result through before_prompt_build", async () => {
    const targetId = seedContext(db);
    db.insertEmbedding({
      messageId: targetId,
      sessionId: SESSION_ID,
      embedding: axisVector(1),
      textSnippet: "gateway port pair",
    });
    const fetchImpl = createFetchStub(axisVector(1));
    setTestGlobal("fetch", fetchImpl);
    setTestEnv("GEMINI_API_KEY", "test-key");
    const { handler } = registerBeforePromptBuildHook();

    const result = (await handler(
      { prompt: "Please recall the gateway port", messages: [] },
      { agentId: "main", sessionId: SESSION_ID },
    )) as { prependContext?: string } | undefined;

    expect(result?.prependContext).toContain('<recalled-memory type="verbatim"');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllRawChatDatabases, RawChatDatabase, resolveRawChatDbPath } from "./database.js";
import { isRawChatIndexingEnabled } from "./hook.js";
import { backfillSessionFiles, extractTextFromContent, indexSessionFile } from "./indexer.js";
import { ChatSearchSchema, createChatSearchTool } from "./tools.js";

describe("RawChatDatabase (SQLite + FTS5)", () => {
  let db: RawChatDatabase;

  beforeEach(() => {
    db = new RawChatDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates schema and verifies FTS5 availability", () => {
    expect(db.isFts5Available()).toBe(true);
  });

  it("inserts and searches messages via FTS5", () => {
    const inserted = db.insertMessage({
      stable_key: "sess-1:msg-1",
      session_id: "sess-1",
      agent_id: "main",
      role: "user",
      timestamp_ms: 1718452800000,
      timestamp_iso: "2024-06-15T12:00:00.000Z",
      date_key: "2024-06-15",
      text: "OpenClaw architecture and SQLite integration",
      raw_json: "{}",
      source_file: "/tmp/sess-1.jsonl",
      source_line: 2,
      indexed_at_ms: Date.now(),
    });
    expect(inserted).toBe(true);

    // Duplicate insert should be ignored
    const dup = db.insertMessage({
      stable_key: "sess-1:msg-1",
      session_id: "sess-1",
      agent_id: "main",
      role: "user",
      timestamp_ms: 1718452800000,
      timestamp_iso: "2024-06-15T12:00:00.000Z",
      date_key: "2024-06-15",
      text: "duplicate",
      raw_json: "{}",
      source_file: "/tmp/sess-1.jsonl",
      source_line: 2,
      indexed_at_ms: Date.now(),
    });
    expect(dup).toBe(false);

    // Search by keyword
    const res = db.search({ query: "SQLite" });
    expect(res.count).toBe(1);
    expect(res.results[0]?.snippet).toContain("SQLite integration");
    expect(res.results[0]?.role).toBe("user");
  });

  it("filters by date and time range", () => {
    const t1 = Date.parse("2026-07-01T10:00:00.000Z");
    const t2 = Date.parse("2026-07-02T10:00:00.000Z");

    db.insertMessages([
      {
        stable_key: "s1:m1",
        session_id: "s1",
        agent_id: "main",
        role: "user",
        timestamp_ms: t1,
        timestamp_iso: "2026-07-01T10:00:00.000Z",
        date_key: "2026-07-01",
        text: "Morning message",
        raw_json: "{}",
        source_file: "s1.jsonl",
        source_line: 1,
        indexed_at_ms: Date.now(),
      },
      {
        stable_key: "s1:m2",
        session_id: "s1",
        agent_id: "main",
        role: "assistant",
        timestamp_ms: t2,
        timestamp_iso: "2026-07-02T10:00:00.000Z",
        date_key: "2026-07-02",
        text: "Next day message",
        raw_json: "{}",
        source_file: "s1.jsonl",
        source_line: 2,
        indexed_at_ms: Date.now(),
      },
    ]);

    const dateRes = db.search({ date: "2026-07-01" });
    expect(dateRes.count).toBe(1);
    expect(dateRes.results[0]?.snippet).toBe("Morning message");

    const timeRes = db.search({ from: "2026-07-02T00:00:00Z" });
    expect(timeRes.count).toBe(1);
    expect(timeRes.results[0]?.snippet).toBe("Next day message");
  });

  it("expands surrounding context on message_id lookup", () => {
    db.insertMessages([
      {
        stable_key: "s1:m1",
        session_id: "s1",
        agent_id: "main",
        message_id: "msg-1",
        role: "user",
        timestamp_ms: 1000,
        timestamp_iso: "2026-07-01T10:00:00.000Z",
        date_key: "2026-07-01",
        text: "Context before",
        raw_json: "{}",
        source_file: "s1.jsonl",
        source_line: 1,
        indexed_at_ms: Date.now(),
      },
      {
        stable_key: "s1:m2",
        session_id: "s1",
        agent_id: "main",
        message_id: "msg-2",
        role: "assistant",
        timestamp_ms: 2000,
        timestamp_iso: "2026-07-01T10:01:00.000Z",
        date_key: "2026-07-01",
        text: "Target message",
        raw_json: "{}",
        source_file: "s1.jsonl",
        source_line: 2,
        indexed_at_ms: Date.now(),
      },
      {
        stable_key: "s1:m3",
        session_id: "s1",
        agent_id: "main",
        message_id: "msg-3",
        role: "user",
        timestamp_ms: 3000,
        timestamp_iso: "2026-07-01T10:02:00.000Z",
        date_key: "2026-07-01",
        text: "Context after",
        raw_json: "{}",
        source_file: "s1.jsonl",
        source_line: 3,
        indexed_at_ms: Date.now(),
      },
    ]);

    const res = db.search({
      message_id: "msg-2",
      context_before: 1,
      context_after: 1,
    });

    expect(res.count).toBe(3);
    expect(res.results[0]?.snippet).toBe("Context before");
    expect(res.results[1]?.snippet).toBe("Target message");
    expect(res.results[2]?.snippet).toBe("Context after");
  });

  it("manages watermarks accurately", () => {
    expect(db.getWatermark("test.jsonl")).toBeNull();

    db.setWatermark({
      source_file: "test.jsonl",
      size_bytes: 1024,
      mtime_ms: 1700000000,
      last_line: 10,
      last_indexed_at_ms: 1700000001,
    });

    const wm = db.getWatermark("test.jsonl");
    expect(wm).not.toBeNull();
    expect(wm?.size_bytes).toBe(1024);
    expect(wm?.last_line).toBe(10);
  });
});

describe("Indexer (JSONL parsing & backfill)", () => {
  let tmpDir: string;
  let db: RawChatDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-test-"));
    db = new RawChatDatabase(path.join(tmpDir, "test.sqlite"));
  });

  afterEach(() => {
    db.close();
    closeAllRawChatDatabases();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts text correctly from string and array content", () => {
    expect(extractTextFromContent("simple string")).toBe("simple string");
    expect(
      extractTextFromContent([
        { type: "text", text: "Part 1" },
        { type: "image", url: "https://..." },
        { type: "text", text: "Part 2" },
      ]),
    ).toBe("Part 1\nPart 2");
    expect(extractTextFromContent({ text: "Object text" })).toBe("Object text");
  });

  it("indexes session JSONL file incrementally", () => {
    const sessionFile = path.join(tmpDir, "session-1.jsonl");
    const line1 = JSON.stringify({ type: "session", id: "sess-1", version: 3 });
    const line2 = JSON.stringify({
      type: "message",
      id: "msg-1",
      parentId: null,
      message: {
        role: "user",
        content: "What is the capital of Japan?",
        timestamp: 1718452800000,
      },
    });
    const line3 = JSON.stringify({
      type: "message",
      id: "msg-2",
      parentId: "msg-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The capital of Japan is Tokyo." }],
        timestamp: 1718452801000,
      },
    });

    fs.writeFileSync(sessionFile, `${line1}\n${line2}\n${line3}\n`);

    const result = indexSessionFile({
      db,
      sessionFile,
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:user1",
    });

    expect(result.indexed).toBe(2);
    expect(result.errors).toBe(0);

    const searchRes = db.search({ query: "Tokyo" });
    expect(searchRes.count).toBe(1);
    expect(searchRes.results[0]?.channel).toBe("telegram");
    expect(searchRes.results[0]?.snippet).toContain("Tokyo");

    // Second run with unchanged file should index 0 records
    const secondResult = indexSessionFile({
      db,
      sessionFile,
      agentId: "main",
    });
    expect(secondResult.indexed).toBe(0);
  });

  it("backfills session files from directory", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const f1 = path.join(sessionsDir, "s1.jsonl");
    fs.writeFileSync(
      f1,
      `${JSON.stringify({ type: "session", id: "s1" })}\n${JSON.stringify({
        type: "message",
        id: "m1",
        message: { role: "user", content: "Backfill test message 1" },
      })}\n`,
    );

    const f2 = path.join(sessionsDir, "s2.jsonl");
    fs.writeFileSync(
      f2,
      `${JSON.stringify({ type: "session", id: "s2" })}\n${JSON.stringify({
        type: "message",
        id: "m2",
        message: { role: "assistant", content: "Backfill test message 2" },
      })}\n`,
    );

    const result = await backfillSessionFiles("main", {
      sessionDir: sessionsDir,
      db,
    });

    expect(result.total_files).toBe(2);
    expect(result.indexed_files).toBe(2);
    expect(result.total_messages).toBe(2);
  });
});

describe("chat_search tool", () => {
  let db: RawChatDatabase;
  const mockConfig = {} as any;

  beforeEach(() => {
    db = new RawChatDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns null when config is missing", () => {
    const tool = createChatSearchTool({ config: undefined, db });
    expect(tool).toBeNull();
  });

  it("returns null when raw chat indexing is explicitly disabled in config", () => {
    const disabledConfig = {
      dennou: {
        rawChat: {
          indexing: {
            enabled: false,
          },
        },
      },
    } as any;
    const tool = createChatSearchTool({ config: disabledConfig, db });
    expect(tool).toBeNull();
  });

  it("creates tool with schema and description", () => {
    const tool = createChatSearchTool({ config: mockConfig, db });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("chat_search");
    expect(tool?.label).toBe("Chat Search");
  });

  it("executes search and returns formatted JSON result", async () => {
    db.insertMessage({
      stable_key: "s1:m1",
      session_id: "s1",
      agent_id: "main",
      message_id: "m1",
      role: "user",
      timestamp_ms: 1718452800000,
      timestamp_iso: "2024-06-15T12:00:00.000Z",
      date_key: "2024-06-15",
      text: "EJU examination information",
      raw_json: "{}",
      source_file: "s1.jsonl",
      source_line: 1,
      indexed_at_ms: Date.now(),
    });

    const tool = createChatSearchTool({ config: mockConfig, db })!;
    const result = await tool.execute!("call-1", {
      query: "EJU",
      limit: 10,
    });

    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0]?.snippet).toContain("EJU examination");
  });

  it("handles search error gracefully without throwing", async () => {
    // Force error by closing DB before search
    db.close();
    const tool = createChatSearchTool({ config: mockConfig, db })!;
    const result = await tool.execute!("call-1", { query: "anything" });

    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.results).toEqual([]);
    expect(parsed.error).toBeDefined();
    expect(parsed.hint).toBeDefined();
  });

  it("ChatSearchSchema defines all parameters", () => {
    const schema = ChatSearchSchema as any;
    expect(schema.properties.query).toBeDefined();
    expect(schema.properties.from).toBeDefined();
    expect(schema.properties.to).toBeDefined();
    expect(schema.properties.date).toBeDefined();
    expect(schema.properties.messageId).toBeDefined();
    expect(schema.properties.role).toBeDefined();
    expect(schema.properties.channel).toBeDefined();
    expect(schema.properties.limit).toBeDefined();
    expect(schema.properties.contextBefore).toBeDefined();
    expect(schema.properties.contextAfter).toBeDefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatSearchSchema, createChatSearchTool, RawChatDatabase } from "./index.js";

describe("chat_search TS SQLite implementation", () => {
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

  it("creates tool when config is provided", () => {
    const tool = createChatSearchTool({ config: mockConfig, db });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("chat_search");
    expect(tool!.label).toBe("Chat Search");
  });

  it("executes search and returns results correctly", async () => {
    db.insertMessage({
      stable_key: "s1:m1",
      session_id: "s1",
      agent_id: "main",
      message_id: "msg-1",
      role: "user",
      timestamp_ms: 1718452800000,
      timestamp_iso: "2026-07-01T10:00:00.000Z",
      date_key: "2026-07-01",
      text: "Hello world and EJU preparation",
      raw_json: "{}",
      source_file: "s1.jsonl",
      source_line: 1,
      indexed_at_ms: Date.now(),
    });

    const tool = createChatSearchTool({ config: mockConfig, db })!;
    const result = await tool.execute!("call-1", {
      query: "EJU",
      date: "2026-07-01",
      limit: 10,
    });

    const text = (result as any).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].snippet).toContain("Hello world");
  });

  it("handles error gracefully when DB query fails", async () => {
    db.close();
    const tool = createChatSearchTool({ config: mockConfig, db })!;
    const result = await tool.execute!("call-1", { query: "test" });

    const text = (result as any).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results).toEqual([]);
    expect(parsed.error).toBeDefined();
  });

  it("ChatSearchSchema defines all expected parameters", () => {
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

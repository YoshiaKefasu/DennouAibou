import { describe, it, expect, vi, beforeEach } from "vitest";
import { setRawChatClient, getRawChatClient } from "./client-ref.js";
import type { RawChatClient } from "./sidecar-client.js";
import { createChatSearchTool, ChatSearchSchema } from "./tool.js";

/**
 * Tests for the raw chat TS boundary: tool registration, RPC call formatting,
 * sidecar unavailable handling, and error propagation.
 *
 * ponytail: These tests mock the RPC boundary. They do NOT test production
 * SQLite/indexing/search behavior — that lives in Go tests.
 */

// Mock the config types.
const mockConfig = {} as any;

describe("chat_search tool", () => {
  beforeEach(() => {
    setRawChatClient(null as any);
  });

  it("returns null when config is missing", () => {
    const tool = createChatSearchTool({ config: undefined });
    expect(tool).toBeNull();
  });

  it("creates tool when config is provided", () => {
    const tool = createChatSearchTool({ config: mockConfig });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("chat_search");
    expect(tool!.label).toBe("Chat Search");
  });

  it("returns error when sidecar is unavailable", async () => {
    setRawChatClient(null as any);
    const tool = createChatSearchTool({ config: mockConfig })!;
    const result = await tool.execute!("call-1", { query: "test" });
    const text = (result as any).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("not available");
  });

  it("calls sidecar RPC with correct params", async () => {
    const mockClient = {
      search: vi.fn().mockResolvedValue({
        results: [
          {
            message_id: "msg-1",
            role: "user",
            timestamp: "2026-07-01T10:00:00Z",
            snippet: "Hello world",
          },
        ],
        count: 1,
      }),
    } as unknown as RawChatClient;

    setRawChatClient(mockClient);
    const tool = createChatSearchTool({ config: mockConfig })!;
    const result = await tool.execute!("call-1", {
      query: "EJU",
      date: "2026-07-01",
      limit: 10,
    });

    expect(mockClient.search).toHaveBeenCalledWith({
      query: "EJU",
      date: "2026-07-01",
      limit: 10,
      agent_id: expect.any(String),
    });

    const text = (result as any).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].snippet).toBe("Hello world");
  });

  it("returns error when sidecar RPC fails", async () => {
    const mockClient = {
      search: vi.fn().mockRejectedValue(new Error("RPC timeout")),
    } as unknown as RawChatClient;

    setRawChatClient(mockClient);
    const tool = createChatSearchTool({ config: mockConfig })!;
    const result = await tool.execute!("call-1", { query: "test" });

    const text = (result as any).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("RPC timeout");
  });

  it("maps all parameter names correctly", async () => {
    const mockClient = {
      search: vi.fn().mockResolvedValue({ results: [], count: 0 }),
    } as unknown as RawChatClient;

    setRawChatClient(mockClient);
    const tool = createChatSearchTool({ config: mockConfig })!;
    await tool.execute!("call-1", {
      query: "test",
      from: "2026-07-01T00:00:00Z",
      to: "2026-07-01T23:59:59Z",
      date: "2026-07-01",
      messageId: "msg-123",
      role: "user",
      channel: "telegram",
      limit: 50,
      contextBefore: 3,
      contextAfter: 3,
    });

    expect(mockClient.search).toHaveBeenCalledWith({
      query: "test",
      from: "2026-07-01T00:00:00Z",
      to: "2026-07-01T23:59:59Z",
      date: "2026-07-01",
      message_id: "msg-123",
      role: "user",
      channel: "telegram",
      agent_id: expect.any(String),
      limit: 50,
      context_before: 3,
      context_after: 3,
    });
  });
});

describe("client-ref module", () => {
  beforeEach(() => {
    setRawChatClient(null as any);
  });

  it("starts with null client", () => {
    expect(getRawChatClient()).toBeNull();
  });

  it("sets and gets client", () => {
    const mockClient = {} as RawChatClient;
    setRawChatClient(mockClient);
    expect(getRawChatClient()).toBe(mockClient);
  });
});

describe("ChatSearchSchema", () => {
  it("defines all expected parameters", () => {
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

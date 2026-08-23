/**
 * Session compatibility guard: ensures that session JSONL files written by the
 * CURRENT_SESSION_VERSION at SDK 0.65.2 (version=3) remain readable and
 * writable after the SDK upgrade to 0.73.1.
 *
 * This test creates a minimal session file in the exact JSONL shape the old
 * SDK would have produced, then opens it with the (potentially new) SDK's
 * SessionManager to verify backward compatibility.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * Build a minimal session JSONL string that mirrors what SDK 0.65.2 would
 * have written.  The format is one JSON object per line:
 *
 *   line 1 – session header (type: "session")
 *   line 2 – user message entry
 *   line 3 – assistant message entry
 */
function buildLegacySessionJsonl(params: {
  sessionId: string;
  cwd: string;
  version?: number;
  timestamp?: string;
}): string {
  const header = {
    type: "session" as const,
    version: params.version ?? 3,
    id: params.sessionId,
    timestamp: params.timestamp ?? "2025-06-15T12:00:00.000Z",
    cwd: params.cwd,
  };

  const userEntry = {
    type: "message" as const,
    id: "msg-user-1",
    parentId: null,
    message: {
      role: "user" as const,
      content: "Hello, this is a legacy session message.",
      timestamp: 1718452800000,
    },
  };

  const assistantEntry = {
    type: "message" as const,
    id: "msg-assistant-1",
    parentId: "msg-user-1",
    message: {
      role: "assistant" as const,
      content: [{ type: "text", text: "Legacy assistant response." }],
      api: "openai-responses",
      provider: "openclaw",
      model: "gpt-4o",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: 1718452801000,
    },
  };

  return [header, userEntry, assistantEntry].map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("session-compatibility (SDK backward compat)", () => {
  it("SessionManager.open() reads a version-3 session written by old SDK", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-compat-test-"));
    const sessionFile = path.join(tmpDir, "session.jsonl");

    const sessionId = "compat-session-old-sdk";
    const jsonl = buildLegacySessionJsonl({ sessionId, cwd: tmpDir });
    await fs.writeFile(sessionFile, jsonl, "utf-8");

    const sm = SessionManager.open(sessionFile);

    // Header should be readable
    const header = sm.getHeader();
    expect(header).not.toBeNull();
    expect(header!.id).toBe(sessionId);
    expect(header!.version).toBe(3);
    expect(header!.cwd).toBe(tmpDir);

    // Both message entries should be parsed
    const entries = sm.getEntries();
    const messageEntries = entries.filter((e) => e.type === "message");
    expect(messageEntries.length).toBe(2);
    expect(messageEntries[0].message?.role).toBe("user");
    expect(messageEntries[1].message?.role).toBe("assistant");

    // buildSessionContext() should also resolve the messages
    const ctx = buildSessionContext(sm.getEntries(), sm.getLeafId());
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0].role).toBe("user");
    expect(ctx.messages[1].role).toBe("assistant");
  });

  it("CURRENT_SESSION_VERSION is a stable numeric constant", () => {
    // The version must be a positive integer so session headers remain
    // parseable across SDK upgrades.
    expect(typeof CURRENT_SESSION_VERSION).toBe("number");
    expect(Number.isInteger(CURRENT_SESSION_VERSION)).toBe(true);
    expect(CURRENT_SESSION_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("SessionManager.appendMessage() works on a session opened from legacy JSONL", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-compat-append-"));
    const sessionFile = path.join(tmpDir, "session.jsonl");

    const jsonl = buildLegacySessionJsonl({
      sessionId: "compat-append-session",
      cwd: tmpDir,
    });
    await fs.writeFile(sessionFile, jsonl, "utf-8");

    const sm = SessionManager.open(sessionFile);

    // Append a new user message using the SDK API
    const newId = sm.appendMessage({
      role: "user",
      content: "New message after SDK upgrade.",
      timestamp: Date.now(),
    });
    expect(typeof newId).toBe("string");
    expect(newId.length).toBeGreaterThan(0);

    // Verify the new message is present via buildSessionContext
    const ctx = buildSessionContext(sm.getEntries(), sm.getLeafId());
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[2].role).toBe("user");
    const userMsg = ctx.messages[2] as { role: string; content: string };
    expect(userMsg.content).toBe("New message after SDK upgrade.");

    // Verify the file was physically updated
    const raw = await fs.readFile(sessionFile, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(4); // header + 2 legacy + 1 new
  });

  it("SessionManager.create() appends messages that getEntries() can read", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-compat-roundtrip-"));

    // Create using the SDK factory (simulates current code path)
    const sm = SessionManager.create(tmpDir, tmpDir);
    sm.appendMessage({
      role: "user",
      content: "roundtrip user msg",
      timestamp: 1000,
    });

    // The in-memory session should have the entry
    const entries = sm.getEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const msgEntries = entries.filter((e) => e.type === "message");
    expect(msgEntries).toHaveLength(1);
    expect(msgEntries[0].message?.role).toBe("user");
  });
});

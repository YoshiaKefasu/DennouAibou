/**
 * Fixture Provenance & Design Notes:
 * フィクスチャは合成(synthetic)であり、generic custom entry / migration / 破損耐性パスの検証が目的。
 * `agent-boundary` customType は実在するプロダクション型ではなく、将来 KASOU 実機データに現れた場合の互換検証用のプレースホルダ。
 * 実機由来サンプルは後続フェーズで取り込み予定。
 *
 * NOTE: fixtures must be v3 headers. SessionManager.open() persists and would rewrite older-version files in-place.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { CustomEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatEnvelopeTimestamp } from "../../auto-reply/envelope.js";
import { resolveInboundSessionEnvelopeContext } from "../../channels/session-envelope.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  readSessionUpdatedAt,
  resetSessionStoreLockRuntimeForTests,
  setSessionWriteLockAcquirerForTests,
  updateLastRoute,
} from "../../config/sessions/store.js";
import { repairSessionFileIfNeeded } from "../session-file-repair.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, "__fixtures__", "kasou-sessions");

let tmpDir: string;

const acquireSessionWriteLockMock = vi.hoisted(() =>
  vi.fn(async () => ({ release: vi.fn(async () => {}) })),
);

let prevDennouStateDir: string | undefined;

beforeEach(async () => {
  prevDennouStateDir = process.env.DENNOU_STATE_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kasou-compat-test-"));
  process.env.DENNOU_STATE_DIR = tmpDir;
  acquireSessionWriteLockMock.mockClear();
  setSessionWriteLockAcquirerForTests(acquireSessionWriteLockMock);
});

afterEach(async () => {
  clearSessionStoreCacheForTest();
  resetSessionStoreLockRuntimeForTests();
  if (prevDennouStateDir === undefined) {
    delete process.env.DENNOU_STATE_DIR;
  } else {
    process.env.DENNOU_STATE_DIR = prevDennouStateDir;
  }
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("kasou-session-compat (D4 Phase Gate: Deep Session Compatibility)", () => {
  describe("Pattern A: Plain message chain (v2/v3 user/assistant/tool_call/tool_result)", () => {
    it("loads all entries without loss and preserves parent chain", async () => {
      const fixturePath = path.join(FIXTURES_DIR, "pattern-a-plain-chain.jsonl");
      const sm = SessionManager.open(fixturePath);

      // Verify header
      const header = sm.getHeader();
      expect(header).not.toBeNull();
      expect(header?.id).toBe("kasou-sess-plain-001");
      expect(header?.version).toBe(3);
      expect(header?.cwd).toBe("/home/kasou_yoshia");

      // Verify all entries loaded
      const entries = sm.getEntries();
      expect(entries).toHaveLength(4);

      // Verify entry types and parentId linkage
      expect(entries[0].id).toBe("a0000001");
      expect(entries[0].parentId).toBeNull();
      expect(entries[0].type).toBe("message");

      expect(entries[1].id).toBe("a0000002");
      expect(entries[1].parentId).toBe("a0000001");
      expect(entries[1].type).toBe("message");

      expect(entries[2].id).toBe("a0000003");
      expect(entries[2].parentId).toBe("a0000002");
      expect(entries[2].type).toBe("message");

      expect(entries[3].id).toBe("a0000004");
      expect(entries[3].parentId).toBe("a0000003");
      expect(entries[3].type).toBe("message");

      // Verify leaf and tree branch
      expect(sm.getLeafId()).toBe("a0000004");
      const branch = sm.getBranch();
      expect(branch.map((e) => e.id)).toEqual(["a0000001", "a0000002", "a0000003", "a0000004"]);

      // Verify tool call & result pairing in context resolution
      const ctx = sm.buildSessionContext();
      expect(ctx.messages).toHaveLength(4);

      const userMsg = ctx.messages[0] as UserMessage;
      expect(userMsg.role).toBe("user");
      expect(userMsg.content).toBe("Run memory check on KASOU");

      const asstToolMsg = ctx.messages[1] as AssistantMessage;
      expect(asstToolMsg.role).toBe("assistant");
      expect(asstToolMsg.stopReason).toBe("toolUse");
      const toolCall = asstToolMsg.content.find((c) => c.type === "toolCall");
      expect(toolCall).toBeDefined();
      if (toolCall && toolCall.type === "toolCall") {
        expect(toolCall.id).toBe("call_mem_001");
        expect(toolCall.name).toBe("bash");
        expect(toolCall.arguments).toEqual({ command: "free -h" });
      }

      const toolResultMsg = ctx.messages[2] as ToolResultMessage;
      expect(toolResultMsg.role).toBe("toolResult");
      expect(toolResultMsg.toolCallId).toBe("call_mem_001");
      expect(toolResultMsg.isError).toBe(false);

      const asstFinalMsg = ctx.messages[3] as AssistantMessage;
      expect(asstFinalMsg.role).toBe("assistant");
      expect(asstFinalMsg.stopReason).toBe("stop");
    });
  });

  describe("Pattern B: Mixed custom entries (model-snapshot, boundary notes, metadata)", () => {
    it("preserves custom extension metadata while maintaining conversation context", async () => {
      const fixturePath = path.join(FIXTURES_DIR, "pattern-b-custom-mixed.jsonl");
      const sm = SessionManager.open(fixturePath);

      // Verify header
      const header = sm.getHeader();
      expect(header).not.toBeNull();
      expect(header?.id).toBe("kasou-sess-custom-002");

      // Verify full entry count (9 entries)
      const entries = sm.getEntries();
      expect(entries).toHaveLength(9);

      // Verify custom entries and their metadata payloads
      const boundaryEntry = entries.find(
        (e): e is CustomEntry<{ agentId: string; boundaryNotes: string; checkedAt: number }> =>
          e.type === "custom" && (e as CustomEntry).customType === "agent-boundary",
      );
      expect(boundaryEntry).toBeDefined();
      expect(boundaryEntry?.data?.agentId).toBe("main");
      expect(boundaryEntry?.data?.boundaryNotes).toContain("Safety constraint");

      const snapshotEntry = entries.find(
        (e): e is CustomEntry<{ provider: string; modelId: string; thinkingLevel: string }> =>
          e.type === "custom" && (e as CustomEntry).customType === "model-snapshot",
      );
      expect(snapshotEntry).toBeDefined();
      expect(snapshotEntry?.data?.modelId).toBe("claude-3-5-sonnet-20241022");
      expect(snapshotEntry?.data?.thinkingLevel).toBe("low");

      // Verify session_info entry name extraction
      expect(sm.getSessionName()).toBe("KASOU Backup & Disk Health");

      // Verify continuous parent chain across heterogeneous entry types
      const expectedIds = [
        "b0000001",
        "b0000002",
        "b0000003",
        "b0000004",
        "b0000005",
        "b0000006",
        "b0000007",
        "b0000008",
        "b0000009",
      ];
      expect(entries.map((e) => e.id)).toEqual(expectedIds);

      let prevId: string | null = null;
      for (const entry of entries) {
        expect(entry.parentId).toBe(prevId);
        prevId = entry.id;
      }

      // Verify LLM context projection (custom entries and session_info do not pollute messages,
      // but model_change and thinking_level_change apply settings)
      const ctx = sm.buildSessionContext();
      expect(ctx.messages).toHaveLength(4); // 1 user + 1 assistant toolCall + 1 toolResult + 1 assistant final
      expect(ctx.thinkingLevel).toBe("low");
      expect(ctx.model).toEqual({
        provider: "anthropic",
        modelId: "claude-3-5-sonnet-20241022",
      });

      // Verify envelope metadata format in user message
      const firstMsg = ctx.messages[0] as UserMessage;
      expect(typeof firstMsg.content === "string" ? firstMsg.content : "").toContain(
        "[from: kasou_yoshia (192.168.100.46) at 2026-06-15T12:10:00.000Z]",
      );

      // Verify truncated toolResult placeholder content is retained
      const toolResultEntry = entries.find(
        (e): e is SessionMessageEntry & { message: ToolResultMessage } =>
          e.type === "message" && (e as SessionMessageEntry).message?.role === "toolResult",
      );
      expect(toolResultEntry).toBeDefined();
      expect(toolResultEntry?.message.toolName).toBe("bash");
      expect(typeof toolResultEntry?.timestamp).toBe("string");

      const toolResMsg = ctx.messages[2] as ToolResultMessage;
      const toolResText =
        Array.isArray(toolResMsg.content) && toolResMsg.content[0]?.type === "text"
          ? toolResMsg.content[0].text
          : "";
      expect(toolResText).toContain("⚠️ [Content truncated");
    });
  });

  describe("Pattern C: Corrupted and torn session lines", () => {
    it("gracefully skips malformed lines and handles orphaned nodes without throwing", async () => {
      const fixturePath = path.join(FIXTURES_DIR, "pattern-c-corrupted.jsonl");

      // SessionManager.open should not crash on malformed lines
      let sm: SessionManager | null = null;
      expect(() => {
        sm = SessionManager.open(fixturePath);
      }).not.toThrow();

      expect(sm).not.toBeNull();
      const entries = sm!.getEntries();

      // Malformed lines ('c_broken_mid' and 'c_torn_tail') are skipped; 4 valid entries remain
      expect(entries).toHaveLength(4);
      expect(entries.map((e) => e.id)).toEqual(["c0000001", "c0000002", "c0000003", "c0000004"]);

      // Tree structure treats orphaned node (c0000003 with dangling parentId) as a secondary root
      const tree = sm!.getTree();
      expect(tree.length).toBe(2); // root 1: c0000001, root 2: c0000003 (orphan)

      // getBranch() from active leaf traverses valid ancestors to root cleanly
      const branch = sm!.getBranch();
      expect(branch.map((e) => e.id)).toEqual(["c0000001", "c0000002", "c0000004"]);

      const ctx = sm!.buildSessionContext();
      expect(ctx.messages).toHaveLength(3);
    });

    it("repairSessionFileIfNeeded safely repairs torn lines and produces a clean backup", async () => {
      const sourceFixture = path.join(FIXTURES_DIR, "pattern-c-corrupted.jsonl");
      const testFile = path.join(tmpDir, "corrupted-session.jsonl");
      await fs.copyFile(sourceFixture, testFile);

      const warnings: string[] = [];
      const repairReport = await repairSessionFileIfNeeded({
        sessionFile: testFile,
        warn: (msg) => warnings.push(msg),
      });

      expect(repairReport.repaired).toBe(true);
      expect(repairReport.droppedLines).toBe(2);
      expect(repairReport.backupPath).toBeDefined();

      // Verify backup exists and has original content
      const backupContent = await fs.readFile(repairReport.backupPath!, "utf-8");
      expect(backupContent).toContain("c_broken_mid");

      // Verify repaired file has only valid JSON lines
      const repairedContent = await fs.readFile(testFile, "utf-8");
      const lines = repairedContent.trim().split("\n");
      expect(lines).toHaveLength(5); // header + 4 valid entries

      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      // Re-opening repaired file with SessionManager produces same valid entries
      const sm = SessionManager.open(testFile);
      expect(sm.getEntries()).toHaveLength(4);
    });
  });

  describe("Session Store & Envelope integration on legacy session metadata", () => {
    it("readSessionUpdatedAt and updateLastRoute operate seamlessly on session store", async () => {
      const storePath = path.join(tmpDir, "sessions.json");
      await fs.writeFile(storePath, "{}", "utf-8");
      const sessionKey = "kasou:subagent-001";

      // Initially no updated timestamp
      const initialTs = readSessionUpdatedAt({ storePath, sessionKey });
      expect(initialTs).toBeUndefined();

      // Update route
      await updateLastRoute({
        storePath,
        sessionKey,
        channel: "ssh",
        to: "kasou_yoshia",
        deliveryContext: {
          channel: "ssh",
          to: "kasou_yoshia",
        },
      });

      // Updated timestamp is now present
      const updatedTs = readSessionUpdatedAt({ storePath, sessionKey });
      expect(typeof updatedTs).toBe("number");
      expect(updatedTs).toBeGreaterThan(0);

      // Verify route metadata persisted in store
      const store = loadSessionStore(storePath);
      expect(store[sessionKey]?.deliveryContext?.channel).toBe("ssh");
      expect(store[sessionKey]?.deliveryContext?.to).toBe("kasou_yoshia");
      expect(store[sessionKey]?.lastChannel).toBe("ssh");
      expect(store[sessionKey]?.lastTo).toBe("kasou_yoshia");

      // Envelope context resolution
      const cfg: OpenClawConfig = {
        session: {
          store: storePath,
        },
        agents: {
          defaults: {
            envelopeTimezone: "UTC",
            envelopeTimestamp: "on",
            envelopeElapsed: "on",
          },
        },
      };

      const now = (updatedTs ?? 0) + 600_000; // 10 minutes later (above 5min threshold)
      const envCtx = resolveInboundSessionEnvelopeContext({
        cfg,
        agentId: "main",
        sessionKey,
        timestamp: now,
      });

      expect(envCtx.previousTimestamp).toBe(updatedTs);
      expect(envCtx.temporalMarkerPrefix).toBeDefined();

      const formatted = formatEnvelopeTimestamp(now, envCtx.envelopeOptions);
      expect(formatted).toBeDefined();
      expect(formatted).toContain("Z");
    });
  });

  describe("Bidirectional append and forward/backward migration", () => {
    it("appends new messages and custom entries to Pattern A and preserves full history on reload", async () => {
      const sourceFixture = path.join(FIXTURES_DIR, "pattern-a-plain-chain.jsonl");
      const targetSessionFile = path.join(tmpDir, "roundtrip-session.jsonl");
      await fs.copyFile(sourceFixture, targetSessionFile);

      // Open existing session
      const sm1 = SessionManager.open(targetSessionFile);
      expect(sm1.getEntries()).toHaveLength(4);

      // Append new turn
      const newMsgId1 = sm1.appendMessage({
        role: "user",
        content: "Next turn: check docker containers",
        timestamp: 1781524810000,
      });

      const newCustomId = sm1.appendCustomEntry("audit-checkpoint", {
        auditId: "chk-999",
        status: "passed",
      });

      const newMsgId2 = sm1.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "All containers are running normally." }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        usage: {
          input: 160,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 180,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1781524812000,
      });

      expect(sm1.getLeafId()).toBe(newMsgId2);
      expect(sm1.getEntries()).toHaveLength(7);

      // Reopen session in fresh instance to verify disk persistence
      const sm2 = SessionManager.open(targetSessionFile);
      const reloadedEntries = sm2.getEntries();
      expect(reloadedEntries).toHaveLength(7);

      // Verify original entries remain intact
      expect(reloadedEntries[0].id).toBe("a0000001");
      expect(reloadedEntries[3].id).toBe("a0000004");

      // Verify new entries and parent chain
      expect(reloadedEntries[4].id).toBe(newMsgId1);
      expect(reloadedEntries[4].parentId).toBe("a0000004");

      expect(reloadedEntries[5].id).toBe(newCustomId);
      expect(reloadedEntries[5].parentId).toBe(newMsgId1);
      expect(reloadedEntries[5].type).toBe("custom");

      expect(reloadedEntries[6].id).toBe(newMsgId2);
      expect(reloadedEntries[6].parentId).toBe(newCustomId);

      // Verify buildSessionContext() traverses the unified chain
      const ctx = sm2.buildSessionContext();
      expect(ctx.messages).toHaveLength(6); // 4 original + 2 new messages (custom excluded)
      const lastMsg = ctx.messages[ctx.messages.length - 1] as AssistantMessage;
      expect(lastMsg.role).toBe("assistant");
      const lastText = lastMsg.content.find((c) => c.type === "text");
      if (lastText && lastText.type === "text") {
        expect(lastText.text).toBe("All containers are running normally.");
      }
    });

    it("migrates legacy v2 session with hookMessage to v3, rewrites on disk, and supports ongoing append", async () => {
      const v2File = path.join(tmpDir, "v2-legacy-session.jsonl");
      const v2Lines = [
        JSON.stringify({
          type: "session",
          version: 2,
          id: "kasou-v2-legacy",
          timestamp: "2025-05-10T10:00:00.000Z",
          cwd: "/home/kasou_yoshia",
        }),
        JSON.stringify({
          type: "message",
          id: "v2_001",
          parentId: null,
          timestamp: "2025-05-10T10:00:01.000Z",
          message: { role: "user", content: "Legacy prompt" },
        }),
        JSON.stringify({
          type: "message",
          id: "v2_002",
          parentId: "v2_001",
          timestamp: "2025-05-10T10:00:02.000Z",
          message: { role: "hookMessage", content: "Legacy hook injection" },
        }),
        JSON.stringify({
          type: "message",
          id: "v2_003",
          parentId: "v2_002",
          timestamp: "2025-05-10T10:00:03.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Legacy assistant reply" }],
            provider: "anthropic",
            model: "claude-3-5-sonnet",
            usage: { totalTokens: 20 },
            stopReason: "stop",
          },
        }),
      ];
      await fs.writeFile(v2File, v2Lines.join("\n") + "\n", "utf-8");

      // Open with SessionManager (triggers migration)
      const sm = SessionManager.open(v2File);

      // Verify in-memory header updated to CURRENT_SESSION_VERSION (3)
      expect(sm.getHeader()?.version).toBe(CURRENT_SESSION_VERSION);

      // Verify hookMessage converted to custom
      const entries = sm.getEntries() as SessionMessageEntry[];
      expect(entries[1].message?.role).toBe("custom");

      // Verify disk was rewritten with version: 3
      const diskContent = await fs.readFile(v2File, "utf-8");
      expect(diskContent).toContain('"version":3');
      expect(diskContent).toContain('"role":"custom"');
      expect(diskContent).not.toContain('"role":"hookMessage"');

      // Append new message to migrated session
      sm.appendMessage({
        role: "user",
        content: "Post-migration follow-up",
        timestamp: 1781524815000,
      });

      // Verify context resolves properly
      const ctx = sm.buildSessionContext();
      expect(ctx.messages.length).toBeGreaterThanOrEqual(3);
    });
  });
});

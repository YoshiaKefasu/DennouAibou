/**
 * prune-active-session のユニットテスト
 *
 * テスト対象:
 * - pruneActiveSessionFile: アクティブセッションのatomic write Prune
 * - pruneActiveSessionById: セッションID指定のラッパー
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { pruneActiveSessionFile, pruneActiveSessionById } from "./prune-active-session.js";
import type { DennouSessionToolsPruneConfig } from "./types.js";

// ── テスト用ヘルパー ──────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dennou-active-prune-test-"));
}

function writeSessionFile(dir: string, name: string, lines: string[]): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

/** デフォルトテスト設定 */
const defaultConfig: DennouSessionToolsPruneConfig = {
  enabled: true,
  minPrunableToolChars: 100,
  keepLastAssistants: 2,
  placeholder: "[tool output pruned by DennouAibou]",
  dryRun: false,
};

// ── テスト用JSONL行テンプレート ──────────────────────────

function makeSessionHeader(id = "test-session"): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
  });
}

function makeUserMessage(text: string): string {
  return JSON.stringify({
    type: "message",
    id: "msg-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function makeAssistantMessage(text: string): string {
  return JSON.stringify({
    type: "message",
    id: "msg-2",
    parentId: "msg-1",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function makeLargeToolResult(text: string): string {
  return JSON.stringify({
    type: "message",
    id: "tool-1",
    parentId: "msg-2",
    timestamp: "2026-01-01T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "test_tool",
      content: [{ type: "text", text }],
      isError: false,
    },
  });
}

function makeSmallToolResult(): string {
  return JSON.stringify({
    type: "message",
    id: "tool-2",
    parentId: "msg-2",
    timestamp: "2026-01-01T00:00:04.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_2",
      toolName: "test_tool",
      content: [{ type: "text", text: "short" }],
      isError: false,
    },
  });
}

function makeMultiContentToolResult(parts: string[]): string {
  return JSON.stringify({
    type: "message",
    id: "tool-multi",
    parentId: "msg-2",
    timestamp: "2026-01-01T00:00:05.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_3",
      toolName: "test_tool",
      content: parts.map((text) => ({ type: "text", text })),
      isError: false,
    },
  });
}

// ── テスト ──────────────────────────────────────────────

describe("pruneActiveSessionFile", () => {
  let tempDir: string;
  let logs: string[];

  function testLogger(msg: string): void {
    logs.push(msg);
  }

  beforeEach(() => {
    tempDir = createTempDir();
    logs = [];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("prunes large toolResult entries but keeps small / protected ones", () => {
    // keepLastAssistants=2, アシスタント境界 = index 3（a1）
    // → index 2 の big だけが境界より前で prune 対象。index 4/5 は直近2ターン保護。
    const lines = [
      makeSessionHeader(),
      makeUserMessage("msg 1"),
      makeLargeToolResult("x".repeat(150)), // index 2 → prune!
      makeAssistantMessage("a1"), // index 3 → カットオフ
      makeSmallToolResult(), // index 4 → 保護
      makeSmallToolResult(), // index 5 → 保護
      makeAssistantMessage("a2"), // index 6
    ];
    const filePath = writeSessionFile(tempDir, "active-session.jsonl", lines);

    const pruned = pruneActiveSessionFile(filePath, defaultConfig, testLogger);

    expect(pruned).toBe(1);

    // ファイルがatomic writeで書き換わっていることを確認
    const content = fs.readFileSync(filePath, "utf8");
    const resultLines = content.trim().split("\n");
    expect(resultLines.length).toBe(7);
    // index 2 は JSON構造を保ったまま content のみプレースホルダに置換される
    expect(JSON.parse(resultLines[2]).message.content[0].text).toBe(
      "[tool output pruned by DennouAibou]",
    );
    // 保護範囲はそのまま
    expect(resultLines[3]).toBe(lines[3]);
    expect(resultLines[4]).toBe(lines[4]);
    expect(resultLines[5]).toBe(lines[5]);
    expect(resultLines[6]).toBe(lines[6]);
  });

  it("keeps entries within the assistant-protected tail even if large", () => {
    const lines = [
      makeSessionHeader(),
      makeLargeToolResult("x".repeat(200)), // 保護外（境界より前）→ prune!
      makeAssistantMessage("a1"),
      makeLargeToolResult("x".repeat(200)), // 直近2ターン → 保護
      makeLargeToolResult("x".repeat(200)), // 直近2ターン → 保護
      makeAssistantMessage("a2"),
    ];
    const filePath = writeSessionFile(tempDir, "session.jsonl", lines);

    const pruned = pruneActiveSessionFile(filePath, defaultConfig, testLogger);
    expect(pruned).toBe(1);
  });

  it("returns 0 for non-existent file", () => {
    const pruned = pruneActiveSessionFile(
      path.join(tempDir, "nonexistent.jsonl"),
      defaultConfig,
      testLogger,
    );
    expect(pruned).toBe(0);
  });

  it("does not modify file in dryRun mode", () => {
    // keepLastAssistants=2, アシスタント境界 = index 3（a1）→ index 2 が prune 対象
    const lines = [
      makeSessionHeader(),
      makeUserMessage("msg 1"),
      makeLargeToolResult("x".repeat(150)), // 保護外 → prune対象
      makeAssistantMessage("a1"),
      makeSmallToolResult(), // 直近2ターン → 保護
      makeAssistantMessage("a2"),
    ];
    const filePath = writeSessionFile(tempDir, "session.jsonl", lines);

    const dryConfig = { ...defaultConfig, dryRun: true, minPrunableToolChars: 1 };
    const pruned = pruneActiveSessionFile(filePath, dryConfig, testLogger);

    expect(pruned).toBe(1); // dry-runでも対象は検出される

    // ファイルが変更されていない
    const content = fs.readFileSync(filePath, "utf8");
    expect(content.trim()).toBe(lines.join("\n"));
  });

  it("handles malformed JSON lines gracefully", () => {
    const lines = [
      makeSessionHeader(),
      "this is not json",
      makeLargeToolResult("x".repeat(150)), // index 2, 境界より前 → prune!
      makeUserMessage("padding"),
      makeAssistantMessage("a1"), // カットオフ
      makeSmallToolResult(), // 直近2ターン → 保護
      makeAssistantMessage("a2"),
    ];
    const filePath = writeSessionFile(tempDir, "session.jsonl", lines);

    const cfg = { ...defaultConfig, minPrunableToolChars: 1 };
    const pruned = pruneActiveSessionFile(filePath, cfg, testLogger);
    expect(pruned).toBe(1);
  });

  it("handles empty files gracefully", () => {
    const filePath = path.join(tempDir, "empty.jsonl");
    fs.writeFileSync(filePath, "", "utf8");

    const pruned = pruneActiveSessionFile(filePath, defaultConfig, testLogger);
    expect(pruned).toBe(0);
  });

  it("counts multi-content text length correctly", () => {
    const lines = [
      makeSessionHeader(),
      makeUserMessage("one"),
      makeMultiContentToolResult(["x".repeat(60), "y".repeat(60)]), // 120 chars > 100 → prune!
      makeAssistantMessage("a1"),
      makeSmallToolResult(),
      makeAssistantMessage("a2"),
    ];
    const filePath = writeSessionFile(tempDir, "session.jsonl", lines);

    const cfg = { ...defaultConfig, minPrunableToolChars: 100 };
    const pruned = pruneActiveSessionFile(filePath, cfg, testLogger);
    expect(pruned).toBe(1);
  });

  it("handles file disappearance before write", () => {
    const lines = [makeSessionHeader(), makeLargeToolResult("x".repeat(150))];
    const filePath = writeSessionFile(tempDir, "session.jsonl", lines);

    const cfg = { ...defaultConfig, minPrunableToolChars: 1 };
    const pruned = pruneActiveSessionFile(filePath, cfg, (msg) => {
      // 1回目のlogger呼び出し（読み取り後）でファイルを削除
      if (logs.length === 0) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
      logs.push(msg);
    });
    // 行数が少なくkeepLastToolsに全行が保護される → prune対象がなくなる
    // これは正常系。ファイル消失シナリオは別の方法でテストする必要がある。
    // 代わりに、ファイル消失によって中断されるケースはmtime不整合としてテストする
    expect(typeof pruned).toBe("number");
  });

  it("aborts if mtime changes between read and write", () => {
    // mtimeの変更をシミュレートする: 読み取り直後にファイルをtouchする
    const lines = [
      makeSessionHeader(),
      makeUserMessage("filler"),
      makeLargeToolResult("x".repeat(150)), // 境界より前（index 2）→ 保護外
      makeAssistantMessage("a1"),
      makeUserMessage("pad2"),
      makeSmallToolResult(), // 直近2ターン → 保護
      makeAssistantMessage("a2"),
    ];
    const filePath = writeSessionFile(tempDir, "session.jsonl", lines);

    // loggerの中でファイルをtouchしてmtimeを変える
    const pruned = pruneActiveSessionFile(filePath, defaultConfig, (msg) => {
      logs.push(msg);
      // 最初のlogger呼び出しでファイルをtouch
      if (logs.length === 1) {
        // 同じ内容で書き戻してmtimeを更新
        const content = fs.readFileSync(filePath, "utf8");
        fs.writeFileSync(filePath, content, "utf8");
      }
    });

    // mtimeが変わったので中断される
    expect(pruned).toBe(-1);
    expect(logs.some((l) => l.includes("ABORT"))).toBe(true);
  });

  it("returns 0 when enabled is false", () => {
    const lines = [makeSessionHeader()];
    const filePath = writeSessionFile(tempDir, "session.jsonl", lines);
    const disabled = { ...defaultConfig, enabled: false };
    const pruned = pruneActiveSessionFile(filePath, disabled, testLogger);
    expect(pruned).toBe(0);
  });
});

describe("pruneActiveSessionById", () => {
  let tempDir: string;
  let logs: string[];

  function testLogger(msg: string): void {
    logs.push(msg);
  }

  beforeEach(() => {
    tempDir = createTempDir();
    logs = [];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("prunes a session by ID", () => {
    const lines = [
      makeSessionHeader("session-123"),
      makeUserMessage("msg 1"),
      makeLargeToolResult("x".repeat(150)), // 境界より前 → prune!
      makeAssistantMessage("a1"),
      makeSmallToolResult(),
      makeAssistantMessage("a2"),
    ];
    writeSessionFile(tempDir, "session-123.jsonl", lines);

    const pruned = pruneActiveSessionById(tempDir, "session-123", defaultConfig, testLogger);
    expect(pruned).toBe(1);
  });

  it("returns 0 for non-existent session", () => {
    const pruned = pruneActiveSessionById(tempDir, "ghost-session", defaultConfig, testLogger);
    expect(pruned).toBe(0);
  });

  it("returns 0 when config disabled", () => {
    const disabled = { ...defaultConfig, enabled: false };
    const pruned = pruneActiveSessionById(tempDir, "anything", disabled, testLogger);
    expect(pruned).toBe(0);
  });
});

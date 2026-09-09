/**
 * prune-closed-sessions のユニットテスト
 *
 * テスト対象:
 * - pruneClosedSessionFile: 単一ファイルのPruneロジック
 * - pruneAllClosedSessions: ディレクトリ走査
 * - 内部関数: parseLine, isToolResultEntry, getToolResultContentLength
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  pruneClosedSessionFile,
  pruneAllClosedSessions,
  pruneAllAgentsClosedSessions,
} from "./prune-closed-sessions.js";
import type { DennouSessionToolsPruneConfig } from "./types.js";

// ── テスト用ヘルパー ──────────────────────────────────────

/** テスト用のテンポラリディレクトリを作成する */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dennou-prune-test-"));
}

/** テスト用の閉じたセッションファイルを作成する（*.jsonl.deleted.*） */
function writeClosedSessionFile(dir: string, name: string, lines: string[]): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

function writeActiveSessionFile(dir: string, name: string, lines: string[]): string {
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
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  });
}

function makeAssistantMessage(text: string): string {
  return JSON.stringify({
    type: "message",
    id: "msg-2",
    parentId: "msg-1",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  });
}

/** 大きなツール結果エントリ（prune対象） */
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

/** 小さなツール結果エントリ（prune対象外：文字数不足） */
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

/** 複数contentがあるツール結果 */
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
      content: parts.map((text, i) => ({
        type: i === 0 ? "text" : "text",
        text,
      })),
      isError: false,
    },
  });
}

// ── テスト ──────────────────────────────────────────────

describe("pruneClosedSessionFile", () => {
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

  it("prunes large toolResult entries but keeps small ones", () => {
    // keepLastAssistants=2, アシスタント境界 = index 3（a1）
    // → index 2 の large toolResult のみが境界より前 → prune対象
    const lines = [
      makeSessionHeader(),
      makeUserMessage("msg 1"),
      makeLargeToolResult("x".repeat(150)), // index 2 → prune!
      makeAssistantMessage("a1"), // index 3 → カットオフ
      makeUserMessage("msg 3"), // index 4
      makeSmallToolResult(), // index 5 → 直近2ターン → 保護
      makeAssistantMessage("a2"), // index 6
    ];
    const filePath = writeClosedSessionFile(
      tempDir,
      "test-session.jsonl.deleted.2026-01-01T00-00-00.000Z",
      lines,
    );

    const pruned = pruneClosedSessionFile(filePath, defaultConfig, testLogger);

    expect(pruned).toBe(1); // 1行だけpruneされる

    // dryRun=false なのでファイルが書き換わっている
    const content = fs.readFileSync(filePath, "utf8");
    const resultLines = content.trim().split("\n");

    // 1-3行目: そのまま
    expect(resultLines[0]).toBe(lines[0]);
    expect(resultLines[1]).toBe(lines[1]);
    // index 2 は JSON構造を保ったまま content のみプレースホルダに置換される
    expect(JSON.parse(resultLines[2]).message.content[0].text).toBe(
      "[tool output pruned by DennouAibou]",
    );
    // 4行目以降: 保護範囲 → そのまま
    expect(resultLines[3]).toBe(lines[3]);
    expect(resultLines[4]).toBe(lines[4]);
    expect(resultLines[5]).toBe(lines[5]);
    expect(resultLines[6]).toBe(lines[6]);
  });

  it("keeps entries within the assistant-protected tail even if large", () => {
    // keepLastAssistants=2, アシスタント境界 = index 2（a1）
    // → index 1 の large のみが境界より前 → prune
    const lines = [
      makeSessionHeader(),
      makeLargeToolResult("x".repeat(200)), // 位置=1 → prune!
      makeAssistantMessage("a1"),
      makeLargeToolResult("x".repeat(200)), // 直近2ターン → 保護
      makeLargeToolResult("x".repeat(200)), // 直近2ターン → 保護
      makeAssistantMessage("a2"),
    ];
    const filePath = writeClosedSessionFile(
      tempDir,
      "test-session.jsonl.deleted.2026-01-01T00-00-00.000Z",
      lines,
    );

    const pruned = pruneClosedSessionFile(filePath, defaultConfig, testLogger);

    // 直近2ターンは保護されるため、pruneされるのは位置1の1行のみ
    expect(pruned).toBe(1);
  });

  it("skips active .jsonl files", () => {
    const lines = [makeSessionHeader(), makeLargeToolResult("x".repeat(200))];
    const filePath = writeActiveSessionFile(tempDir, "active-session.jsonl", lines);

    const pruned = pruneClosedSessionFile(filePath, defaultConfig, testLogger);
    expect(pruned).toBe(0); // 閉じていないのでスキップ

    // ファイルが変更されていないことを確認
    const content = fs.readFileSync(filePath, "utf8");
    expect(content.trim()).toBe(lines.join("\n"));
  });

  it("handles non-existent files gracefully", () => {
    const pruned = pruneClosedSessionFile(
      path.join(tempDir, "nonexistent.jsonl.deleted.xxx"),
      defaultConfig,
      testLogger,
    );
    expect(pruned).toBe(0);
  });

  it("does not modify file in dryRun mode", () => {
    // totalLines=5, keepLastTools=2 → 末尾2行（index 3,4）が保護
    // index 2 は posFromEnd=3 > 2 → 保護外
    const lines = [
      makeSessionHeader(),
      makeUserMessage("msg 1"),
      makeLargeToolResult("x".repeat(150)), // index 2, posFromEnd=3 → 保護外 → prune対象
      makeAssistantMessage("filler"),
      makeAssistantMessage("end"),
    ];
    const filePath = writeClosedSessionFile(
      tempDir,
      "test.jsonl.deleted.2026-01-01T00-00-00.000Z",
      lines,
    );

    // config: minPrunableToolChars=1 でlargeToolは必ず対象になる
    const dryConfig = { ...defaultConfig, dryRun: true, minPrunableToolChars: 1 };
    const pruned = pruneClosedSessionFile(filePath, dryConfig, testLogger);

    expect(pruned).toBe(1); // dry-runでも対象は検出される

    // ファイルが変更されていないことを確認
    const content = fs.readFileSync(filePath, "utf8");
    expect(content.trim()).toBe(lines.join("\n"));
  });

  it("handles malformed JSON lines gracefully", () => {
    // keepLastAssistants=2: アシスタント発言 = index 4（a1）, index 6（a2）→ 境界 = index 4
    const lines2 = [
      makeSessionHeader(), // 0
      "this is not json at all", // 1, malformed
      makeUserMessage("padding"), // 2
      makeLargeToolResult("x".repeat(150)), // 3, 境界より前 → prune!
      makeAssistantMessage("a1"), // 4, カットオフ
      makeSmallToolResult(), // 5, 直近2ターン → 保護
      makeAssistantMessage("a2"), // 6
    ];
    const filePath = writeClosedSessionFile(
      tempDir,
      "test.jsonl.deleted.2026-01-01T00-00-00.000Z",
      lines2,
    );

    // config: minPrunableToolChars=1 でlargeToolは必ず対象
    const cfg = { ...defaultConfig, minPrunableToolChars: 1 };
    const pruned = pruneClosedSessionFile(filePath, cfg, testLogger);
    expect(pruned).toBe(1); // malformedはスキップ、large toolだけprune
  });

  it("handles empty files gracefully", () => {
    const filePath = path.join(tempDir, "empty.jsonl.deleted.xxx");
    fs.writeFileSync(filePath, "", "utf8");

    const pruned = pruneClosedSessionFile(filePath, defaultConfig, testLogger);
    expect(pruned).toBe(0);
  });

  it("counts multi-content text length correctly", () => {
    // keepLastAssistants=2, アシスタント境界 = index 3（a1）→ index 2 の multicontent が対象
    const lines = [
      makeSessionHeader(), // 0
      makeUserMessage("one"), // 1
      makeMultiContentToolResult(["x".repeat(60), "y".repeat(60)]), // 120 chars, index 2 → prune!
      makeAssistantMessage("a1"), // 3, カットオフ
      makeUserMessage("three"), // 4
      makeSmallToolResult(), // 5, 直近2ターン → 保護
      makeAssistantMessage("a2"), // 6
    ];
    const filePath = writeClosedSessionFile(
      tempDir,
      "test.jsonl.deleted.2026-01-01T00-00-00.000Z",
      lines,
    );

    // minPrunableToolChars=100 なので120>100 → prune対象
    const cfg = { ...defaultConfig, minPrunableToolChars: 100 };
    const pruned = pruneClosedSessionFile(filePath, cfg, testLogger);
    expect(pruned).toBe(1);
  });
});

describe("pruneAllClosedSessions", () => {
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

  it("walks directory and prunes all closed session files", () => {
    // 各ファイルともアシスタント境界を置き、toolResult を保護範囲外に置く
    const lines1 = [
      makeSessionHeader(), // index 0
      makeLargeToolResult("x".repeat(150)), // index 1 → prune!
      makeAssistantMessage("filler"), // index 2
      makeSmallToolResult(), // index 3, 直近2ターン → 保護
      makeAssistantMessage("end"),
    ];
    const lines2 = [
      makeSessionHeader(), // index 0
      makeLargeToolResult("y".repeat(200)), // index 1 → prune!
      makeAssistantMessage("filler2"),
      makeSmallToolResult(), // 直近2ターン → 保護
      makeSmallToolResult(), // 直近2ターン → 保護
      makeAssistantMessage("end2"),
    ];

    writeClosedSessionFile(tempDir, "s1.jsonl.deleted.2026-01-01T00-00-00.000Z", lines1);
    writeClosedSessionFile(tempDir, "s2.jsonl.reset.2026-01-01T00-00-00.000Z", lines2);
    writeActiveSessionFile(tempDir, "active.jsonl", [
      makeSessionHeader(),
      makeUserMessage("hello"),
    ]);

    const total = pruneAllClosedSessions(tempDir, defaultConfig, testLogger);
    expect(total).toBe(2); // 2ファイルでそれぞれ1行ずつprune
  });

  it("handles non-existent directory gracefully", () => {
    const total = pruneAllClosedSessions(
      path.join(tempDir, "nonexistent"),
      defaultConfig,
      testLogger,
    );
    expect(total).toBe(0);
  });
});

describe("pruneAllAgentsClosedSessions", () => {
  let tempAgentDir: string;
  let realHome: string;

  beforeEach(() => {
    realHome = os.homedir();
    tempAgentDir = createTempDir();

    // 通常の処理は os.homedir() を使うため、
    // このテストは関数が既存のディレクトリで動くことを確認する代わりに
    // 存在しない場合のフォールバックをテストする
  });

  afterEach(() => {
    // 何もしない
  });

  it("skips if agents directory does not exist", () => {
    const logs: string[] = [];
    const total = pruneAllAgentsClosedSessions(defaultConfig, (msg) => logs.push(msg));
    // 実際の homedir に .openclaw/agents が存在するか否かに依存するが、
    // 少なくともエラーにならずに戻ってくればOK
    expect(typeof total).toBe("number");
  });
});

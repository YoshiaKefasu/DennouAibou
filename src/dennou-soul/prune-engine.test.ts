/**
 * prune-engine のユニットテスト
 *
 * テスト対象:
 * - isProtectedByKeyword: キーワード保護
 * - isProtectedByWorkspacePath: ワークスペースパス保護
 * - pruneToolOutputLines: 保護ルールを含むPrune判定
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  parseLine,
  pruneToolOutputLines,
  isProtectedByKeyword,
  isProtectedByWorkspacePath,
} from "./prune-engine.js";
import type { DennouSessionToolsPruneConfig, DennouPruneProtectionConfig } from "./types.js";

// ── テスト用ヘルパー ──────────────────────────────────────

/** 大きなツール結果エントリ（通常はprune対象） */
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

/** ワークスペースファイル読み取り結果を模したツール結果 */
function makeWorkspaceFileResult(text: string): string {
  return JSON.stringify({
    type: "message",
    id: "tool-read",
    parentId: "msg-2",
    timestamp: "2026-01-01T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_read",
      toolName: "readFile",
      content: [{ type: "text", text }],
      isError: false,
    },
  });
}

/** 小さなツール結果エントリ */
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

/** ユーザーメッセージ */
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

function makeSessionHeader(): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: "test-session",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
}

/** デフォルトテスト設定（minPrunableToolChars=10で小さな出力も対象に） */
const defaultConfig: DennouSessionToolsPruneConfig = {
  enabled: true,
  minPrunableToolChars: 10,
  keepLastTools: 2,
  placeholder: "[pruned]",
  dryRun: false,
};

const defaultProtection: DennouPruneProtectionConfig = {
  protectedContentKeywords: ["AGENTS.md", "SOUL.md", "DENNOU_RULES"],
  resolvedWorkspacePaths: [],
};

// ── isProtectedByKeyword ──────────────────────────────────

describe("isProtectedByKeyword", () => {
  it("returns true if content contains AGENTS.md", () => {
    const line = makeLargeToolResult("Here is the content of AGENTS.md: ...");
    const parsed = parseLine(line)!;
    expect(isProtectedByKeyword(parsed, defaultProtection)).toBe(true);
  });

  it("returns true if content contains SOUL.md", () => {
    const line = makeLargeToolResult("SOUL.md says: be good");
    const parsed = parseLine(line)!;
    expect(isProtectedByKeyword(parsed, defaultProtection)).toBe(true);
  });

  it("returns true if content contains DENNOU_RULES (case-insensitive)", () => {
    const line = makeLargeToolResult("see dennou_rules for details");
    const parsed = parseLine(line)!;
    expect(isProtectedByKeyword(parsed, defaultProtection)).toBe(true);
  });

  it("returns false if content does not contain any keyword", () => {
    const line = makeLargeToolResult("x".repeat(200));
    const parsed = parseLine(line)!;
    expect(isProtectedByKeyword(parsed, defaultProtection)).toBe(false);
  });

  it("returns false when no protection config provided", () => {
    const line = makeLargeToolResult("AGENTS.md content here");
    const parsed = parseLine(line)!;
    expect(isProtectedByKeyword(parsed, undefined)).toBe(false);
  });
});

// ── isProtectedByWorkspacePath ────────────────────────────

describe("isProtectedByWorkspacePath", () => {
  it("returns true if content contains a workspace path", () => {
    const wsPath = "d:/github/openclaw related repos/dennouaibou";
    const line = makeWorkspaceFileResult(`Reading file from ${wsPath}/SOUL.md`);
    const parsed = parseLine(line)!;
    const protection: DennouPruneProtectionConfig = {
      protectedContentKeywords: [],
      resolvedWorkspacePaths: [wsPath],
    };
    expect(isProtectedByWorkspacePath(parsed, protection)).toBe(true);
  });

  it("handles Windows backslash paths correctly", () => {
    const line = makeWorkspaceFileResult(`File content from D:\\GitHub\\OpenClaw Related Repos\\DennouAibou\\SOUL.md`);
    const parsed = parseLine(line)!;
    const protection: DennouPruneProtectionConfig = {
      protectedContentKeywords: [],
      resolvedWorkspacePaths: ["d:/github/openclaw related repos/dennouaibou"],
    };
    expect(isProtectedByWorkspacePath(parsed, protection)).toBe(true);
  });

  it("returns false when no paths match", () => {
    const line = makeWorkspaceFileResult("Some other file content");
    const parsed = parseLine(line)!;
    const protection: DennouPruneProtectionConfig = {
      protectedContentKeywords: [],
      resolvedWorkspacePaths: ["d:/other/path"],
    };
    expect(isProtectedByWorkspacePath(parsed, protection)).toBe(false);
  });

  it("returns false when no protection config provided", () => {
    const line = makeWorkspaceFileResult("d:/github/path");
    const parsed = parseLine(line)!;
    expect(isProtectedByWorkspacePath(parsed, undefined)).toBe(false);
  });

  it("returns true when workspace path exists only in raw JSON fields", () => {
    const line = JSON.stringify({
      type: "message",
      id: "tool-raw-path",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_read",
        toolName: "readFile",
        // content.text にはパスを含めない（取りこぼしケース）
        content: [{ type: "text", text: "Read completed" }],
      },
      // 生JSON側にだけ workspace 配下パスが含まれる
      sourcePath: "D:\\GitHub\\OpenClaw Related Repos\\DennouAibou\\src\\main.ts",
    });
    const parsed = parseLine(line)!;
    const protection: DennouPruneProtectionConfig = {
      protectedContentKeywords: [],
      resolvedWorkspacePaths: ["d:/github/openclaw related repos/dennouaibou"],
    };
    expect(isProtectedByWorkspacePath(parsed, protection)).toBe(true);
  });
});

// ── pruneToolOutputLines: 保護ルール統合テスト ────────────

describe("pruneToolOutputLines with protection", () => {
  let logs: string[];

  function testLogger(msg: string): void {
    logs.push(msg);
  }

  beforeEach(() => {
    logs = [];
  });

  it("protects toolResult containing AGENTS.md keyword from pruning", () => {
    // keepLastTools=2, totalLines=5
    // index 2 should be pruned unless protected by keyword
    const lines = [
      makeSessionHeader(),                     // 0
      makeUserMessage("hello"),                // 1
      makeLargeToolResult("AGENTS.md: some rules"), // 2, protected by keyword!
      makeSmallToolResult(),                   // 3, posFromEnd=2 → keepLastTools保護
      makeSmallToolResult(),                   // 4, posFromEnd=1 → 保護
    ];
    const protection: DennouPruneProtectionConfig = {
      protectedContentKeywords: ["AGENTS.md"],
      resolvedWorkspacePaths: [],
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(
      lines, defaultConfig, testLogger, protection,
    );

    expect(prunedCount).toBe(0); // keyword保護でpruneされない
    expect(resultLines[2]).toBe(lines[2]); // そのまま保持
  });

  it("protects toolResult containing workspace path from pruning", () => {
    const lines = [
      makeSessionHeader(),                     // 0
      makeUserMessage("hello"),                // 1
      makeWorkspaceFileResult("Reading from /home/user/project/SOUL.md"), // 2, protected!
      makeSmallToolResult(),                   // 3, posFromEnd=2
      makeSmallToolResult(),                   // 4, posFromEnd=1
    ];
    const protection: DennouPruneProtectionConfig = {
      protectedContentKeywords: [],
      resolvedWorkspacePaths: ["/home/user/project"],
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(
      lines, defaultConfig, testLogger, protection,
    );

    expect(prunedCount).toBe(0);
    expect(resultLines[2]).toBe(lines[2]);
  });

  it("prunes toolResult without protected content normally", () => {
    const lines = [
      makeSessionHeader(),                     // 0
      makeUserMessage("hello"),                // 1
      makeLargeToolResult("x".repeat(100)),    // 2, no keyword → prune!
      makeSmallToolResult(),                   // 3, posFromEnd=2
      makeSmallToolResult(),                   // 4, posFromEnd=1
    ];
    const protection: DennouPruneProtectionConfig = {
      protectedContentKeywords: ["AGENTS.md", "SOUL.md"],
      resolvedWorkspacePaths: ["/other/path"],
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(
      lines, defaultConfig, testLogger, protection,
    );

    expect(prunedCount).toBe(1);
    expect(resultLines[2]).toBe("[pruned]");
  });

  it("applies both keyword and path protection simultaneously", () => {
    // index 2: no match → prune
    // index 3: keyword match → protect
    // index 4: path match → protect
    const lines = [
      makeSessionHeader(),                                // 0
      makeUserMessage("hello"),                           // 1
      makeLargeToolResult("plain output"),                // 2, neither → prune
      makeWorkspaceFileResult("AGENTS.md updated"),        // 3, keyword match
      makeWorkspaceFileResult("/home/user/project/README"),// 4, path match
    ];
    const protection: DennouPruneProtectionConfig = {
      protectedContentKeywords: ["AGENTS.md"],
      resolvedWorkspacePaths: ["/home/user/project"],
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(
      lines, defaultConfig, testLogger, protection,
    );

    expect(prunedCount).toBe(1);
    expect(resultLines[2]).toBe("[pruned]");
    expect(resultLines[3]).toBe(lines[3]);
    expect(resultLines[4]).toBe(lines[4]);
  });

  it("works without protection config (backward compatibility)", () => {
    const lines = [
      makeSessionHeader(),                     // 0
      makeUserMessage("hello"),                // 1
      makeUserMessage("msg 2"),                // 2
      makeUserMessage("msg 3"),                // 3
      makeLargeToolResult("x".repeat(100)),    // 4, posFromEnd=2, keepLastTools=2 で保護範囲内 → 保護
      makeSmallToolResult(),                   // 5, posFromEnd=1 → 保護
    ];

    // minPrunableToolCharsを50にすることでlarge toolが対象になるが、
    // keepLastTools=2 で末尾2行は保護される
    // ただしこのテストは「protectionがなくても動くこと」だけ確認すればいい
    const cfg = { ...defaultConfig, keepLastTools: 0, minPrunableToolChars: 50 };
    const { prunedCount } = pruneToolOutputLines(lines, cfg, testLogger);

    expect(prunedCount).toBe(1);
  });
});

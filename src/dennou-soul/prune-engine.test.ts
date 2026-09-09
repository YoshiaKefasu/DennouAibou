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
  findAssistantCutoffIndex,
  isAlreadyPlaceholderized,
  pruneToolResultEntry,
  buildCanonicalPlaceholder,
  formatPrunableSizeLabel,
  getToolResultContentLength,
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

/** 画像ブロック（type: "image"、Base64 data）を含むツール結果エントリ */
function makeImageToolResult(imageDataChars: number): string {
  return JSON.stringify({
    type: "message",
    id: "tool-img",
    parentId: "msg-2",
    timestamp: "2026-01-01T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_img",
      toolName: "read_image",
      content: [
        { type: "text", text: "screenshot.png" },
        { type: "image", data: "A".repeat(imageDataChars), mimeType: "image/png" },
      ],
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

/** アシスタントメッセージ（アシスタント発言境界の判定に使う） */
function makeAssistantMessage(text: string): string {
  return JSON.stringify({
    type: "message",
    id: "msg-a",
    parentId: "msg-1",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
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
  keepLastAssistants: 2,
  placeholder: "[pruned]",
  dryRun: false,
};

const defaultProtection: DennouPruneProtectionConfig = {
  protectedContentKeywords: ["AGENTS.md", "SOUL.md", "DENNOU_RULES"],
  resolvedWorkspacePaths: [],
};

// ── getToolResultContentLength: 画像ブロックのサイズ認識 ──

describe("getToolResultContentLength with image blocks", () => {
  it("includes image block base64 data length in the total size", () => {
    const parsed = parseLine(makeImageToolResult(2_000))!;
    // テキスト14文字（"screenshot.png"）+ 画像data 2000文字
    expect(getToolResultContentLength(parsed)).toBe(14 + 2_000);
  });

  it("prunes oversized image results once they age past the cutoff, keeping JSON structure", () => {
    // keepLastAssistants=2 → カットオフ index 4。index 2 の画像結果は境界より前（古い）→ Prune対象。
    // index 5 の画像結果は直近2ターン内 → 生保持（遅延プレースホルダー化）。
    const lines = [
      makeSessionHeader(), // 0
      makeUserMessage("hello"), // 1
      makeImageToolResult(2_000), // 2, 古い画像結果 → prune対象
      makeAssistantMessage("a1"), // 3
      makeAssistantMessage("a2"), // 4 ← カットオフ
      makeImageToolResult(2_000), // 5, 直近2ターン → 保護（生保持）
    ];
    const cfg: DennouSessionToolsPruneConfig = {
      ...defaultConfig,
      keepLastAssistants: 2,
      minPrunableToolChars: 1200,
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(lines, cfg, () => {});

    expect(prunedCount).toBe(1);
    // プレースホルダー化後も JSON 構造（id / parentId / toolCallId / toolName / isError）は100%保持
    const parsed = JSON.parse(resultLines[2]!) as {
      id?: string;
      parentId?: string;
      message?: {
        role?: string;
        toolCallId?: string;
        toolName?: string;
        isError?: boolean;
        content?: Array<{ type?: string; text?: string }>;
      };
    };
    expect(parsed.id).toBe("tool-img");
    expect(parsed.parentId).toBe("msg-2");
    expect(parsed.message?.role).toBe("toolResult");
    expect(parsed.message?.toolCallId).toBe("call_img");
    expect(parsed.message?.toolName).toBe("read_image");
    expect(parsed.message?.isError).toBe(false);
    expect(parsed.message?.content).toEqual([{ type: "text", text: "[pruned]" }]);
    // 直近ターンの画像結果は生データのまま（画像ブロックも残っている）
    expect(resultLines[5]).toBe(lines[5]);
    expect(JSON.parse(resultLines[5]!).message.content[1]).toEqual({
      type: "image",
      data: "A".repeat(2_000),
      mimeType: "image/png",
    });
  });

  it("keeps image results within recent protect window raw even when oversized", () => {
    // keepLastAssistants=3 でアシスタント発言は2回 → カットオフは null → 全行保護
    const lines = [
      makeSessionHeader(),
      makeUserMessage("hello"),
      makeImageToolResult(5_000),
      makeAssistantMessage("a1"),
      makeAssistantMessage("a2"),
    ];
    const cfg: DennouSessionToolsPruneConfig = {
      ...defaultConfig,
      keepLastAssistants: 3,
      minPrunableToolChars: 100,
    };
    const { resultLines, prunedCount } = pruneToolOutputLines(lines, cfg, () => {});
    expect(prunedCount).toBe(0);
    expect(resultLines[2]).toBe(lines[2]);
  });
});

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
    const line = makeWorkspaceFileResult(
      `File content from D:\\GitHub\\OpenClaw Related Repos\\DennouAibou\\SOUL.md`,
    );
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

// ── findAssistantCutoffIndex ──────────────────────────────

describe("findAssistantCutoffIndex", () => {
  it("finds the keepLastAssistants-th assistant from the end", () => {
    const lines = [
      makeSessionHeader(),
      makeUserMessage("hello"),
      makeAssistantMessage("a1"),
      makeUserMessage("again"),
      makeAssistantMessage("a2"),
      makeAssistantMessage("a3"),
    ];
    // 末尾から2回目のアシスタント = index 4（a2）
    expect(findAssistantCutoffIndex(lines, 2)).toBe(4);
    // 末尾から3回目のアシスタント = index 2（a1）
    expect(findAssistantCutoffIndex(lines, 3)).toBe(2);
  });

  it("returns null when fewer assistants than keepLastAssistants exist", () => {
    const lines = [makeSessionHeader(), makeUserMessage("hello"), makeAssistantMessage("a1")];
    expect(findAssistantCutoffIndex(lines, 2)).toBeNull();
  });

  it("returns lines.length when keepLastAssistants is 0 (everything prunable)", () => {
    const lines = [makeSessionHeader(), makeUserMessage("hello")];
    expect(findAssistantCutoffIndex(lines, 0)).toBe(lines.length);
  });

  it("skips malformed lines and non-assistant entries while scanning", () => {
    const lines = [
      makeSessionHeader(),
      "not json",
      makeUserMessage("hello"),
      makeLargeToolResult("x"),
      makeAssistantMessage("a1"),
      makeAssistantMessage("a2"),
    ];
    expect(findAssistantCutoffIndex(lines, 2)).toBe(4);
  });
});

// ── 冪等性（二重置換防止）──────────────────────────────

describe("placeholder idempotency", () => {
  it("isAlreadyPlaceholderized detects canonical and legacy markers", () => {
    const canonical = parseLine(makeLargeToolResult("[出力省略: 120行 / 3.4KB 正常終了]"))!;
    const legacy = parseLine(makeLargeToolResult("[Old tool output cleared — re-run if needed]"))!;
    const raw = parseLine(makeLargeToolResult("x".repeat(200)))!;
    expect(isAlreadyPlaceholderized(canonical)).toBe(true);
    expect(isAlreadyPlaceholderized(legacy)).toBe(true);
    expect(isAlreadyPlaceholderized(raw)).toBe(false);
  });

  it("pruneToolResultEntry returns the raw line for already-placeholderized entries", () => {
    const line = makeLargeToolResult("[出力省略: 120行 / 3.4KB 正常終了]");
    const entry = parseLine(line)!;
    expect(pruneToolResultEntry(entry, "[pruned]")).toBe(line);
  });

  it("pruneToolOutputLines never double-prunes placeholderized entries", () => {
    const already = makeLargeToolResult("[出力省略: 500行 / 15KB 正常終了]");
    const lines = [
      makeSessionHeader(),
      makeUserMessage("hello"),
      already, // プレースホルダー済み（keyboard以外にも「置換済み」で判定）
      makeAssistantMessage("a1"),
      makeAssistantMessage("a2"),
    ];
    const cfg: DennouSessionToolsPruneConfig = {
      ...defaultConfig,
      minPrunableToolChars: 1,
      keepLastAssistants: 0,
    };
    const { resultLines, prunedCount } = pruneToolOutputLines(lines, cfg, () => {});
    expect(prunedCount).toBe(0);
    expect(resultLines[2]).toBe(already);
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
    // keepLastAssistants=2, アシスタント境界は index 3（a1）。
    // index 2 は境界より前で本来prune対象だが、キーワード保護により保持される。
    const lines = [
      makeSessionHeader(), // 0
      makeUserMessage("hello"), // 1
      makeLargeToolResult("AGENTS.md: some rules"), // 2, protected by keyword!
      makeAssistantMessage("a1"), // 3
      makeSmallToolResult(), // 4, 境界以降 → 保護
      makeAssistantMessage("a2"), // 5
    ];
    const protection: DennouPruneProtectionConfig = {
      protectedContentKeywords: ["AGENTS.md"],
      resolvedWorkspacePaths: [],
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(
      lines,
      defaultConfig,
      testLogger,
      protection,
    );

    expect(prunedCount).toBe(0); // keyword保護でpruneされない
    expect(resultLines[2]).toBe(lines[2]); // そのまま保持
  });

  it("protects toolResult containing workspace path from pruning", () => {
    const lines = [
      makeSessionHeader(), // 0
      makeUserMessage("hello"), // 1
      makeWorkspaceFileResult("Reading from /home/user/project/SOUL.md"), // 2, protected!
      makeAssistantMessage("a1"), // 3
      makeSmallToolResult(), // 4
      makeAssistantMessage("a2"), // 5
    ];
    const protection: DennouPruneProtectionConfig = {
      protectedContentKeywords: [],
      resolvedWorkspacePaths: ["/home/user/project"],
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(
      lines,
      defaultConfig,
      testLogger,
      protection,
    );

    expect(prunedCount).toBe(0);
    expect(resultLines[2]).toBe(lines[2]);
  });

  it("prunes toolResult without protected content normally", () => {
    const lines = [
      makeSessionHeader(), // 0
      makeUserMessage("hello"), // 1
      makeLargeToolResult("x".repeat(100)), // 2, no keyword → prune!
      makeAssistantMessage("a1"), // 3 → カットオフ
      makeSmallToolResult(), // 4, 境界以降 → 保護
      makeSmallToolResult(), // 5, 境界以降 → 保護
      makeAssistantMessage("a2"), // 6
    ];
    const protection: DennouPruneProtectionConfig = {
      protectedContentKeywords: ["AGENTS.md", "SOUL.md"],
      resolvedWorkspacePaths: ["/other/path"],
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(
      lines,
      defaultConfig,
      testLogger,
      protection,
    );

    expect(prunedCount).toBe(1);
    const parsed = JSON.parse(resultLines[2]);
    expect(parsed.id).toBe("tool-1");
    expect(parsed.parentId).toBe("msg-2");
    expect(parsed.message.role).toBe("toolResult");
    expect(parsed.message.toolCallId).toBe("call_1");
    expect(parsed.message.toolName).toBe("test_tool");
    expect(parsed.message.isError).toBe(false);
    expect(parsed.message.content).toEqual([{ type: "text", text: "[pruned]" }]);
  });

  it("applies both keyword and path protection simultaneously", () => {
    // index 2: no match → prune
    // index 3: keyword match → protect
    // index 4: path match → protect
    const lines = [
      makeSessionHeader(), // 0
      makeUserMessage("hello"), // 1
      makeLargeToolResult("plain output"), // 2, neither → prune
      makeWorkspaceFileResult("AGENTS.md updated"), // 3, keyword match
      makeWorkspaceFileResult("/home/user/project/README"), // 4, path match
      makeAssistantMessage("a1"), // 5
      makeAssistantMessage("a2"), // 6
    ];
    const protection: DennouPruneProtectionConfig = {
      protectedContentKeywords: ["AGENTS.md"],
      resolvedWorkspacePaths: ["/home/user/project"],
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(
      lines,
      defaultConfig,
      testLogger,
      protection,
    );

    expect(prunedCount).toBe(1);
    const parsed = JSON.parse(resultLines[2]);
    expect(parsed.id).toBe("tool-1");
    expect(parsed.message.toolCallId).toBe("call_1");
    expect(parsed.message.toolName).toBe("test_tool");
    expect(parsed.message.content).toEqual([{ type: "text", text: "[pruned]" }]);
    expect(resultLines[3]).toBe(lines[3]);
    expect(resultLines[4]).toBe(lines[4]);
  });

  it("keeps pruned toolResult rows as valid JSON lines", () => {
    const lines = [
      makeSessionHeader(),
      makeUserMessage("hello"),
      makeLargeToolResult("x".repeat(200)),
      makeUserMessage("tail-1"),
      makeUserMessage("tail-2"),
    ];

    const cfg: DennouSessionToolsPruneConfig = {
      ...defaultConfig,
      keepLastAssistants: 0,
      minPrunableToolChars: 50,
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(lines, cfg, testLogger);

    expect(prunedCount).toBe(1);
    expect(() => JSON.parse(resultLines[2])).not.toThrow();
    const reparsed = parseLine(resultLines[2]);
    expect(reparsed).not.toBeNull();
    const parsedMsg = reparsed?.parsed.message as Record<string, unknown> | undefined;
    expect(parsedMsg?.role).toBe("toolResult");
  });

  it("preserves tool metadata and error flag when pruning toolResult", () => {
    const errorToolResult = JSON.stringify({
      type: "message",
      id: "tool-error-1",
      parentId: "msg-error-parent",
      timestamp: "2026-01-01T00:00:05.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_error_1",
        toolName: "web_search",
        content: [{ type: "text", text: "x".repeat(300) }],
        isError: true,
      },
    });

    const lines = [
      makeSessionHeader(),
      makeUserMessage("hello"),
      errorToolResult,
      makeUserMessage("tail-1"),
      makeUserMessage("tail-2"),
    ];

    const cfg: DennouSessionToolsPruneConfig = {
      ...defaultConfig,
      keepLastAssistants: 0,
      minPrunableToolChars: 50,
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(lines, cfg, testLogger);

    expect(prunedCount).toBe(1);
    const parsed = JSON.parse(resultLines[2]);
    expect(parsed.id).toBe("tool-error-1");
    expect(parsed.parentId).toBe("msg-error-parent");
    expect(parsed.message.role).toBe("toolResult");
    expect(parsed.message.toolCallId).toBe("call_error_1");
    expect(parsed.message.toolName).toBe("web_search");
    expect(parsed.message.isError).toBe(true);
    expect(parsed.message.content).toEqual([{ type: "text", text: "[pruned]" }]);
  });

  it("works without protection config (backward compatibility)", () => {
    const lines = [
      makeSessionHeader(), // 0
      makeUserMessage("hello"), // 1
      makeUserMessage("msg 2"), // 2
      makeUserMessage("msg 3"), // 3
      makeLargeToolResult("x".repeat(100)), // 4
      makeSmallToolResult(), // 5
    ];

    // keepLastAssistants=0 → 保護なし（全行がPrune対象）
    // minPrunableToolChars=50 で large tool のみ対象（small は 5文字 < 50）
    const cfg = { ...defaultConfig, keepLastAssistants: 0, minPrunableToolChars: 50 };
    const { prunedCount } = pruneToolOutputLines(lines, cfg, testLogger);

    expect(prunedCount).toBe(1);
  });

  it("does not emit per-line prune logs in dryRun mode", () => {
    const lines = [
      makeSessionHeader(),
      makeUserMessage("hello"),
      makeLargeToolResult("x".repeat(120)),
      makeUserMessage("tail-1"),
      makeUserMessage("tail-2"),
    ];

    const dryCfg: DennouSessionToolsPruneConfig = {
      ...defaultConfig,
      dryRun: true,
      keepLastAssistants: 0,
      minPrunableToolChars: 50,
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(lines, dryCfg, testLogger);

    expect(prunedCount).toBe(1);
    expect(logs).toEqual([]);
    expect(resultLines[2]).toBe(lines[2]);
  });

  it("protects tool results of the last keepLastAssistants turns (直近3ターン保護)", () => {
    // アシスタント発言 = a1(2), a2(4), a3(6)。keepLastAssistants=2 → カットオフ = index 4。
    // bigTR(3) のみが境界より前 → pruned。bigTR2(5) / bigTR3(7) は直近2ターン → 保護。
    const lines = [
      makeSessionHeader(), // 0
      makeUserMessage("hello"), // 1
      makeAssistantMessage("a1"), // 2
      makeLargeToolResult("x".repeat(500)), // 3, 4回目以前 → prune対象
      makeAssistantMessage("a2"), // 4 ← カットオフ
      makeLargeToolResult("y".repeat(500)), // 5, 直近2ターン → 保護
      makeAssistantMessage("a3"), // 6
      makeLargeToolResult("z".repeat(500)), // 7, 直近2ターン → 保護
    ];
    const cfg: DennouSessionToolsPruneConfig = {
      ...defaultConfig,
      keepLastAssistants: 2,
      minPrunableToolChars: 100,
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(lines, cfg, testLogger);

    expect(prunedCount).toBe(1);
    expect(resultLines[2]).toBe(lines[2]);
    expect(JSON.parse(resultLines[3]).message.content[0].text).toBe("[pruned]");
    // 直近2ターンのツール結果は生データのまま
    expect(resultLines[5]).toBe(lines[5]);
    expect(resultLines[7]).toBe(lines[7]);
  });

  it("protects everything when the transcript has fewer assistants than keepLastAssistants", () => {
    const lines = [
      makeSessionHeader(),
      makeUserMessage("hello"),
      makeLargeToolResult("x".repeat(500)),
      makeAssistantMessage("a1"),
    ];
    const cfg: DennouSessionToolsPruneConfig = {
      ...defaultConfig,
      keepLastAssistants: 3,
      minPrunableToolChars: 100,
    };

    const { resultLines, prunedCount } = pruneToolOutputLines(lines, cfg, testLogger);

    expect(prunedCount).toBe(0);
    expect(resultLines[2]).toBe(lines[2]);
  });
});

// ── 正準プレースホルダー ──────────────────────────────

describe("canonical placeholder helpers", () => {
  it("buildCanonicalPlaceholder follows the canonical format", () => {
    expect(buildCanonicalPlaceholder({ lineCount: 120, sizeLabel: "3.4KB" })).toBe(
      "[出力省略: 120行 / 3.4KB 正常終了]",
    );
    expect(buildCanonicalPlaceholder({ lineCount: 1, sizeLabel: "500B", status: "エラー" })).toBe(
      "[出力省略: 1行 / 500B エラー]",
    );
  });

  it("formatPrunableSizeLabel renders human-readable sizes", () => {
    expect(formatPrunableSizeLabel(120)).toBe("120B");
    expect(formatPrunableSizeLabel(3_481)).toBe("3.4KB");
    expect(formatPrunableSizeLabel(15_360)).toBe("15KB");
    expect(formatPrunableSizeLabel(3_400_000)).toBe("3.2MB");
  });
});

/**
 * context-pruner プラグインの単体テスト
 *
 * 対象（COMPACTION_FEATURE.md Phase 1）:
 * - プレースホルダー化（正準フォーマット `[出力省略: {行数}行 / {サイズ} 正常終了]`）
 * - JSON構造・親子リンク（id / parentId / toolCallId / toolName / isError）の不破壊
 * - 直近3ターン保護（keepLastAssistants フェンス）
 * - 冪等性（二重置換防止）
 * - 50k cap（50,000文字超の安全弁）
 * - 重要キーワード保護 / エラー保持 / minPrunableToolChars / defaultPreserve
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  applyToolResultSafetyCap,
  buildMessagePlaceholder,
  hasPlaceholderMarkerInMessage,
  resolveContextPrunerConfig,
  TOOL_RESULT_SAFETY_CAP_CHARS,
  TOOL_RESULT_SAFETY_CAP_MARKER,
  TOOL_RESULT_SAFETY_CAP_HEAD_CHARS,
  TOOL_RESULT_SAFETY_CAP_TAIL_CHARS,
  transformToolResultForPersistence,
  type PruneDecision,
} from "../src/pruner.js";

// ── テスト用ヘルパー ──────────────────────────────────────

/** ツール結果メッセージの雛形（セッションJSONLの message 部分を模す） */
function makeToolResultMessage(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "read_file",
    isError: false,
    timestamp: 1_700_000_000_000,
    content: [{ type: "text", text: "x".repeat(2_000) }],
    ...overrides,
  };
}

/** セッションJSONLの1行エントリ全体（id / parentId を含む）を作る */
function makeJsonlEntry(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "message",
    id: "tr-123",
    parentId: "asst-45",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: makeToolResultMessage(),
    ...overrides,
  };
}

const DEFAULT_CONFIG = resolveContextPrunerConfig({
  enabled: true,
  keepLastAssistants: 3,
  minPrunableToolChars: 1200,
  defaultPreserve: false,
});

/** 2000文字のデフォルトメッセージで count=4（フェンス外）なら必ず対象になる条件 */
function assertPlaceholderized(decision: PruneDecision): void {
  expect(decision.placeholderized).toBe(true);
}

// ── resolveContextPrunerConfig ─────────────────────────────

describe("resolveContextPrunerConfig", () => {
  it("applies defaults when config is absent or malformed", () => {
    expect(resolveContextPrunerConfig(undefined)).toEqual({
      enabled: true,
      keepLastAssistants: 3,
      minPrunableToolChars: 1200,
      defaultPreserve: false,
    });
    expect(resolveContextPrunerConfig("garbage")).toEqual({
      enabled: true,
      keepLastAssistants: 3,
      minPrunableToolChars: 1200,
      defaultPreserve: false,
    });
  });

  it("clamps numeric values and passes through strings/booleans", () => {
    const cfg = resolveContextPrunerConfig({
      enabled: false,
      keepLastAssistants: -5,
      minPrunableToolChars: 1.9,
      defaultPreserve: true,
      placeholder: "  [custom]  ",
      protectedContentKeywords: ["AGENTS.md", 42],
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.keepLastAssistants).toBe(0);
    expect(cfg.minPrunableToolChars).toBe(1);
    expect(cfg.defaultPreserve).toBe(true);
    expect(cfg.placeholder).toBe("[custom]");
    expect(cfg.protectedContentKeywords).toEqual(["AGENTS.md"]);
  });
});

// ── プレースホルダー化 ────────────────────────────────────

describe("placeholder-ization", () => {
  it("replaces only content with the canonical placeholder format", () => {
    const message = makeToolResultMessage({
      content: [{ type: "text", text: "line1\nline2\n".repeat(100) }], // 800 chars per... 700 lines
    });
    const decision = transformToolResultForPersistence(message as never, DEFAULT_CONFIG, {
      assistantTurnCount: 4,
    });
    assertPlaceholderized(decision);

    const text = (decision.message as { content: { text: string }[] }).content[0]!.text;
    expect(text).toMatch(/^\[出力省略: \d+行 \/ [\d.]+[KMG]?B 正常終了\]$/);

    // 行数・サイズは元テキストから計算される（"line1\nline2\n"×100 = 1200 chars / 201行）
    const expectedLines = "line1\nline2\n".repeat(100).split("\n").length;
    expect(text).toBe(`[出力省略: ${expectedLines}行 / 1.2KB 正常終了]`);
  });

  it("keeps full JSONL structure (id, parentId, toolCallId, toolName, isError) intact", () => {
    const entry = makeJsonlEntry({
      message: makeToolResultMessage({
        toolCallId: "tc-xyz",
        toolName: "web_search",
      }),
    });
    // SESSION_INTEGRITY_GUARD 相当: エントリ全体を永続化→再パースして構造を検証する
    const decision = transformToolResultForPersistence(entry.message as never, DEFAULT_CONFIG, {
      assistantTurnCount: 10,
    });
    assertPlaceholderized(decision);

    const persisted = JSON.parse(JSON.stringify({ ...entry, message: decision.message }));
    expect(persisted.type).toBe("message");
    expect(persisted.id).toBe("tr-123");
    expect(persisted.parentId).toBe("asst-45");
    expect(persisted.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(persisted.message.role).toBe("toolResult");
    expect(persisted.message.toolCallId).toBe("tc-xyz");
    expect(persisted.message.toolName).toBe("web_search");
    expect(persisted.message.isError).toBe(false);
    expect(persisted.message.content).toHaveLength(1);
    expect(persisted.message.content[0].type).toBe("text");
    expect(persisted.message.content[0].text).toContain("[出力省略:");
  });

  it("keeps isError flag when placeholder-izing", () => {
    // isError の結果はそもそも置換しないが、万一対象になってもフラグは保持される前提の検証
    const message = makeToolResultMessage({ isError: true });
    const decision = transformToolResultForPersistence(message as never, DEFAULT_CONFIG, {
      assistantTurnCount: 10,
    });
    expect(decision.placeholderized).toBe(false);
    expect((decision.message as { isError: boolean }).isError).toBe(true);
  });
});

// ── 直近3ターン保護 ──────────────────────────────────────

describe("recent-turn protection (keepLastAssistants fence)", () => {
  it("keeps results raw while the observed assistant count is within keepLastAssistants", () => {
    for (const count of [0, 1, 2, 3]) {
      const message = makeToolResultMessage();
      const decision = transformToolResultForPersistence(message as never, DEFAULT_CONFIG, {
        assistantTurnCount: count,
      });
      expect(decision.placeholderized, `count=${count}`).toBe(false);
      expect(decision.message, `count=${count}`).toBe(message); // 無変換（同一参照）
    }
  });

  it("placeholder-izes oversized results once the fence is crossed", () => {
    const decision = transformToolResultForPersistence(
      makeToolResultMessage() as never,
      DEFAULT_CONFIG,
      { assistantTurnCount: 4 },
    );
    assertPlaceholderized(decision);
  });

  it("keeps results raw when keepLastAssistants is large enough", () => {
    const cfg = resolveContextPrunerConfig({ keepLastAssistants: 10 });
    const decision = transformToolResultForPersistence(makeToolResultMessage() as never, cfg, {
      assistantTurnCount: 7,
    });
    expect(decision.placeholderized).toBe(false);
  });

  it("prunes immediately when keepLastAssistants is 0", () => {
    const cfg = resolveContextPrunerConfig({ keepLastAssistants: 0 });
    const decision = transformToolResultForPersistence(makeToolResultMessage() as never, cfg, {
      assistantTurnCount: 0,
    });
    assertPlaceholderized(decision);
  });
});

// ── 冪等性 ──────────────────────────────────────────────

describe("idempotency (double-prune guard)", () => {
  it("does not re-placeholder canonical entries", () => {
    const message = makeToolResultMessage({
      content: [{ type: "text", text: "[出力省略: 500行 / 15KB 正常終了]" }],
    });
    const decision = transformToolResultForPersistence(message as never, DEFAULT_CONFIG, {
      assistantTurnCount: 99,
    });
    expect(decision.placeholderized).toBe(false);
    expect(decision.message).toBe(message);
  });

  it("does not re-placeholder legacy OpenClaw entries", () => {
    const message = makeToolResultMessage({
      content: [{ type: "text", text: "[Old tool output cleared — re-run if needed]" }],
    });
    const decision = transformToolResultForPersistence(message as never, DEFAULT_CONFIG, {
      assistantTurnCount: 99,
    });
    expect(decision.placeholderized).toBe(false);
    expect(decision.message).toBe(message);
  });

  it("detects placeholder markers in multi-block content", () => {
    const message = makeToolResultMessage({
      content: [
        { type: "text", text: "prefix" },
        { type: "text", text: "[出力省略: 1行 / 1KB 正常終了]" },
      ],
    });
    expect(hasPlaceholderMarkerInMessage(message as never)).toBe(true);
  });
});

// ── 50k cap（安全弁）──────────────────────────────────

describe("50k safety cap", () => {
  it("truncates to head 25k + tail 25k with the marker for oversized outputs", () => {
    const text = "A".repeat(30_000) + "B".repeat(40_000);
    const message = makeToolResultMessage({ content: [{ type: "text", text }] });
    const decision = transformToolResultForPersistence(
      message as never,
      DEFAULT_CONFIG,
      { assistantTurnCount: 2 }, // フェンス内 → cap のみ適用される
    );

    expect(decision.capped).toBe(true);
    expect(decision.placeholderized).toBe(false);
    const out = (decision.message as { content: { text: string }[] }).content[0]!.text;
    expect(out).toContain(TOOL_RESULT_SAFETY_CAP_MARKER);
    const [head, tail] = out.split(TOOL_RESULT_SAFETY_CAP_MARKER);
    expect(head).toBe("A".repeat(30_000).slice(0, TOOL_RESULT_SAFETY_CAP_HEAD_CHARS));
    expect(tail).toBe("B".repeat(40_000).slice(-TOOL_RESULT_SAFETY_CAP_TAIL_CHARS));
  });

  it("does not alter messages under the cap", () => {
    const message = makeToolResultMessage();
    expect(applyToolResultSafetyCap(message as never)).toBe(message);
  });

  it("caps before placeholder-izing (placeholders report the original size)", () => {
    const text = "C".repeat(TOOL_RESULT_SAFETY_CAP_CHARS + 5_000);
    const message = makeToolResultMessage({ content: [{ type: "text", text }] });
    const decision = transformToolResultForPersistence(message as never, DEFAULT_CONFIG, {
      assistantTurnCount: 5,
    });
    expect(decision.capped).toBe(true);
    expect(decision.placeholderized).toBe(true);
    const out = (decision.message as { content: { text: string }[] }).content[0]!.text;
    // 正準プレースホルダー（元テキスト55,000文字 → 53.7KB）
    expect(out).toBe("[出力省略: 1行 / 53.7KB 正常終了]");
    // JSON構造は保持されている
    expect((decision.message as { toolCallId: string }).toolCallId).toBe("tc-1");
    expect((decision.message as { toolName: string }).toolName).toBe("read_file");
    expect((decision.message as { isError: boolean }).isError).toBe(false);
  });
});

// ── 保護ルール（キーワード / エラー / 閾値 / preserve）──

describe("protection rules", () => {
  it("never prunes error results", () => {
    const message = makeToolResultMessage({
      isError: true,
      content: [{ type: "text", text: "B".repeat(5_000) }],
    });
    const decision = transformToolResultForPersistence(message as never, DEFAULT_CONFIG, {
      assistantTurnCount: 99,
    });
    expect(decision.placeholderized).toBe(false);
    expect(decision.capped).toBe(false);
  });

  it("keeps results below minPrunableToolChars raw", () => {
    const message = makeToolResultMessage({
      content: [{ type: "text", text: "short output" }],
    });
    const decision = transformToolResultForPersistence(message as never, DEFAULT_CONFIG, {
      assistantTurnCount: 99,
    });
    expect(decision.placeholderized).toBe(false);
  });

  it("protects results containing important keywords (config paths etc.)", () => {
    const message = makeToolResultMessage({
      content: [{ type: "text", text: "Here is the content of AGENTS.md: ...".repeat(50) }],
    });
    const decision = transformToolResultForPersistence(message as never, DEFAULT_CONFIG, {
      assistantTurnCount: 99,
    });
    expect(decision.placeholderized).toBe(false);
    expect(decision.message).toBe(message);
  });

  it("respects custom protectedContentKeywords from config", () => {
    const cfg = resolveContextPrunerConfig({ protectedContentKeywords: ["SECRET_ANCHOR"] });
    const message = makeToolResultMessage({
      content: [{ type: "text", text: "SECRET_ANCHOR configuration dump".repeat(30) }],
    });
    const decision = transformToolResultForPersistence(message as never, cfg, {
      assistantTurnCount: 99,
    });
    expect(decision.placeholderized).toBe(false);
  });

  it("keeps raw when defaultPreserve is true", () => {
    const cfg = resolveContextPrunerConfig({ defaultPreserve: true });
    const message = makeToolResultMessage({ content: [{ type: "text", text: "x".repeat(5_000) }] });
    const decision = transformToolResultForPersistence(message as never, cfg, {
      assistantTurnCount: 99,
    });
    expect(decision.placeholderized).toBe(false);
  });

  it("is a no-op when the plugin is disabled", () => {
    const cfg = resolveContextPrunerConfig({ enabled: false });
    const message = makeToolResultMessage();
    const decision = transformToolResultForPersistence(message as never, cfg, {
      assistantTurnCount: 99,
    });
    expect(decision.placeholderized).toBe(false);
    expect(decision.message).toBe(message);
  });

  it("ignores non-toolResult messages", () => {
    const user = { role: "user", content: [{ type: "text", text: "hello" }] };
    const decision = transformToolResultForPersistence(user as never, DEFAULT_CONFIG, {
      assistantTurnCount: 99,
    });
    expect(decision.placeholderized).toBe(false);
    expect(decision.message).toBe(user);
  });
});

// ── プレースホルダー補助 ──────────────────────────────

describe("buildMessagePlaceholder", () => {
  it("counts lines and renders size from the original text", () => {
    const message = makeToolResultMessage({
      content: [{ type: "text", text: "a\nb\nc\nd" }],
    });
    const placeholder = buildMessagePlaceholder(message as never);
    expect(placeholder).toBe("[出力省略: 4行 / 7B 正常終了]");
  });

  it("prefers a custom placeholder when configured", () => {
    const message = makeToolResultMessage();
    expect(buildMessagePlaceholder(message as never, "[pruned]")).toBe("[pruned]");
  });

  it("treats placeholder markers as idempotent signals", () => {
    const message = makeToolResultMessage({
      content: [{ type: "text", text: "[出力省略: 1行 / 1B]" }],
    });
    // マーカーを含むなら既にプレースホルダー済みとみなす
    expect(hasPlaceholderMarkerInMessage(message as never)).toBe(true);
  });
});

// ── resolve 済み config を使った統合シナリオ ────────────

describe("integration scenarios", () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
  });

  it("handles a long session where only the last 3 turns stay raw", () => {
    // カウンタがフェンスを超えたら、以降の大きめの結果はプレースホルダー化される
    const seen: string[] = [];
    for (let turn = 1; turn <= 6; turn++) {
      const decision = transformToolResultForPersistence(
        makeToolResultMessage({
          toolCallId: `tc-${turn}`,
          content: [{ type: "text", text: "T".repeat(2_000) }],
        }) as never,
        DEFAULT_CONFIG,
        { assistantTurnCount: turn },
      );
      seen.push(decision.placeholderized ? "pruned" : "raw");
    }
    expect(seen).toEqual(["raw", "raw", "raw", "pruned", "pruned", "pruned"]);
  });
});

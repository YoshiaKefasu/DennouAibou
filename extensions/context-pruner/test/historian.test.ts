/**
 * context-pruner — 裏方要約（Historian）・章立て要約目次差し替えの単体テスト
 *
 * 対象（COMPACTION_FEATURE.md §7.2 / §7.5 / 裏方圧縮 ステップ 3）:
 * - ブロック要約の生成（reconcileBlockSummaries）と目次フォーマット（formatTableOfContents）
 * - 未要約ブロックが古い順に小分け（maxBatches）で順次要約されること
 * - 要約済みブロックのキャッシュ維持（冪等性）と失敗ブロックの自己回復（次回再試行）
 * - applyPromptEvictionSafetyValve に要約を渡した際、退避された過去ブロックが
 *   生データから「章立て要約目次（role: "user"）」へ差し替えられ、
 *   直近 250K は一切削られず保持されること
 * - 未要約ブロックが残る場合は一時退避注記の併記
 * - セッションファイルへの I/O が発生しない純粋なインメモリ差し替え（入力不変）
 *
 * トークン推定の約束（compartment.ts と同じ）: 約4文字 = 1トークン。
 * テストは軽量にするため、オプションで小さな閾値・保護ウィンドウを指定する。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { type HistoryBlock } from "../src/compartment.js";
import { applyPromptEvictionSafetyValve, DEFAULT_EVICTION_NOTICE } from "../src/eviction.js";
import {
  formatTableOfContents,
  reconcileBlockSummaries,
  TABLE_OF_CONTENTS_HEADER,
  TABLE_OF_CONTENTS_REVERSIBILITY_NOTE,
  type BlockSummary,
  type SummarizeFn,
} from "../src/historian.js";

// ── テスト用ヘルパー ──────────────────────────────────────

const MINUTE_MS = 60 * 1000;
const BASE_TIME = 1_700_000_000_000; // 任意の epoch ミリ秒
const SUMMARIZED_AT = 1_700_000_000_999;

type MessageFixture = Record<string, unknown>;

function castMessages(messages: MessageFixture[]): AgentMessage[] {
  return messages as unknown as AgentMessage[];
}

/** tokensPerMessage トークン（4文字 ≈ 1トークン）の user メッセージを1分間隔で count 件作る。 */
function makeUserMessages(
  count: number,
  tokensPerMessage: number,
  startIndex = 0,
): MessageFixture[] {
  return Array.from({ length: count }, (_unused, i) => ({
    role: "user",
    content: "x".repeat(tokensPerMessage * 4),
    timestamp: BASE_TIME + (startIndex + i) * MINUTE_MS,
  }));
}

/** メッセージ配列の範囲を表す HistoryBlock の雛形（compartment.ts の出力と同形）。 */
function makeBlock(
  id: string,
  startIndex: number,
  endIndex: number,
  tokensPerMessage: number,
): HistoryBlock {
  return {
    id,
    startIndex,
    endIndex,
    messageCount: endIndex - startIndex + 1,
    startTime: BASE_TIME + startIndex * MINUTE_MS,
    endTime: BASE_TIME + endIndex * MINUTE_MS,
    tokenCount: (endIndex - startIndex + 1) * tokensPerMessage,
  };
}

/** BlockSummary の雛形（元ブロックの時刻・トークン数を引き継ぐ）。 */
function makeSummary(block: HistoryBlock, title: string, summary: string): BlockSummary {
  return {
    blockId: block.id,
    title,
    summary,
    startTime: block.startTime,
    endTime: block.endTime,
    tokenCount: block.tokenCount,
    summarizedAt: SUMMARIZED_AT,
  };
}

/** 常に成功する要約関数の雛形（呼び出し内容の検証用に vi.fn で包む）。 */
function makeAlwaysOkSummarizeFn(): ReturnType<typeof vi.fn<SummarizeFn>> {
  return vi.fn<SummarizeFn>(async (block, slice) => ({
    blockId: block.id,
    title: `${block.id} の要約`,
    summary: `${slice.length} 件のメッセージを要約`,
    startTime: block.startTime,
    endTime: block.endTime,
    tokenCount: block.tokenCount,
    summarizedAt: SUMMARIZED_AT,
  }));
}

/** 退避テスト用シナリオ: past1(250) + past2(250) + recent(250) = 合計 750 トークン。 */
function makeEvictionScenario(): {
  input: AgentMessage[];
  past1: MessageFixture[];
  past2: MessageFixture[];
  recent: MessageFixture[];
  block1: HistoryBlock;
  block2: HistoryBlock;
  blockRecent: HistoryBlock;
} {
  const past1 = makeUserMessages(50, 5, 0); // block-1 [0..49] = 250 トークン
  const past2 = makeUserMessages(50, 5, 50); // block-2 [50..99] = 250 トークン
  const recent = makeUserMessages(10, 25, 100); // 直近 [100..109] = 250 トークン
  return {
    input: castMessages([...past1, ...past2, ...recent]),
    past1,
    past2,
    recent,
    block1: makeBlock("block-1", 0, 49, 5),
    block2: makeBlock("block-2", 50, 99, 5),
    blockRecent: makeBlock("block-recent", 100, 109, 25),
  };
}

// ── 目次フォーマット: formatTableOfContents ───────────────

describe("formatTableOfContents", () => {
  it("renders an empty summary list as the header plus a no-chapters note", () => {
    const toc = formatTableOfContents([]);
    expect(toc).toContain(TABLE_OF_CONTENTS_HEADER);
    expect(toc).toContain("要約済みの章はまだありません");
  });

  it("renders chapters in start-time order with title, id, range, size, and summary body", () => {
    const toc = formatTableOfContents([
      makeSummary(blockFixture(50, 99, "block-2"), "夜のバグ修正", "3件のバグを修正した。"),
      makeSummary(
        blockFixture(0, 49, "block-1"),
        "午前の設計検討",
        "アーキテクチャの設計を検討した。",
      ),
    ]);
    const lines = toc.split("\n");
    expect(lines[0]).toBe(TABLE_OF_CONTENTS_HEADER);
    // 開始時刻順に決定的に整列される（入力順ではない）
    expect(toc.indexOf("第1章: 午前の設計検討")).toBeLessThan(toc.indexOf("第2章: 夜のバグ修正"));
    expect(toc).toContain("（block-1）");
    expect(toc).toContain("（block-2）");
    expect(toc).toContain("- 期間: ");
    expect(toc).toContain("→");
    expect(toc).toContain("約 500 トークン");
    expect(toc).toContain("- 要約: アーキテクチャの設計を検討した。");
    expect(toc).toContain(TABLE_OF_CONTENTS_REVERSIBILITY_NOTE);
  });

  it("keeps ISO-string start/end times as-is", () => {
    const summary = {
      ...makeSummary(blockFixture(0, 9, "block-1"), "t", "s"),
      startTime: "2026-09-01T10:00:00.000Z",
      endTime: "2026-09-01T12:00:00.000Z",
    };
    expect(formatTableOfContents([summary])).toContain(
      "2026-09-01T10:00:00.000Z → 2026-09-01T12:00:00.000Z",
    );
  });

  it("does not mutate the input array", () => {
    const input = [
      makeSummary(blockFixture(50, 99, "block-2"), "b", "s"),
      makeSummary(blockFixture(0, 49, "block-1"), "a", "s"),
    ];
    const snapshot = [...input];
    formatTableOfContents(input);
    expect(input).toEqual(snapshot);
  });
});

/** ローカル用: 表示順の検証に必要なブロック雛形だけを作る（times は不問）。 */
function blockFixture(startIndex: number, endIndex: number, id: string): HistoryBlock {
  return makeBlock(id, startIndex, endIndex, 10);
}

// ── 要約の生成と蓄積: reconcileBlockSummaries ─────────────

describe("reconcileBlockSummaries", () => {
  const blocks = [
    makeBlock("block-1", 0, 99, 10),
    makeBlock("block-2", 100, 199, 10),
    makeBlock("block-3", 200, 299, 10),
  ];
  const messages = castMessages(makeUserMessages(300, 10));

  it("summarizes every unsummarized block in chronological order with its message slice", async () => {
    const summarizeFn = makeAlwaysOkSummarizeFn();
    const result = await reconcileBlockSummaries({
      blocks: [blocks[2], blocks[0], blocks[1]], // 入力順が不揃いでも古い順に処理される
      messages,
      existingSummaries: new Map(),
      summarizeFn,
    });

    expect(summarizeFn).toHaveBeenCalledTimes(3);
    expect([...result.keys()]).toEqual(["block-1", "block-2", "block-3"]);
    // 各ブロックには実メッセージ列がスライスで渡る（参照一致）
    expect(summarizeFn.mock.calls[0]?.[1]).toHaveLength(100);
    expect(summarizeFn.mock.calls[0]?.[1]?.[0]).toBe(messages[0]);
    expect(summarizeFn.mock.calls[1]?.[1]?.[0]).toBe(messages[100]);
    expect(summarizeFn.mock.calls[2]?.[1]?.[0]).toBe(messages[200]);
  });

  it("summarizes unsummarized blocks in small batches (maxBatches) across repeated calls", async () => {
    const summarizeFn = makeAlwaysOkSummarizeFn();
    const first = await reconcileBlockSummaries({
      blocks,
      messages,
      existingSummaries: new Map(),
      summarizeFn,
      maxBatches: 1,
    });
    expect([...first.keys()]).toEqual(["block-1"]);

    const second = await reconcileBlockSummaries({
      blocks,
      messages,
      existingSummaries: first,
      summarizeFn,
      maxBatches: 1,
    });
    expect([...second.keys()]).toEqual(["block-1", "block-2"]);

    const third = await reconcileBlockSummaries({
      blocks,
      messages,
      existingSummaries: second,
      summarizeFn,
      maxBatches: 1,
    });
    expect([...third.keys()]).toEqual(["block-1", "block-2", "block-3"]);
    expect(summarizeFn).toHaveBeenCalledTimes(3); // 各ブロックは一度だけ要約される
  });

  it("keeps existing summaries without recomputing them (idempotency)", async () => {
    const cached1 = makeSummary(blocks[0], "既に要約済み1", "このまま維持される");
    const cached2 = makeSummary(blocks[1], "既に要約済み2", "このまま維持される");
    const existingSummaries = new Map([
      [blocks[0].id, cached1],
      [blocks[1].id, cached2],
    ]);
    const summarizeFn = makeAlwaysOkSummarizeFn();

    const result = await reconcileBlockSummaries({
      blocks,
      messages,
      existingSummaries,
      summarizeFn,
    });

    expect(summarizeFn).toHaveBeenCalledTimes(1); // block-3 のみ要約
    expect(result.get("block-1")).toBe(cached1); // 同一オブジェクトのまま維持
    expect(result.get("block-2")).toBe(cached2);
    expect(result.get("block-3")?.blockId).toBe("block-3");
  });

  it("skips a block whose summarization fails and retries it on the next pass", async () => {
    let block2Attempts = 0;
    const summarizeFn = vi.fn<SummarizeFn>(async (block) => {
      if (block.id === "block-2") {
        block2Attempts += 1;
        if (block2Attempts === 1) {
          throw new Error("summarizer overloaded");
        }
      }
      return makeSummary(block, block.id, "ok");
    });

    const first = await reconcileBlockSummaries({
      blocks,
      messages,
      existingSummaries: new Map(),
      summarizeFn,
    });
    expect([...first.keys()]).toEqual(["block-1", "block-3"]); // 失敗ブロックは未要約のまま
    expect(first.has("block-2")).toBe(false);

    // 次回パスで block-2 が再試行される（自己回復。キー順は既存キャッシュ＋新規追加）
    const second = await reconcileBlockSummaries({
      blocks,
      messages,
      existingSummaries: first,
      summarizeFn,
    });
    expect([...second.keys()].sort()).toEqual(["block-1", "block-2", "block-3"]);
    expect(second.get("block-2")?.summary).toBe("ok");
    expect(block2Attempts).toBe(2); // 1回目は失敗、2回目で成功
  });

  it("normalizes the returned blockId to the source block id", async () => {
    const summarizeFn = vi.fn<SummarizeFn>(async (block) => ({
      blockId: "evil-id",
      title: "t",
      summary: "s",
      startTime: block.startTime,
      endTime: block.endTime,
      tokenCount: block.tokenCount,
      summarizedAt: SUMMARIZED_AT,
    }));
    const result = await reconcileBlockSummaries({
      blocks,
      messages,
      existingSummaries: new Map(),
      summarizeFn,
    });
    expect(result.has("block-1")).toBe(true);
    expect(result.has("evil-id")).toBe(false);
    expect(result.get("block-1")?.blockId).toBe("block-1");
  });
});

// ── 一時退避安全弁との統合: 章立て要約目次への差し替え ──

describe("applyPromptEvictionSafetyValve with historian summaries", () => {
  const { input, recent, block1, block2, blockRecent } = makeEvictionScenario();
  const summary1 = makeSummary(block1, "午前の設計検討", "アーキテクチャの設計を検討した。");
  const summary2 = makeSummary(block2, "夜のバグ修正", "3件のバグを修正した。");
  // 合計 750 トークン > 閾値 500。保護 250 → 境界は index 100（ブロック境界と一致）

  it("replaces fully-evicted summarized blocks with the TOC message and keeps the recent 250K byte-for-byte", () => {
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 500,
      protectedRecentTokens: 250,
      summaries: [summary2, summary1], // 順不同でも開始時刻順に整形される
    });

    expect(result.evicted).toBe(true);
    expect(result.appliedSummaryCount).toBe(2);
    expect(result.evictedMessageCount).toBe(100);
    expect(result.evictedTokens).toBe(500);
    expect(result.protectedTokens).toBe(250);

    // 先頭は章立て要約目次メッセージ（role: "user"）
    expect(result.messages).toHaveLength(1 + recent.length);
    const toc = result.messages[0] as { role?: unknown; content?: unknown };
    expect(toc.role).toBe("user");
    const tocText = toc.content as string;
    expect(tocText).toContain(TABLE_OF_CONTENTS_HEADER);
    expect(tocText.indexOf("第1章: 午前の設計検討")).toBeLessThan(
      tocText.indexOf("第2章: 夜のバグ修正"),
    );
    expect(tocText).toContain("（block-1）");
    expect(tocText).toContain("（block-2）");
    expect(tocText).toContain("約 250 トークン");

    // 全退避分が要約済み: 一時退避注記は併記されない
    for (const message of result.messages) {
      expect((message as { content?: unknown }).content).not.toBe(DEFAULT_EVICTION_NOTICE);
    }

    // 直近 250K（recent）は「同一オブジェクト参照」のまま完全保持（1文字も削られない）
    for (let i = 0; i < recent.length; i++) {
      expect(result.messages[i + 1]).toBe(recent[i]);
    }
    // 過去の生メッセージはプロンプト上から消えている（目次へ差し替え）
    for (const message of [...makeEvictionScenario().past1, ...makeEvictionScenario().past2]) {
      expect(result.messages.includes(message as unknown as AgentMessage)).toBe(false);
    }
  });

  it("keeps the temporary eviction notice alongside the TOC while some evicted blocks are not summarized", () => {
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 500,
      protectedRecentTokens: 250,
      summaries: [summary1], // block-2 は未要約のまま
    });

    expect(result.appliedSummaryCount).toBe(1);
    expect(result.messages).toHaveLength(2 + recent.length);
    const tocText = (result.messages[0] as { content?: string }).content ?? "";
    expect(tocText).toContain("第1章: 午前の設計検討");
    expect(tocText).not.toContain("第2章");
    expect((result.messages[1] as { content?: unknown }).content).toBe(DEFAULT_EVICTION_NOTICE);
    for (let i = 0; i < recent.length; i++) {
      expect(result.messages[i + 2]).toBe(recent[i]);
    }
  });

  it("never replaces blocks inside the protected recent window even if a summary exists", () => {
    const recentSummary = makeSummary(blockRecent, "最新の検討", "現在進行形の議論。");
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 500,
      protectedRecentTokens: 250,
      summaries: [recentSummary], // 直近 250K 内のブロックの要約は適用されない
    });

    expect(result.appliedSummaryCount).toBe(0);
    expect(result.messages).toHaveLength(1 + recent.length);
    expect((result.messages[0] as { content?: unknown }).content).toBe(DEFAULT_EVICTION_NOTICE);
    expect((result.messages[0] as { content?: string }).content ?? "").not.toContain(
      TABLE_OF_CONTENTS_HEADER,
    );
    for (let i = 0; i < recent.length; i++) {
      expect(result.messages[i + 1]).toBe(recent[i]);
    }
  });

  it("accepts summaries via a blockId-keyed map (reconcileBlockSummaries output shape)", () => {
    const summaryMap = new Map<string, BlockSummary>([
      ["block-1", summary1],
      ["block-2", summary2],
    ]);
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 500,
      protectedRecentTokens: 250,
      summaryMap,
    });

    expect(result.appliedSummaryCount).toBe(2);
    const tocText = (result.messages[0] as { content?: string }).content ?? "";
    expect(tocText).toContain("第1章: 午前の設計検討");
    expect(tocText).toContain("第2章: 夜のバグ修正");
    for (let i = 0; i < recent.length; i++) {
      expect(result.messages[i + 1]).toBe(recent[i]);
    }
  });

  it("skips TOC injection when the kept-tail boundary timestamp is unparseable (safe side)", () => {
    // 保持テール先頭（index 100）のタイムスタンプだけを解釈不能な値へ差し替えたコピー
    const swapped = [
      ...input.slice(0, 100),
      { ...(input[100] as unknown as Record<string, unknown>), timestamp: "n/a" },
      ...input.slice(101),
    ] as unknown as AgentMessage[];
    const result = applyPromptEvictionSafetyValve(swapped, {
      evictionThresholdTokens: 500,
      protectedRecentTokens: 250,
      summaries: [summary1, summary2],
    });

    expect(result.appliedSummaryCount).toBe(0);
    expect((result.messages[0] as { content?: unknown }).content).toBe(DEFAULT_EVICTION_NOTICE);
  });

  it("ignores summaries when the valve does not fire at all", () => {
    const small = castMessages(makeUserMessages(20, 4)); // 80 トークン ≤ 閾値 500
    const result = applyPromptEvictionSafetyValve(small, {
      evictionThresholdTokens: 500,
      protectedRecentTokens: 250,
      summaries: [summary1],
    });

    expect(result.evicted).toBe(false);
    expect(result.appliedSummaryCount).toBe(0);
    expect(result.messages).toBe(small);
  });

  it("keeps the legacy notice-only behavior when no summaries are provided", () => {
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 500,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(true);
    expect(result.appliedSummaryCount).toBe(0);
    expect(result.messages).toHaveLength(1 + recent.length);
    expect((result.messages[0] as { content?: unknown }).content).toBe(DEFAULT_EVICTION_NOTICE);
    for (let i = 0; i < recent.length; i++) {
      expect(result.messages[i + 1]).toBe(recent[i]);
    }
  });
});

// ── 純粋なインメモリ差し替え ──────────────────────────────

describe("in-memory table-of-contents replacement purity", () => {
  it("never mutates the input array or message objects (no session file I/O)", () => {
    const scenario = makeEvictionScenario();
    const input = scenario.input;
    const snapshot = [...input];
    const summary1 = makeSummary(scenario.block1, "午前の設計検討", "設計を検討。");
    const summary2 = makeSummary(scenario.block2, "夜のバグ修正", "バグを修正。");

    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 500,
      protectedRecentTokens: 250,
      summaries: [summary1, summary2],
    });

    // 入力配列は不変（同じ長さ・同じ参照・同じ順序）
    expect(result.evicted).toBe(true);
    expect(input).toHaveLength(snapshot.length);
    for (let i = 0; i < input.length; i++) {
      expect(input[i]).toBe(snapshot[i]);
    }
    // 結果のメッセージは「新規の先頭メッセージ（目次 / 注記）」または「元の参照」のみ
    for (let i = 2; i < result.messages.length; i++) {
      expect(snapshot.includes(result.messages[i])).toBe(true);
    }
    // 退避後も入力側の過去データはそのまま残っている（セッションファイル不変と同義）
    expect((scenario.past1[0] as { content?: unknown }).content).toContain("x");
    expect((scenario.past2[0] as { content?: unknown }).content).toContain("x");
  });
});

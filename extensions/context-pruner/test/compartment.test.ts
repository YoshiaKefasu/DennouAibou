/**
 * context-pruner — ブロック分割エンジン（compartment）の単体テスト
 *
 * 対象（COMPACTION_FEATURE.md §7.1 / §7.2 / 裏方圧縮 ステップ 1）:
 * - 時間認識（detectTemporalPauses）: 平均テンポ × pauseMultiplier かつ
 *   絶対フロア（既定30分）以上の「間（ま）」の検出
 * - ブロック分割（partitionHistoryBlocks）:
 *   - 均等テンポの会話では急な分割が起きない
 *   - 数時間の沈黙が空いたポイントで綺麗にブロックが切り分けられる
 *   - maxBlockTokens 上限手前の自然な「間」で分割される
 *   - 「間」が全く無い連続会話でも上限を超えずにフォールバック分割される
 *   - 空配列 / 1メッセージのみ / 単一メッセージのバジェット超過などのエッジケース
 */
import { describe, expect, it } from "vitest";
import {
  detectTemporalPauses,
  estimateMessageTokens,
  resolveMeasuredPromptTokens,
  partitionHistoryBlocks,
  type CompartmentMessage,
  type HistoryBlock,
} from "../src/compartment.js";

// ── テスト用ヘルパー ──────────────────────────────────────

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const BASE_TIME = 1_700_000_000_000; // 任意の epoch ミリ秒

/** tokensPerMessage トークン（4文字 ≈ 1トークン）のメッセージを intervalMs 間隔で count 件作る。 */
function makeEvenMessages(
  count: number,
  intervalMs = MINUTE_MS,
  tokensPerMessage = 4,
): CompartmentMessage[] {
  return Array.from({ length: count }, (_unused, i) => ({
    timestamp: BASE_TIME + i * intervalMs,
    content: "x".repeat(tokensPerMessage * 4),
  }));
}

/** 指定ギャップ（messages[g] と messages[g+1] の間）にだけ pauseMs の沈黙を入れる。 */
function withPauseAt(
  messages: CompartmentMessage[],
  gapIndex: number,
  pauseMs: number,
): CompartmentMessage[] {
  return messages.map((message, i) => {
    if (i !== gapIndex + 1) {
      return message;
    }
    return { ...message, timestamp: BASE_TIME + gapIndex * MINUTE_MS + pauseMs };
  });
}

/** ブロック群が messages[0..n-1] を連続して過不足なくカバーしているか検証する。 */
function expectBlocksCover(blocks: HistoryBlock[], messageCount: number): void {
  expect(blocks[0]?.startIndex).toBe(0);
  expect(blocks[blocks.length - 1]?.endIndex).toBe(messageCount - 1);
  for (let k = 0; k < blocks.length; k++) {
    const block = blocks[k];
    expect(block.messageCount).toBe(block.endIndex - block.startIndex + 1);
    if (k > 0) {
      expect(block.startIndex).toBe(blocks[k - 1].endIndex + 1);
    }
  }
}

// ── 時間認識: detectTemporalPauses ─────────────────────────

describe("detectTemporalPauses", () => {
  it("returns [] for empty, single-message, or unparseable timestamp inputs", () => {
    expect(detectTemporalPauses([])).toEqual([]);
    expect(detectTemporalPauses([{ timestamp: BASE_TIME, content: "hi" }])).toEqual([]);
    expect(detectTemporalPauses([{ timestamp: "not-a-date" }, { timestamp: "also-bad" }])).toEqual(
      [],
    );
  });

  it("returns [] when no gap clears the absolute floor (default 30 min)", () => {
    // 10分おきのテンポでも、3倍(30分) < 絶対フロア(30分) なので間は検出されない
    const messages = makeEvenMessages(10, 10 * MINUTE_MS);
    expect(detectTemporalPauses(messages)).toEqual([]);
  });

  it("detects a multi-hour silence as a pause (both floor and multiplier satisfied)", () => {
    const messages = withPauseAt(makeEvenMessages(10), 3, 50 * MINUTE_MS);
    expect(detectTemporalPauses(messages)).toEqual([3]);
  });

  it("requires the pause to clear mean-interval * multiplier with a custom floor", () => {
    // 平均 ≈ 2.2分で multiplier 3.0 → 閾値 ≈ 6.7分。絶対フロア 5分は下回る。
    // 10分のギャップは閾値を超え、3分のギャップは超えない。
    const messages = withPauseAt(
      withPauseAt(makeEvenMessages(10), 3, 3 * MINUTE_MS),
      6,
      10 * MINUTE_MS,
    );
    expect(detectTemporalPauses(messages, { minPauseThresholdMs: 5 * MINUTE_MS })).toEqual([6]);
  });

  it("treats number and ISO-string timestamps identically", () => {
    const numeric = withPauseAt(makeEvenMessages(10), 3, 50 * MINUTE_MS);
    const isoString = numeric.map((message) => ({
      timestamp: new Date(message.timestamp as number).toISOString(),
      content: message.content,
    }));
    expect(detectTemporalPauses(isoString)).toEqual(detectTemporalPauses(numeric));
  });

  it("skips unparseable timestamps and clock-skew gaps without crashing", () => {
    const messages: CompartmentMessage[] = [
      { timestamp: BASE_TIME },
      { timestamp: "garbage" },
      { timestamp: BASE_TIME + 10 * MINUTE_MS }, // 連鎖リセット後の有効な起点
      { timestamp: BASE_TIME + 1_000 }, // 時計戻り（負のインターバル）→ 除外
      { timestamp: BASE_TIME + 60 * MINUTE_MS },
    ];
    // 有効なインターバルは 50分（60分 - 10分）の1つ → 平均50分 →
    // 閾値 = max(150分, 30分) = 150分。50分 < 150分 なので「間」は検出されない
    // （クラッシュしないことの検証）。
    expect(detectTemporalPauses(messages)).toEqual([]);
  });
});

// ── ブロック分割: partitionHistoryBlocks ───────────────────

describe("token estimation", () => {
  it("weights Japanese characters at roughly one token each", () => {
    expect(estimateMessageTokens({ timestamp: BASE_TIME, content: "日本語" })).toBe(3);
    expect(estimateMessageTokens({ timestamp: BASE_TIME, content: "abcd" })).toBe(1);
  });

  it("accumulates provider usage across transcript entries", () => {
    expect(
      resolveMeasuredPromptTokens([
        { message: { usage: { input: 100, cacheRead: 20, output: 5 } } },
        { usage: { input: 200, cacheWrite: 30, output: 7 } },
      ]),
    ).toBe(230);
    expect(resolveMeasuredPromptTokens([{ content: "日本語" }])).toBeUndefined();
  });
});

describe("partitionHistoryBlocks", () => {
  it("returns a single block for an even-tempo conversation (no sudden splits)", () => {
    const messages = makeEvenMessages(10);
    const blocks = partitionHistoryBlocks(messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      id: "block-1",
      startIndex: 0,
      endIndex: 9,
      messageCount: 10,
      startTime: BASE_TIME,
      endTime: BASE_TIME + 9 * MINUTE_MS,
      tokenCount: 40,
    });
    expect(blocks[0].boundaryPauseMs).toBeUndefined();
    expectBlocksCover(blocks, 10);
  });

  it("cuts cleanly at a multi-hour silence", () => {
    // 60件 × 20トークン（合計1200 > バジェット1000）。29→30の間に3時間の沈黙。
    const messages = withPauseAt(makeEvenMessages(60, MINUTE_MS, 20), 29, 3 * HOUR_MS);
    const blocks = partitionHistoryBlocks(messages, { maxBlockTokens: 1000 });
    expect(blocks).toHaveLength(2);
    expect(blocks[0].endIndex).toBe(29);
    expect(blocks[1].startIndex).toBe(30);
    expect(blocks[1].boundaryPauseMs).toBe(3 * HOUR_MS);
    expect(blocks[0].tokenCount).toBe(600);
    expect(blocks[1].tokenCount).toBe(600);
    for (const block of blocks) {
      expect(block.tokenCount).toBeLessThanOrEqual(1000);
    }
    expectBlocksCover(blocks, 60);
  });

  it("splits at the natural pause just before maxBlockTokens (not at the hard limit)", () => {
    // バジェット1000。50件目（index 49, 累積1000）で満杯になるが、
    // 29→30の「間」が直近の自然な境界なのでそこ（index 29）で分割される。
    const messages = withPauseAt(makeEvenMessages(60, MINUTE_MS, 20), 29, 3 * HOUR_MS);
    const blocks = partitionHistoryBlocks(messages, { maxBlockTokens: 1000 });
    expect(blocks[0].endIndex).toBe(29); // ハードリミットの 49 ではない
    expect(blocks[0].tokenCount).toBe(600);
  });

  it("falls back to the safe boundary when no pause exists at all", () => {
    const messages = makeEvenMessages(300, MINUTE_MS, 4); // 300件 × 4トークン = 1200 > 1000
    const blocks = partitionHistoryBlocks(messages, { maxBlockTokens: 1000 });
    expect(blocks).toHaveLength(2);
    // フォールバック: 上限ギリギリ（250件 = 1000トークン）で分割
    expect(blocks[0].endIndex).toBe(249);
    expect(blocks[1].startIndex).toBe(250);
    expect(blocks[0].tokenCount).toBe(1000);
    expect(blocks[1].tokenCount).toBe(200);
    for (const block of blocks) {
      expect(block.tokenCount).toBeLessThanOrEqual(1000);
    }
    // フォールバック境界にも前ブロックとの沈黙は情報として載る（1分）
    expect(blocks[1].boundaryPauseMs).toBe(MINUTE_MS);
    expectBlocksCover(blocks, 300);
  });

  it("keeps the size ceiling even when the only pause sits too early", () => {
    // 40件 × 25トークン + 6件 × 50トークン = 1300 > 1000。pause は gap 0 のみ（早すぎる）。
    // gap 0 で切ると後続が 1025 > 1000 になるため、フォールバック分割が選ばれる。
    const messages: CompartmentMessage[] = [];
    for (let i = 0; i < 46; i++) {
      const tokens = i <= 39 ? 25 : 50;
      const timestamp = i === 0 ? BASE_TIME : BASE_TIME + (i - 1) * MINUTE_MS + 3 * HOUR_MS;
      messages.push({ timestamp, content: "x".repeat(tokens * 4) });
    }
    const blocks = partitionHistoryBlocks(messages, { maxBlockTokens: 1000 });
    expect(blocks).toHaveLength(2);
    expect(blocks[0].endIndex).toBe(39);
    expect(blocks[1].startIndex).toBe(40);
    for (const block of blocks) {
      expect(block.tokenCount).toBeLessThanOrEqual(1000);
    }
    expectBlocksCover(blocks, 46);
  });

  it("handles empty input and single-message input safely", () => {
    expect(partitionHistoryBlocks([])).toEqual([]);

    const single = partitionHistoryBlocks([{ timestamp: BASE_TIME, content: "hi" }]);
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({
      startIndex: 0,
      endIndex: 0,
      messageCount: 1,
      tokenCount: 1, // 2文字 → ceil(2/4) = 1トークン
    });
    expect(single[0].boundaryPauseMs).toBeUndefined();
  });

  it("isolates a single message that exceeds the budget into its own block", () => {
    // 1250トークンの巨大メッセージ + 10件 × 4トークン。巨大メッセージは単独ブロック化。
    const messages: CompartmentMessage[] = [
      { timestamp: BASE_TIME, content: "x".repeat(1250 * 4) },
      ...makeEvenMessages(10, MINUTE_MS, 4).map((message) => ({
        ...message,
        timestamp: (message.timestamp as number) + MINUTE_MS,
      })),
    ];
    const blocks = partitionHistoryBlocks(messages, { maxBlockTokens: 1000 });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ startIndex: 0, endIndex: 0, messageCount: 1 });
    expect(blocks[0].tokenCount).toBe(1250);
    expect(blocks[1].startIndex).toBe(1);
    expect(blocks[1].endIndex).toBe(10);
    expect(blocks[1].tokenCount).toBe(40);
    expectBlocksCover(blocks, 11);
  });

  it("still partitions positionally when timestamps are unparseable", () => {
    // 300件 × 4トークン（16文字） = 1200 > 1000。タイムスタンプは全て無効。
    const messages = Array.from({ length: 300 }, () => ({
      timestamp: "n/a",
      content: "x".repeat(16),
    }));
    const blocks = partitionHistoryBlocks(messages, { maxBlockTokens: 1000 });
    expect(blocks).toHaveLength(2); // フォールバック分割（位置ベースで動作）
    expect(blocks[0].tokenCount).toBe(1000);
    expect(blocks[1].tokenCount).toBe(200);
    expect(blocks[1].boundaryPauseMs).toBeUndefined();
    expectBlocksCover(blocks, 300);
  });

  it("works with ISO-string timestamps (session JSONL style)", () => {
    const messages = withPauseAt(makeEvenMessages(60, MINUTE_MS, 20), 29, 3 * HOUR_MS).map(
      (message) => ({
        timestamp: new Date(message.timestamp as number).toISOString(),
        content: message.content,
      }),
    );
    const blocks = partitionHistoryBlocks(messages, { maxBlockTokens: 1000 });
    expect(blocks).toHaveLength(2);
    expect(blocks[1].boundaryPauseMs).toBe(3 * HOUR_MS);
    expect(typeof blocks[0].startTime).toBe("string");
    expect(typeof blocks[1].endTime).toBe("string");
  });
});

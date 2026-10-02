/**
 * context-pruner — 一時退避安全弁（eviction）の単体テスト
 *
 * 対象（COMPACTION_FEATURE.md §7.3 / §7.4 / §7.5 / 裏方圧縮 ステップ 2）:
 * - 閾値（既定 1M 基準で 950K = 95%）以下では退避が発火せず全メッセージが保持される
 * - 閾値超過時に超過分だけを最古の章から1章ずつ段階的に退避（漸進的スライディング）し、
 *   直近保護テールが1文字も削られず完全保持される
 * - 退避時にシステム注記（role: "user" の notice message）が先頭に挿入される
 *   （注記は保護トークン数に応じた動的表記。1M で 128K、500K で 64K、200K で 16K）
 * - セッションファイルへの I/O を行わない純粋なインメモリ変換（入力配列・要素の不変）
 * - DENNOU_SKIP_EVICTION_SAFETY_VALVE=1 キルスイッチの判定
 * - compaction 設定（reserveTokens / keepRecentTokens）の EvictionOptions 反映
 * - toolCall/toolResult ペアリング整合性（保持テール先頭に孤児 toolResult を作らない）
 * - 時間認識（detectTemporalPauses / §7.1）による自然な境界での分割
 *
 * トークン推定の約束（compartment.ts と同じ）: 約4文字 = 1トークン。
 * テストは軽量にするため、オプションで小さな閾値・保護ウィンドウを指定する
 * （既定の 950K（1M 基準の 95%）/ スケーリングフロアそのものをメモリ上に構築する必要はない）。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  applyPromptEvictionSafetyValve,
  formatEvictionNotice,
  formatProtectedTokensLabel,
  isCompactionDisabled,
  isEvictionSafetyValveEnabled,
  resolveEvictionOptionsFromCompaction,
  resolveScaledEvictionThresholdTokens,
  resolveScaledProtectedRecentTokens,
  DEFAULT_EVICTION_NOTICE,
  DEFAULT_EVICTION_THRESHOLD_TOKENS,
  DEFAULT_PROTECTED_RECENT_TOKENS,
  type EvictionResult,
} from "../src/eviction.js";

// ── テスト用ヘルパー ──────────────────────────────────────

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const BASE_TIME = 1_700_000_000_000; // 任意の epoch ミリ秒

/** テストでは厳格な AssistantMessage / ToolResultMessage のフィールドを省いた雛形を使う。 */
type MessageFixture = Record<string, unknown>;

function castMessages(messages: MessageFixture[]): AgentMessage[] {
  return messages as unknown as AgentMessage[];
}

/** tokensPerMessage トークン（4文字 ≈ 1トークン）の user メッセージを intervalMs 間隔で count 件作る。 */
function makeEvenUserMessages(
  count: number,
  tokensPerMessage = 4,
  intervalMs = MINUTE_MS,
  startIndex = 0,
): MessageFixture[] {
  return Array.from({ length: count }, (_unused, i) => ({
    role: "user",
    content: "x".repeat(tokensPerMessage * 4),
    timestamp: BASE_TIME + (startIndex + i) * intervalMs,
  }));
}

/** 指定したギャップ（messages[g] と messages[g+1] の間）より後ろに pauseMs の沈黙を入れる。 */
function withSilenceAfter(
  messages: MessageFixture[],
  gapIndex: number,
  pauseMs: number,
): MessageFixture[] {
  return messages.map((message, i) =>
    i <= gapIndex ? message : { ...message, timestamp: (message.timestamp as number) + pauseMs },
  );
}

/** toolCall を含む assistant メッセージの雛形（textTokens トークン相当）。 */
function makeAssistantWithToolCall(
  toolCallId: string,
  textTokens = 1,
  timestamp = BASE_TIME,
): MessageFixture {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "x".repeat(textTokens * 4) },
      { type: "toolCall", id: toolCallId, name: "read_file", arguments: {} },
    ],
    timestamp,
  };
}

/** toolResult メッセージの雛形（tokens トークン相当）。 */
function makeToolResult(toolCallId: string, tokens: number, timestamp = BASE_TIME): MessageFixture {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read_file",
    content: [{ type: "text", text: "x".repeat(Math.max(4, tokens * 4)) }],
    isError: false,
    timestamp,
  };
}

/** 保持テール内の toolResult すべてに、対応する toolCall を持つ assistant が先行することを検証する。 */
function expectNoOrphanToolResults(messages: readonly AgentMessage[]): void {
  const pendingToolCallIds = new Set<string>();
  for (const message of messages) {
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") {
      const content = (message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            (block as { type?: unknown }).type === "toolCall" &&
            typeof (block as { id?: unknown }).id === "string"
          ) {
            pendingToolCallIds.add((block as { id: string }).id);
          }
        }
      }
    } else if (role === "toolResult") {
      const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
      expect(pendingToolCallIds.has(String(toolCallId))).toBe(true);
    }
  }
}

// ── 退避発火判定 ──────────────────────────────────────────

describe("applyPromptEvictionSafetyValve", () => {
  it("does not evict when total tokens are at or below the threshold", () => {
    // 80件 × 10トークン = 800トークン ≤ 閾値 1000
    const input = castMessages(makeEvenUserMessages(80, 10));
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(false);
    expect(result.messages).toBe(input); // 元の配列をそのまま返す
    expect(result.messages).toHaveLength(80);
    expect(result.evictedMessageCount).toBe(0);
    expect(result.evictedTokens).toBe(0);
    expect(result.protectedTokens).toBe(800);
    expect(result.totalTokens).toBe(800);
  });

  it("uses the default 950K threshold when no options are given", () => {
    const input = castMessages(makeEvenUserMessages(10, 4));
    const result = applyPromptEvictionSafetyValve(input);
    expect(result.evicted).toBe(false);
    expect(result.totalTokens).toBe(40);
    expect(DEFAULT_EVICTION_THRESHOLD_TOKENS).toBe(950_000);
  });

  it("evicts only the excess tokens, keeping the rest raw (no cliff drop)", () => {
    // 過去 100件 × 10トークン = 1000 + 直近 50件 × 5トークン = 250 → 合計 1250 > 1000
    // 超過分は 250 のみ。「間」も章境界も無いため最小メッセージ境界まで進め、
    // 先頭 25件（250トークン）だけを退避し残り 1000 トークンは生のまま保持する。
    // 一括崖落ち（100件退避で 250 まで急降下）はしない。
    const past = makeEvenUserMessages(100, 10);
    const recent = makeEvenUserMessages(50, 5, MINUTE_MS, 100);
    const input = castMessages([...past, ...recent]);
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(true);
    expect(result.totalTokens).toBe(1_250);
    expect(result.evictedMessageCount).toBe(25);
    expect(result.evictedTokens).toBe(250);
    expect(result.protectedTokens).toBe(1_000);
    expect(result.evictedTokens + result.protectedTokens).toBe(result.totalTokens);

    // 保持テール（result.messages[1..]）は元メッセージの「同一オブジェクト参照」。
    // コピー・再シリアライズが一切無い = 直近は1文字も削られていない。
    expect(result.messages).toHaveLength(1 + 125);
    expect(result.messages[1]).toBe(input[25]);
    for (let i = 0; i < 125; i++) {
      expect(result.messages[i + 1]).toBe(input[25 + i]);
    }
    // 退避された先頭 25件だけが結果に現れない（past の残りは生保持）
    for (let i = 0; i < 25; i++) {
      expect(result.messages.includes(past[i] as unknown as AgentMessage)).toBe(false);
    }
    for (let i = 25; i < past.length; i++) {
      expect(result.messages.includes(past[i] as unknown as AgentMessage)).toBe(true);
    }
  });

  it("keeps at least the protected window when it does not align to a block boundary", () => {
    // 過去 100件 × 8トークン = 800 + 直近 100件 × 3トークン = 300 → 合計 1100 > 1000
    // 超過分は 100 のみ。最小メッセージ境界は index 13（104トークン退避）。
    // 保持テール = 187件 (996トークン) ≥ 250 を下回らない。
    const past = makeEvenUserMessages(100, 8);
    const recent = makeEvenUserMessages(100, 3, MINUTE_MS, 100);
    const input = castMessages([...past, ...recent]);
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(true);
    expect(result.evictedMessageCount).toBe(13);
    expect(result.evictedTokens).toBe(104);
    expect(result.protectedTokens).toBe(996);
    expect(result.protectedTokens).toBeGreaterThanOrEqual(250);
    expect(result.messages[1]).toBe(input[13]);
    for (let i = 0; i < 187; i++) {
      expect(result.messages[i + 1]).toBe(input[13 + i]);
    }
  });

  it("prepends the system notice as a user-role message when eviction fires", () => {
    const input = castMessages([
      ...makeEvenUserMessages(100, 10),
      ...makeEvenUserMessages(50, 5, MINUTE_MS, 100),
    ]);
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(true);
    const [notice, ...kept] = result.messages;
    expect(Object.is(notice, input[0])).toBe(false); // 注記は新規メッセージ
    expect((notice as { role?: unknown }).role).toBe("user");
    // 保護 250 指定時は動的注記（formatEvictionNotice(250)）が付与される
    expect((notice as { content?: unknown }).content).toBe(formatEvictionNotice(250));
    expect(kept).toHaveLength(125); // 超過分 250 のみ退避し残り 1000 トークンを生保持
  });

  it("uses a dynamic notice matching the protected window (128K/64K/16K)", () => {
    expect(DEFAULT_EVICTION_NOTICE).toBe(formatEvictionNotice(128_000));
    expect(DEFAULT_EVICTION_NOTICE).toContain("128K");
    expect(formatEvictionNotice(64_000)).toContain("64K");
    expect(formatEvictionNotice(16_000)).toContain("16K");
    expect(formatProtectedTokensLabel(128_000)).toBe("128K");
    expect(formatProtectedTokensLabel(64_000)).toBe("64K");
    expect(formatProtectedTokensLabel(16_000)).toBe("16K");

    const input = castMessages([
      ...makeEvenUserMessages(100, 10),
      ...makeEvenUserMessages(50, 5, MINUTE_MS, 100),
    ]);
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 128_000,
    });
    // 超過分 250（1250 - 1000）では保護フロア 128K が全体を覆うため退避しない
    expect(result.evicted).toBe(false);

    const scaled = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 100,
      protectedRecentTokens: 500,
      // 実測 1250 相当でスケールし、保護 500 に対する動的注記を検証する
      measuredTotalTokens: 1_250,
    });
    expect(scaled.evicted).toBe(true);
    expect((scaled.messages[0] as { content?: unknown }).content).toBe(formatEvictionNotice(500));
    expect(formatEvictionNotice(500)).toContain("500");
  });

  it("honors a custom noticeText", () => {
    const input = castMessages([
      ...makeEvenUserMessages(100, 8),
      ...makeEvenUserMessages(100, 3, MINUTE_MS, 100),
    ]);
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
      noticeText: "[custom notice]",
    });
    expect((result.messages[0] as { content?: unknown }).content).toBe("[custom notice]");
  });

  it("does not prepend any notice when no eviction occurs", () => {
    const input = castMessages(makeEvenUserMessages(10, 4));
    const result = applyPromptEvictionSafetyValve(input);
    expect(result.messages).toBe(input);
    expect(result.messages[0]).toBe(input[0]);
  });

  it("uses measured usage before the local character estimate", () => {
    const input = castMessages(makeEvenUserMessages(10, 4));
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 90,
      protectedRecentTokens: 50,
      measuredTotalTokens: 101,
    });
    expect(result.evicted).toBe(true);
    expect(result.totalTokens).toBe(101);
    // 超過分 11 のみ退避（先頭 2件 = 20トークン）し、残り 81 を生保持
    expect(result.evictedMessageCount).toBe(2);
    expect(result.protectedTokens).toBe(81);
    expect(result.evictedTokens + result.protectedTokens).toBe(101);
  });

  it("uses the latest measured context usage supplied by transcript entries", () => {
    const input = castMessages([
      { role: "user", content: "x", timestamp: BASE_TIME },
      { role: "assistant", content: "x", timestamp: BASE_TIME + MINUTE_MS, usage: { input: 60 } },
      {
        role: "assistant",
        content: "x",
        timestamp: BASE_TIME + 2 * MINUTE_MS,
        usage: { input: 50 },
      },
    ]);
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 40,
      protectedRecentTokens: 1,
      measuredUsage: input,
    });
    expect(result.evicted).toBe(true);
    expect(result.totalTokens).toBe(50);
  });

  it("keeps a 250-token Japanese tail using CJK-aware estimates", () => {
    const past = makeEvenUserMessages(100, 1);
    const recent = Array.from({ length: 250 }, (_unused, i) => ({
      role: "user",
      content: "日",
      timestamp: BASE_TIME + (100 + i) * MINUTE_MS,
    }));
    const result = applyPromptEvictionSafetyValve(castMessages([...past, ...recent]), {
      evictionThresholdTokens: 100,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(true);
    expect(result.totalTokens).toBe(350);
    // 超過分 250 に届く最小境界は index 100（CJK 1件 = 1トークン）。
    // 保護フロア（index 100）と同点で切り、第2章以降（日本語 250件）は生保持。
    expect(result.evictedMessageCount).toBe(100);
    expect(result.protectedTokens).toBe(250);
    expect(result.messages[1]).toBe(recent[0]);
  });
});

// ── 人間らしい漸進的忘却（章単位スライディング退避）────────────────

describe("progressive chapter-by-chapter eviction", () => {
  it("evicts only the first chapter when it alone covers the excess", () => {
    // 第1章 100件 × 6トークン = 600 | 沈黙 | 第2章 50件 × 3トークン = 150 | 直近 100件 × 3トークン = 300
    // 合計 1050 > 1000。超過分 50 は第1章（600）だけで解消するため、
    // 第1章のみ退避し第2章以降は生メッセージのまま保持される。
    const chapter1 = makeEvenUserMessages(100, 6);
    const chapter2 = makeEvenUserMessages(50, 3, MINUTE_MS, 100);
    const recent = makeEvenUserMessages(100, 3, MINUTE_MS, 150);
    const input = castMessages(
      withSilenceAfter([...chapter1, ...chapter2, ...recent], 99, 3 * HOUR_MS),
    );

    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(true);
    expect(result.evictedMessageCount).toBe(100);
    expect(result.messages[1]).toBe(input[100]);
    expect(result.protectedTokens).toBe(450);
    // 第2章以降は生参照のまま残る（目次化されず退避もされない）
    for (let i = 100; i < input.length; i++) {
      expect(result.messages.includes(input[i])).toBe(true);
    }
    expectNoOrphanToolResults(result.messages);
  });

  it("slides to the second chapter only when the first chapter is not enough", () => {
    // 第1章 100件 × 1トークン = 100 | 沈黙 | 第2章 100件 × 3トークン = 300 | 沈黙 | 直近 100件 × 3トークン = 300
    // 合計 700 > 閾値 500。超過分 200 は第1章（100）だけでは届かず、
    // 第1章＋第2章（400）で初めて解消するため、cut は第2章終端（index 200）へ進む。
    const chapter1 = makeEvenUserMessages(100, 1);
    const chapter2 = makeEvenUserMessages(100, 3, MINUTE_MS, 100);
    const recent = makeEvenUserMessages(100, 3, MINUTE_MS, 200);
    const afterFirst = withSilenceAfter([...chapter1, ...chapter2, ...recent], 99, 3 * HOUR_MS);
    const input = castMessages(withSilenceAfter(afterFirst, 199, 3 * HOUR_MS));

    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 500,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(true);
    expect(result.evictedMessageCount).toBe(200);
    expect(result.messages[1]).toBe(input[200]);
    expect(result.protectedTokens).toBe(300);
    expect(result.protectedTokens).toBeGreaterThanOrEqual(250);
    expectNoOrphanToolResults(result.messages);
  });

  it("clamps a huge excess at the protected recent window instead of dropping below it", () => {
    // 合計 1250 に対し閾値 100（超過分 1150 > 退避可能最大 1000）。
    // 保護 250 のフロアは index 100。どんなに超過が大きくても cut は 100 を超えず、
    // 保持テールは 250 を下回らない。
    const past = makeEvenUserMessages(100, 10);
    const recent = makeEvenUserMessages(50, 5, MINUTE_MS, 100);
    const input = castMessages([...past, ...recent]);
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 100,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(true);
    expect(result.evictedMessageCount).toBe(100);
    expect(result.evictedTokens).toBe(1_000);
    expect(result.protectedTokens).toBe(250);
    expect(result.messages[1]).toBe(input[100]);
    expectNoOrphanToolResults(result.messages);
  });

  it("includes only evicted chapters in the TOC and keeps later chapters raw", () => {
    // 第1章（60件 × 10トークン = 600）は退避、第2章（40件 × 10トークン = 400）は生保持。
    // 目次には第1章の要約だけが含まれ、第2章の要約は含まれない。
    const chapter1 = makeEvenUserMessages(60, 10);
    const chapter2 = makeEvenUserMessages(40, 10, MINUTE_MS, 60);
    const input = castMessages(withSilenceAfter([...chapter1, ...chapter2], 59, 3 * HOUR_MS));
    const totalTokens = 1_000;
    const chapter1Summary = {
      blockId: "block-1",
      title: "第1章の設計",
      summary: "第1章の要約本文",
      startTime: BASE_TIME,
      endTime: BASE_TIME + 59 * MINUTE_MS,
      tokenCount: 600,
      summarizedAt: BASE_TIME + 61 * MINUTE_MS,
    };
    // 第2章の実タイムスタンプは沈黙（+3H）シフト後: 60分+3H 〜 99分+3H。
    // 保持テール先頭（index 60）より後に終わるため目次適用外 = 生保持される。
    const chapter2Summary = {
      blockId: "block-2",
      title: "第2章の実装",
      summary: "第2章の要約本文",
      startTime: BASE_TIME + 60 * MINUTE_MS + 3 * HOUR_MS,
      endTime: BASE_TIME + 99 * MINUTE_MS + 3 * HOUR_MS,
      tokenCount: 400,
      summarizedAt: BASE_TIME + 100 * MINUTE_MS + 3 * HOUR_MS,
    };

    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: totalTokens - 600,
      protectedRecentTokens: 250,
      summaries: [chapter1Summary, chapter2Summary],
    });

    expect(result.evicted).toBe(true);
    expect(result.evictedMessageCount).toBe(60);
    expect(result.appliedSummaryCount).toBe(1);
    // 先頭は目次（第1章のみ）。第2章の要約タイトルは目次に含まれない。
    const toc = result.messages[0] as { content?: unknown };
    expect(typeof toc.content).toBe("string");
    expect(String(toc.content)).toContain("第1章の設計");
    expect(String(toc.content)).not.toContain("第2章の実装");
    // 第2章は生メッセージのまま残る（退避側へ落ちない）
    expect(result.messages[1]).toBe(input[60]);
    for (let i = 60; i < input.length; i++) {
      expect(result.messages.includes(input[i])).toBe(true);
    }
  });
});

// ── 純粋なインメモリ変換 ──────────────────────────────────

describe("in-memory purity", () => {
  it("never mutates the input array or message objects (no session file I/O)", () => {
    const past = makeEvenUserMessages(100, 8);
    const recent = makeEvenUserMessages(100, 3, MINUTE_MS, 100);
    const input = castMessages([...past, ...recent]);
    const snapshot = [...input]; // 配列のスナップショット（参照のみ）

    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
    });

    // 入力配列は不変（同じ長さ・同じ参照・同じ順序）
    expect(result.evicted).toBe(true);
    expect(input).toHaveLength(snapshot.length);
    for (let i = 0; i < input.length; i++) {
      expect(input[i]).toBe(snapshot[i]);
    }
    // 結果の全メッセージは「元の参照」または「注記」のみ（コピー・再構築なし）
    for (let i = 1; i < result.messages.length; i++) {
      expect(snapshot.includes(result.messages[i])).toBe(true);
    }
    // 退避後も入力側のデータはそのまま残っている（セッションファイルを触らないのと同義）
    expect((past[0] as { content?: unknown }).content).toContain("x");
  });
});

// ── キルスイッチ ──────────────────────────────────────────

describe("isEvictionSafetyValveEnabled", () => {
  it("is enabled by default and only DENNOU_SKIP_EVICTION_SAFETY_VALVE=1 disables it", () => {
    expect(isEvictionSafetyValveEnabled(undefined)).toBe(true);
    expect(isEvictionSafetyValveEnabled({})).toBe(true);
    expect(isEvictionSafetyValveEnabled({ DENNOU_SKIP_EVICTION_SAFETY_VALVE: "0" })).toBe(true);
    expect(isEvictionSafetyValveEnabled({ DENNOU_SKIP_EVICTION_SAFETY_VALVE: "true" })).toBe(true);
    expect(isEvictionSafetyValveEnabled({ DENNOU_SKIP_EVICTION_SAFETY_VALVE: "1" })).toBe(false);
  });
});

// ── compaction 全体キルスイッチ ────────────────────────────

describe("isCompactionDisabled", () => {
  it("only treats an explicit enabled:false as disabled", () => {
    expect(isCompactionDisabled(undefined)).toBe(false);
    expect(isCompactionDisabled({})).toBe(false);
    expect(isCompactionDisabled({ enabled: true })).toBe(false);
    expect(isCompactionDisabled({ enabled: false })).toBe(true);
  });
});

// ── compaction 設定の反映 ──────────────────────────────────

describe("resolveEvictionOptionsFromCompaction", () => {
  it("falls back to the scaled threshold (95%) and protected floor when config is absent", () => {
    // Default base is 1M -> 950K threshold + 128K scaled floor.
    expect(resolveEvictionOptionsFromCompaction(undefined)).toEqual({
      evictionThresholdTokens: 950_000,
      protectedRecentTokens: 128_000,
    });
    expect(resolveEvictionOptionsFromCompaction({})).toEqual({
      evictionThresholdTokens: 950_000,
      protectedRecentTokens: 128_000,
    });
  });

  it("scales the eviction threshold to 95% of the model context (1M/500K/200K)", () => {
    expect(resolveScaledEvictionThresholdTokens(1_000_000)).toBe(950_000);
    expect(resolveScaledEvictionThresholdTokens(1_048_576)).toBe(996_147);
    expect(resolveScaledEvictionThresholdTokens(500_000)).toBe(475_000);
    expect(resolveScaledEvictionThresholdTokens(200_000)).toBe(190_000);
  });

  it("scales the protected floor by model context size (1M/500K/200K)", () => {
    expect(resolveScaledProtectedRecentTokens(1_048_576)).toBe(128_000);
    expect(resolveScaledProtectedRecentTokens(1_000_000)).toBe(128_000);
    expect(resolveScaledProtectedRecentTokens(524_288)).toBe(64_000);
    expect(resolveScaledProtectedRecentTokens(500_000)).toBe(64_000);
    expect(resolveScaledProtectedRecentTokens(200_000)).toBe(16_000);
    expect(resolveScaledProtectedRecentTokens(250_000)).toBe(16_000);
    // Below 200K: max(8K, base * 0.08).
    expect(resolveScaledProtectedRecentTokens(100_000)).toBe(8_000);
    expect(resolveScaledProtectedRecentTokens(50_000)).toBe(8_000);
    expect(resolveScaledProtectedRecentTokens(150_000)).toBe(12_000);
  });

  it("applies the scaled floor and 95% threshold for each base context size", () => {
    expect(resolveEvictionOptionsFromCompaction(undefined, 1_000_000)).toEqual({
      evictionThresholdTokens: 950_000,
      protectedRecentTokens: 128_000,
    });
    expect(resolveEvictionOptionsFromCompaction(undefined, 500_000)).toEqual({
      evictionThresholdTokens: 475_000,
      protectedRecentTokens: 64_000,
    });
    expect(resolveEvictionOptionsFromCompaction(undefined, 200_000)).toEqual({
      evictionThresholdTokens: 190_000,
      protectedRecentTokens: 16_000,
    });
  });

  it("prefers explicit keepRecentTokens over the scaled floor (threshold stays 95%)", () => {
    expect(resolveEvictionOptionsFromCompaction({ keepRecentTokens: 300_000 }, 1_000_000)).toEqual({
      evictionThresholdTokens: 950_000,
      protectedRecentTokens: 300_000,
    });
    expect(resolveEvictionOptionsFromCompaction({ keepRecentTokens: 300_000 })).toEqual({
      evictionThresholdTokens: 950_000,
      protectedRecentTokens: 300_000,
    });
  });

  it("maps reserveTokens to base - reserveTokens and keepRecentTokens to the protected window", () => {
    expect(resolveEvictionOptionsFromCompaction({ reserveTokens: 50_000 })).toEqual({
      evictionThresholdTokens: 950_000,
      protectedRecentTokens: 128_000,
    });
    expect(resolveEvictionOptionsFromCompaction({ keepRecentTokens: 300_000 })).toEqual({
      evictionThresholdTokens: 950_000,
      protectedRecentTokens: 300_000,
    });

    const both = resolveEvictionOptionsFromCompaction({
      reserveTokens: 50_000,
      keepRecentTokens: 300_000,
    });
    expect(both.evictionThresholdTokens).toBe(950_000);
    expect(both.evictionThresholdTokens).toBe(DEFAULT_EVICTION_THRESHOLD_TOKENS);
    expect(both.protectedRecentTokens).toBe(300_000);
    expect(DEFAULT_PROTECTED_RECENT_TOKENS).toBe(250_000);
  });

  it("ignores invalid values and clamps degenerate reserves", () => {
    // Invalid reserve/keepRecent falls back to the 95% threshold + scaled floor (1M base).
    expect(resolveEvictionOptionsFromCompaction({ reserveTokens: -1 })).toEqual({
      evictionThresholdTokens: 950_000,
      protectedRecentTokens: 128_000,
    });
    expect(resolveEvictionOptionsFromCompaction({ reserveTokens: Number.NaN })).toEqual({
      evictionThresholdTokens: 950_000,
      protectedRecentTokens: 128_000,
    });
    expect(resolveEvictionOptionsFromCompaction({ keepRecentTokens: 0 })).toEqual({
      evictionThresholdTokens: 950_000,
      protectedRecentTokens: 128_000,
    });
    expect(resolveEvictionOptionsFromCompaction({ keepRecentTokens: -5 })).toEqual({
      evictionThresholdTokens: 950_000,
      protectedRecentTokens: 128_000,
    });
    // reserve が基準コンテキストを超えても下限 1 にクランプする
    expect(resolveEvictionOptionsFromCompaction({ reserveTokens: 1_200_000 })).toEqual({
      evictionThresholdTokens: 1,
      protectedRecentTokens: 128_000,
    });
  });

  it("supports a custom base context size", () => {
    expect(resolveEvictionOptionsFromCompaction({ reserveTokens: 10_000 }, 200_000)).toEqual({
      evictionThresholdTokens: 190_000,
      protectedRecentTokens: 16_000,
    });
  });
});

// ── toolCall / toolResult ペアリング整合性 ─────────────────

describe("toolCall/toolResult pairing integrity", () => {
  it("extends the kept tail back to the assistant message when the boundary lands on a toolResult", () => {
    // 過去 5件 × 10トークン = 50 + assistant(toolCall) 1 + toolResult 60 + 直近 5件 × 10トークン = 50
    // 合計 161 > 閾値 110。超過分 51 に届く最小境界は toolResult（index 6）に落ちるため、
    // ペアリング調整で assistant メッセージまで保持テールが後退する。
    const past = makeEvenUserMessages(5, 10);
    const assistant = makeAssistantWithToolCall("tc-boundary", 1, BASE_TIME + 5 * MINUTE_MS);
    const toolResult = makeToolResult("tc-boundary", 60, BASE_TIME + 6 * MINUTE_MS);
    const recent = makeEvenUserMessages(5, 10, MINUTE_MS, 7);
    const input = castMessages([...past, assistant, toolResult, ...recent]);

    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 110,
      protectedRecentTokens: 50,
    });

    expect(result.evicted).toBe(true);
    expect(result.protectedTokens).toBe(1 + 60 + 50);
    // 保持テール先頭は toolResult ではなく、その toolCall を持つ assistant になる
    expect(result.messages[1]).toBe(assistant);
    expect(result.messages[2]).toBe(toolResult);
    expect((result.messages[1] as { role?: unknown }).role).toBe("assistant");
    // テール全体で孤児 toolResult が無い
    expectNoOrphanToolResults(result.messages);
  });

  it("drops a parentless orphan toolResult at the boundary instead of keeping it", () => {
    // 過去 110件 × 5トークン = 550 + 親の無い toolResult 250 + 直近 80件 × 3トークン = 240
    // 合計 1040 > 閾値 490。超過分 550 に届く最小境界は孤児 toolResult（index 110）に
    // 落ちるため、孤児ごと退避側へ切り落とす。
    const past = makeEvenUserMessages(110, 5);
    const orphan = makeToolResult("tc-orphan", 250, BASE_TIME + 110 * MINUTE_MS);
    const recent = makeEvenUserMessages(80, 3, MINUTE_MS, 111);
    const input = castMessages([...past, orphan, ...recent]);

    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 490,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(true);
    expect(result.evictedMessageCount).toBe(111); // 孤児 toolResult も退避側
    expect(result.messages.includes(orphan as unknown as AgentMessage)).toBe(false);
    expect(result.messages[1]).toBe(recent[0]);
    expectNoOrphanToolResults(result.messages);
  });
});

// ── 時間認識による自然な境界（§7.1）───────────────────────

describe("temporal-pause-aware boundary selection", () => {
  it("prefers the earliest chapter boundary that covers the excess", () => {
    // 過去 100件 × 6トークン = 600 | 3時間の沈黙 | 中盤 50件 × 3トークン = 150 | 直近 100件 × 3トークン = 300
    // 合計 1050 > 1000。超過分 50 に届く最初の章境界は沈黙直後（index 100）。
    // 最も新しい「間」ではなく、超過分を解消する最古の章境界を採用する。
    const old = makeEvenUserMessages(100, 6);
    const middle = makeEvenUserMessages(50, 3, MINUTE_MS, 100);
    const recent = makeEvenUserMessages(100, 3, MINUTE_MS, 150);
    // 沈黙は index 99 と 100 の間にだけ入り、以降（中盤＋直近）は元の1分間隔を保つ
    const input = castMessages(withSilenceAfter([...old, ...middle, ...recent], 99, 3 * HOUR_MS));

    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(true);
    expect(result.evictedMessageCount).toBe(100); // 沈黙の手前 (index 99) で分割
    expect(result.messages[1]).toBe(input[100]); // 中盤ブロックの先頭から保持
    expect(result.protectedTokens).toBe(150 + 300);
    expectNoOrphanToolResults(result.messages);
  });

  it("falls back to the minimal message boundary covering the excess when no pause exists", () => {
    const old = makeEvenUserMessages(100, 6);
    const middle = makeEvenUserMessages(50, 3, MINUTE_MS, 100);
    const recent = makeEvenUserMessages(100, 3, MINUTE_MS, 150);
    // 間隔はすべて1分 → detectTemporalPauses は「間」を検出しない
    const input = castMessages([...old, ...middle, ...recent]);

    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
    });

    // 超過分 50 に届く最小メッセージ境界 = index 9（9件 × 6トークン = 54）。
    // 保護フロア（index 166）より手前で止まり、残り 996 トークンを生保持する。
    expect(result.evicted).toBe(true);
    expect(result.evictedMessageCount).toBe(9);
    expect(result.messages[1]).toBe(input[9]);
    expect(result.evictedTokens).toBe(54);
    expect(result.protectedTokens).toBe(996);
    expect(result.protectedTokens).toBeGreaterThanOrEqual(250);
  });

  it("keeps the notice timestamp numeric and eviction result fields consistent", () => {
    const input = castMessages([
      ...makeEvenUserMessages(100, 8),
      ...makeEvenUserMessages(100, 3, MINUTE_MS, 100),
    ]);
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
    });
    const resultType: EvictionResult = result; // 型が EvictionResult であることを明示
    expect(typeof resultType.messages[0]?.timestamp).toBe("number");
    expect(resultType.evicted).toBe(true);
    // 超過分 100 に届く最小境界は index 13 のため、注記 + 187件保持
    expect(resultType.evictedMessageCount + resultType.messages.length - 1).toBe(200);
  });
});

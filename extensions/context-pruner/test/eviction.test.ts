/**
 * context-pruner — 一時退避安全弁（eviction）の単体テスト
 *
 * 対象（COMPACTION_FEATURE.md §7.3 / §7.4 / §7.5 / 裏方圧縮 ステップ 2）:
 * - 閾値（既定 950K）以下では退避が発火せず全メッセージが保持される
 * - 閾値超過時に「直近 250K」が1文字も削られず完全保持され、過去ブロックのみ一時退避
 * - 退避時にシステム注記（role: "user" の notice message）が先頭に挿入される
 * - セッションファイルへの I/O を行わない純粋なインメモリ変換（入力配列・要素の不変）
 * - DENNOU_SKIP_EVICTION_SAFETY_VALVE=1 キルスイッチの判定
 * - compaction 設定（reserveTokens / keepRecentTokens）の EvictionOptions 反映
 * - toolCall/toolResult ペアリング整合性（保持テール先頭に孤児 toolResult を作らない）
 * - 時間認識（detectTemporalPauses / §7.1）による自然な境界での分割
 *
 * トークン推定の約束（compartment.ts と同じ）: 約4文字 = 1トークン。
 * テストは軽量にするため、オプションで小さな閾値・保護ウィンドウを指定する
 * （既定の 950K / 250K そのものをメモリ上に構築する必要はない）。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  applyPromptEvictionSafetyValve,
  isEvictionSafetyValveEnabled,
  resolveEvictionOptionsFromCompaction,
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

  it("evicts only tokens older than the protected recent window (recent 250K kept byte-for-byte)", () => {
    // 過去 100件 × 10トークン = 1000 + 直近 50件 × 5トークン = 250 → 合計 1250 > 1000
    // 末尾から 250 トークンに達する最小境界 = index 100（直近ブロック先頭と一致）
    const past = makeEvenUserMessages(100, 10);
    const recent = makeEvenUserMessages(50, 5, MINUTE_MS, 100);
    const input = castMessages([...past, ...recent]);
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(true);
    expect(result.totalTokens).toBe(1_250);
    expect(result.evictedMessageCount).toBe(100);
    expect(result.evictedTokens).toBe(1_000);
    expect(result.protectedTokens).toBe(250);
    expect(result.evictedTokens + result.protectedTokens).toBe(result.totalTokens);

    // 保持テール（result.messages[1..]）は元メッセージの「同一オブジェクト参照」。
    // コピー・再シリアライズが一切無い = 直近 250K は1文字も削られていない。
    expect(result.messages).toHaveLength(1 + recent.length);
    for (let i = 0; i < recent.length; i++) {
      expect(result.messages[i + 1]).toBe(recent[i]);
    }
    // 過去ブロックは結果に現れない
    for (let i = 0; i < past.length; i++) {
      expect(result.messages.includes(past[i] as unknown as AgentMessage)).toBe(false);
    }
  });

  it("keeps at least the protected window when it does not align to a block boundary", () => {
    // 過去 100件 × 8トークン = 800 + 直近 100件 × 3トークン = 300 → 合計 1100 > 1000
    // 末尾から 250 トークンに達する最小境界 = index 116（直近ブロックの途中）。
    // 保持テール = 84件 (252トークン) ≥ 250 を下回らない。
    const past = makeEvenUserMessages(100, 8);
    const recent = makeEvenUserMessages(100, 3, MINUTE_MS, 100);
    const input = castMessages([...past, ...recent]);
    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(true);
    expect(result.evictedMessageCount).toBe(116);
    expect(result.protectedTokens).toBe(252);
    expect(result.protectedTokens).toBeGreaterThanOrEqual(250);
    expect(result.messages[1]).toBe(input[116]);
    for (let i = 0; i < 84; i++) {
      expect(result.messages[i + 1]).toBe(input[116 + i]);
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
    expect((notice as { content?: unknown }).content).toBe(DEFAULT_EVICTION_NOTICE);
    expect(kept).toHaveLength(50); // 直近 250トークン分（50件 × 5トークン）を保持
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
    expect(result.protectedTokens).toBe(51);
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
    expect(result.evictedMessageCount).toBe(100);
    expect(result.protectedTokens).toBe(250);
    expect(result.messages[1]).toBe(recent[0]);
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

// ── compaction 設定の反映 ──────────────────────────────────

describe("resolveEvictionOptionsFromCompaction", () => {
  it("returns empty options when config is absent", () => {
    expect(resolveEvictionOptionsFromCompaction(undefined)).toEqual({});
    expect(resolveEvictionOptionsFromCompaction({})).toEqual({});
  });

  it("maps reserveTokens to 1M - reserveTokens and keepRecentTokens to the protected window", () => {
    expect(resolveEvictionOptionsFromCompaction({ reserveTokens: 50_000 })).toEqual({
      evictionThresholdTokens: 950_000,
    });
    expect(resolveEvictionOptionsFromCompaction({ keepRecentTokens: 300_000 })).toEqual({
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
    expect(resolveEvictionOptionsFromCompaction({ reserveTokens: -1 })).toEqual({});
    expect(resolveEvictionOptionsFromCompaction({ reserveTokens: Number.NaN })).toEqual({});
    expect(resolveEvictionOptionsFromCompaction({ keepRecentTokens: 0 })).toEqual({});
    expect(resolveEvictionOptionsFromCompaction({ keepRecentTokens: -5 })).toEqual({});
    // reserve が基準コンテキストを超えても下限 1 にクランプする
    expect(resolveEvictionOptionsFromCompaction({ reserveTokens: 1_200_000 })).toEqual({
      evictionThresholdTokens: 1,
    });
  });

  it("supports a custom base context size", () => {
    expect(resolveEvictionOptionsFromCompaction({ reserveTokens: 10_000 }, 200_000)).toEqual({
      evictionThresholdTokens: 190_000,
    });
  });
});

// ── toolCall / toolResult ペアリング整合性 ─────────────────

describe("toolCall/toolResult pairing integrity", () => {
  it("extends the kept tail back to the assistant message when the boundary lands on a toolResult", () => {
    // 過去 100件 × 8トークン + assistant(toolCall) 1 + toolResult 60 + 直近 100件 × 2トークン
    // 合計 1061 > 1000。protected 250 の境界は toolResult の直前に落ちるが、
    // ペアリング調整で assistant メッセージまで保持テールが後退する。
    const past = makeEvenUserMessages(100, 8);
    const assistant = makeAssistantWithToolCall("tc-boundary", 1, BASE_TIME + 100 * MINUTE_MS);
    const toolResult = makeToolResult("tc-boundary", 60, BASE_TIME + 101 * MINUTE_MS);
    const recent = makeEvenUserMessages(100, 2, MINUTE_MS, 102);
    const input = castMessages([...past, assistant, toolResult, ...recent]);

    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
    });

    expect(result.evicted).toBe(true);
    expect(result.protectedTokens).toBe(1 + 60 + 200);
    // 保持テール先頭は toolResult ではなく、その toolCall を持つ assistant になる
    expect(result.messages[1]).toBe(assistant);
    expect(result.messages[2]).toBe(toolResult);
    expect((result.messages[1] as { role?: unknown }).role).toBe("assistant");
    // テール全体で孤児 toolResult が無い
    expectNoOrphanToolResults(result.messages);
  });

  it("drops a parentless orphan toolResult at the boundary instead of keeping it", () => {
    // 過去 110件 × 5トークン = 550 + 親の無い toolResult 250 + 直近 80件 × 3トークン = 240
    // 合計 1040 > 1000。境界は孤児 toolResult に落ちるため、孤児ごと退避側へ切り落とす。
    const past = makeEvenUserMessages(110, 5);
    const orphan = makeToolResult("tc-orphan", 250, BASE_TIME + 110 * MINUTE_MS);
    const recent = makeEvenUserMessages(80, 3, MINUTE_MS, 111);
    const input = castMessages([...past, orphan, ...recent]);

    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
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
  it("prefers the latest natural conversation pause before the protected window", () => {
    // 過去 100件 × 6トークン = 600 | 3時間の沈黙 | 中盤 50件 × 3トークン = 150 | 直近 100件 × 3トークン = 300
    // 合計 1050 > 1000。250K 境界（index 150）より手前の沈黙（index 99）で自然分割される。
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

  it("falls back to the exact protected-window boundary when no pause exists", () => {
    const old = makeEvenUserMessages(100, 6);
    const middle = makeEvenUserMessages(50, 3, MINUTE_MS, 100);
    const recent = makeEvenUserMessages(100, 3, MINUTE_MS, 150);
    // 間隔はすべて1分 → detectTemporalPauses は「間」を検出しない
    const input = castMessages([...old, ...middle, ...recent]);

    const result = applyPromptEvictionSafetyValve(input, {
      evictionThresholdTokens: 1_000,
      protectedRecentTokens: 250,
    });

    // 末尾から 250 トークンに達する最小境界 = index 166（84件 × 3トークン = 252）
    expect(result.evicted).toBe(true);
    expect(result.evictedMessageCount).toBe(166);
    expect(result.messages[1]).toBe(input[166]);
    expect(result.protectedTokens).toBe(252);
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
    expect(resultType.evictedMessageCount + resultType.messages.length - 1).toBe(200);
  });
});

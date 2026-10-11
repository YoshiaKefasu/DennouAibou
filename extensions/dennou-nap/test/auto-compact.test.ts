/**
 * auto-compact の保証テスト（本番 incident 1,041,738 tokens / 1,048,576 再現）。
 * - ①発火 ②圧縮後 ≤ target ③system ロール無し ④孤立 toolResult 0
 * - ⑤2回呼んで同一出力（キャッシュ再利用） ⑥仕分け全滅でも target 以下
 * - ⑦閾値未満では素通し（messages を返さない）
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAutoCompactCache,
  compressToTarget,
  estimateTokens,
  findOrphanToolPairs,
  findOrphanToolResults,
  hasSystemRole,
  type CompactableMessage,
  type TriageFn,
} from "../src/auto-compact.js";
import type { TriageChoice } from "../src/types.js";

const WINDOW = 1_048_576;
const INCIDENT_TOKENS = 1_041_738;
const TARGET_TOKENS = Math.floor(WINDOW * 0.6);

function choiceForTurn(text: string): TriageChoice {
  const m = /TURN-(\d+)/.exec(text);
  const i = m ? Number(m[1]) : 0;
  if (i % 5 === 4) return "落とす";
  if (i % 3 === 2) return "要約";
  return "維持";
}

const stubTriage: TriageFn = async (texts) => texts.map(choiceForTurn);

/** 推定器で測って約1M（incident相当）になる合成会話を作る。 */
function buildBigConversation(): CompactableMessage[] {
  const messages: CompactableMessage[] = [];
  const filler = (ch: string, len: number): string => ch.repeat(len);
  let t = 1_700_000_000_000;
  const TURNS = 130;
  for (let i = 0; i < TURNS; i++) {
    // 10分おきに章が割れるよう20ターンごとに1時間ジャンプ。
    if (i > 0 && i % 20 === 0) t += 3_600_000;
    t += 5_000;
    const callId = `call-${i}`;
    messages.push({
      role: "user",
      content: `TURN-${i} 指示: ${filler("あ", 1500)} ${filler("x", 3000)}`,
      timestamp: t,
    });
    t += 1_000;
    const assistantContent: unknown[] = [
      { type: "thinking", thinking: filler("考", 1500) },
      { type: "text", text: `TURN-${i} 回答 ${filler("b", 1500)}` },
      {
        type: "toolCall",
        id: callId,
        name: "read",
        arguments: { path: `/tmp/${i}`, big: filler("p", 4500) },
      },
    ];
    // 画像入りターン（固定コストの推定対象）。
    if (i === 10 || i === 60) {
      assistantContent.push({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
    }
    messages.push({
      role: "assistant",
      content: assistantContent,
      timestamp: t,
      api: "openai-completions",
      provider: "cli-router",
      model: "x",
      usage: { input: 1, output: 1, totalTokens: 2 },
      stopReason: "toolUse",
    });
    t += 1_000;
    messages.push({
      role: "toolResult",
      toolCallId: callId,
      toolName: "read",
      content: [{ type: "text", text: `TURN-${i} 結果 ${filler("r", 4500)}` }],
      isError: false,
      timestamp: t,
    });
  }
  return messages;
}

beforeEach(() => {
  clearAutoCompactCache();
});

describe("auto-compact 保証", () => {
  it("① incident相当で発火する", async () => {
    const messages = buildBigConversation();
    const outcome = await compressToTarget(messages, {
      usageTokens: INCIDENT_TOKENS,
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: stubTriage,
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.stats.fired).toBe(true);
    expect(outcome.stats.chapters).toBeGreaterThan(1);
  });

  it("② 圧縮後は target（0.60）以下", async () => {
    const messages = buildBigConversation();
    const outcome = await compressToTarget(messages, {
      usageTokens: INCIDENT_TOKENS,
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: stubTriage,
    });
    expect(outcome.stats.estimatedAfter).toBeLessThanOrEqual(TARGET_TOKENS);
    expect(outcome.stats.estimatedAfter).toBeLessThan(outcome.stats.estimatedBefore);
  });

  it("③ system ロールを含まない（先頭注入は user 1件）", async () => {
    const messages = buildBigConversation();
    const outcome = await compressToTarget(messages, {
      usageTokens: INCIDENT_TOKENS,
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: stubTriage,
    });
    expect(hasSystemRole(outcome.messages)).toBe(false);
    expect(outcome.messages[0]?.role).toBe("user");
    expect(outcome.summaryText).toContain("<dennou-nap-summary>");
  });

  it("④ 孤立 toolResult が0件・先頭は toolResult ではない", async () => {
    const messages = buildBigConversation();
    const outcome = await compressToTarget(messages, {
      usageTokens: INCIDENT_TOKENS,
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: stubTriage,
    });
    expect(findOrphanToolResults(outcome.messages)).toBe(0);
  });

  it("⑤ 2回呼んで同一出力（2回目は triage なしでキャッシュ再利用）", async () => {
    const messages = buildBigConversation();
    const opts = {
      usageTokens: INCIDENT_TOKENS,
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: stubTriage,
    };
    const first = await compressToTarget(messages, opts);
    const failing: TriageFn = async () => {
      throw new Error("Laya/Jev down");
    };
    const second = await compressToTarget(messages, { ...opts, triage: failing });
    expect(second.applied).toBe(true);
    expect(second.stats.summaryFromCache).toBe(true);
    // 要約メッセージの timestamp（Date.now()）だけは時刻依存なので正規化して比較。
    const normalize = (ms: CompactableMessage[]): string =>
      JSON.stringify(
        ms.map((m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.startsWith("<dennou-nap-summary>")
            ? { ...m, timestamp: 0 }
            : m,
        ),
      );
    expect(normalize(second.messages)).toBe(normalize(first.messages));
  });

  it("⑥ triage 全滅（全維持）でも target（0.60）以下", async () => {
    const messages = buildBigConversation();
    const outcome = await compressToTarget(messages, {
      usageTokens: INCIDENT_TOKENS,
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: undefined,
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.stats.estimatedAfter).toBeLessThanOrEqual(TARGET_TOKENS);
    expect(findOrphanToolResults(outcome.messages)).toBe(0);
    expect(hasSystemRole(outcome.messages)).toBe(false);
  });

  it("⑦ 閾値未満では素通し（messages を返さない）", async () => {
    const messages = buildBigConversation();
    const outcome = await compressToTarget(messages, {
      usageTokens: Math.floor(WINDOW * 0.5),
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: stubTriage,
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.stats.fired).toBe(false);
  });

  it("⑪ 対応toolResultのないtoolCallも除去される（双方向）", async () => {
    const { findOrphanToolPairs, sanitizePairs } = await import("../src/auto-compact.js");
    const t = 1_700_000_000_000;
    const messages: CompactableMessage[] = [
      { role: "user", content: "TURN-0 やって", timestamp: t },
      {
        role: "assistant",
        content: [
          { type: "text", text: "TURN-0 了解" },
          { type: "toolCall", id: "call-dangle", name: "read", arguments: {} },
        ],
        timestamp: t + 1,
      },
      // 次ターンに跨いだ孤立 toolResult（対応toolCallなし）。
      {
        role: "user",
        content: "TURN-1 次",
        timestamp: t + 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-ghost",
        toolName: "read",
        content: [{ type: "text", text: "ghost" }],
        isError: false,
        timestamp: t + 3,
      },
    ];
    const before = findOrphanToolPairs(messages);
    expect(before.orphanCalls).toBe(1);
    expect(before.orphanResults).toBe(1);
    const outcome = await compressToTarget(messages, {
      // 小さめの実測＋force でターンドロップを起こさず sanitize の除去を数える。
      usageTokens: 100_000,
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: stubTriage,
      force: true,
    });
    expect(outcome.applied).toBe(true);
    const after = findOrphanToolPairs(outcome.messages);
    expect(after.orphanCalls).toBe(0);
    expect(after.orphanResults).toBe(0);
    expect(outcome.stats.orphanToolCallsRemoved).toBeGreaterThanOrEqual(1);
    // sanitizePairs 単体でも両方向に効く。
    const s = sanitizePairs(messages);
    expect(findOrphanToolPairs(s.messages).orphanCalls).toBe(0);
  });

  it("⑫ 単一章スモール（削り余地ゼロ）はノーオペで返す", async () => {
    // 「間」なし＝単一章・全章保護で退避もターンドロップも余地ゼロ。
    // usage偽装で発火しても、要約ヘッダ分だけ膨らんだ applied:true を返さず
    // 入力そのままの applied:false で返す（不具合＝肥大化が起きない）。
    // 比率予算（allowedEst）には届かないため targetMissed=true で正直に申告する。
    const messages: CompactableMessage[] = [];
    let t = 1_700_000_000_000;
    for (let i = 0; i < 60; i++) {
      t += 1_000;
      messages.push({
        role: "user",
        content: `U${i} ${"z".repeat(4000)}`,
        timestamp: t,
      });
      t += 1_000;
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `A${i} ${"y".repeat(4000)}` }],
        timestamp: t,
      });
    }
    const outcome = await compressToTarget(messages, {
      usageTokens: INCIDENT_TOKENS,
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: undefined,
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.stats.chapters).toBe(1);
    expect(outcome.stats.targetMissed).toBe(true);
    // 入力そのまま: 膨らんでいない。
    expect(outcome.stats.estimatedAfter).toBe(outcome.stats.estimatedBefore);
    expect(findOrphanToolPairs(outcome.messages).orphanCalls).toBe(0);
  });

  it("⑫b 単一巨大章（予算大幅超過・削り余地ゼロ）も未達申告する", async () => {
    // 単一章なのに推定が予算超過: 保護で全章不可侵→削れない。
    // 要約ヘッダ分だけ膨らんだ applied:true を返さず、
    // applied:false + targetMissed:true で正直に申告する。
    const messages: CompactableMessage[] = [];
    let t = 1_700_000_000_000;
    for (let i = 0; i < 60; i++) {
      t += 1_000;
      messages.push({
        role: "user",
        content: `U${i} ${"z".repeat(30000)}`,
        timestamp: t,
      });
      t += 1_000;
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `A${i} ${"y".repeat(30000)}` }],
        timestamp: t,
      });
    }
    const outcome = await compressToTarget(messages, {
      usageTokens: INCIDENT_TOKENS,
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: undefined,
    });
    expect(outcome.stats.chapters).toBe(1);
    expect(outcome.stats.targetMissed).toBe(true);
    expect(outcome.applied).toBe(false);
    // 入力そのまま: 膨らんでいない。
    expect(outcome.stats.estimatedAfter).toBe(outcome.stats.estimatedBefore);
  });

  it("⑬ triage失敗は統計に記録される（無言にしない）", async () => {
    // 複数章に跨る分量にする（単一章＝最新章は仕分け対象外のため）。
    const messages = buildBigConversation().slice(0, 90);
    const failing: TriageFn = async () => {
      throw new Error("timeout");
    };
    const outcome = await compressToTarget(messages, {
      usageTokens: INCIDENT_TOKENS,
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: failing,
      force: true,
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.stats.triageFailures).toBeGreaterThan(0);
  });

  it("⑭ maxKeptRatio: 過去章の維持合計が上限内に収まる（古い維持から要約へ昇華）", async () => {
    // 全維持の仕分けでも維持蓄積が上限を超えないこと。
    const messages = buildBigConversation();
    const keepAll: TriageFn = async (texts) => texts.map(() => "維持" as const);
    const outcome = await compressToTarget(messages, {
      usageTokens: INCIDENT_TOKENS,
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: keepAll,
      maxKeptRatio: 0.05,
      protectRecentChapters: 1,
    });
    expect(outcome.applied).toBe(true);
    const maxKept = Math.floor(WINDOW * 0.05);
    expect(outcome.stats.maxKeptTokens).toBe(maxKept);
    expect(outcome.stats.keptPastTokens).toBeLessThanOrEqual(maxKept);
    expect(outcome.stats.keptScaledDownTurns).toBeGreaterThan(0);
    expect(outcome.stats.estimatedAfter).toBeLessThanOrEqual(TARGET_TOKENS);
  });

  it("⑮ protectRecentChapters: 要求3章でもtarget収まり優先で実効保護は絞られる", async () => {
    // 保護章の維持が大量でも上限スケーリングの対象にならない。
    // ただし保護部の生合計が protectBudget（allowedEst×0.95）を超える分は
    // 実効保護が絞られ、targetMissed=false（＝収まり成功）になる。
    // targetRatio=0.35 で末尾3章生合計（約277k）が protectBudget（約218k）を
    // 超えるためキャップが発動し、末尾2章（約166k）で停止＝実効2章になる。
    const messages = buildBigConversation();
    const keepAll: TriageFn = async (texts) => texts.map(() => "維持" as const);
    const tightTarget = Math.floor(WINDOW * 0.35);
    const outcome = await compressToTarget(messages, {
      usageTokens: INCIDENT_TOKENS,
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.35,
      maGapMs: 5 * 60_000,
      triage: keepAll,
      maxKeptRatio: 0.05,
      protectRecentChapters: 3,
    });
    expect(outcome.applied).toBe(true);
    const maxKept = Math.floor(WINDOW * 0.05);
    expect(outcome.stats.keptPastTokens).toBeLessThanOrEqual(maxKept);
    expect(outcome.stats.targetMissed).toBe(false);
    expect(outcome.stats.estimatedAfter).toBeLessThanOrEqual(tightTarget);
    // キャップ発動で実効保護は要求3章より厳密に小さい。最新章の維持ターンは生で残る。
    expect(outcome.stats.protectedChapters).toBeLessThan(3);
    expect(outcome.stats.protectedChapters).toBeGreaterThanOrEqual(1);
    const keptText = JSON.stringify(outcome.messages);
    expect(keptText).toContain("TURN-129");
  });

  it("⑯ 200K窓でも比率で上限が締まる（モデル枠連動）", async () => {
    const SMALL = 200_000;
    const smallTarget = Math.floor(SMALL * 0.6);
    const messages = buildBigConversation().slice(0, 90);
    const keepAll: TriageFn = async (texts) => texts.map(() => "維持" as const);
    const outcome = await compressToTarget(messages, {
      usageTokens: Math.floor(SMALL * 0.95),
      contextWindow: SMALL,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: keepAll,
      maxKeptRatio: 0.25,
      protectRecentChapters: 1,
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.stats.maxKeptTokens).toBe(Math.floor(SMALL * 0.25));
    expect(outcome.stats.keptPastTokens).toBeLessThanOrEqual(Math.floor(SMALL * 0.25));
    expect(outcome.stats.estimatedAfter).toBeLessThanOrEqual(smallTarget);
  });

  it("⑰ 章数<=250で既定P=250未指定でも不具合が起きない", async () => {
    // 本命: 7章しかない会話に既定250を要求→実効保護は絞られてtarget達成。
    // protectRecentChapters 未指定＝DEFAULT_PROTECT_RECENT_CHAPTERS(250)。
    const messages = buildBigConversation();
    const outcome = await compressToTarget(messages, {
      usageTokens: INCIDENT_TOKENS,
      contextWindow: WINDOW,
      thresholdRatio: 0.85,
      targetRatio: 0.6,
      maGapMs: 5 * 60_000,
      triage: stubTriage,
    });
    expect(outcome.stats.chapters).toBeLessThanOrEqual(250);
    expect(outcome.applied).toBe(true);
    expect(outcome.stats.targetMissed).toBe(false);
    expect(outcome.stats.estimatedAfter).toBeLessThanOrEqual(TARGET_TOKENS);
    expect(outcome.stats.estimatedAfter).toBeLessThan(outcome.stats.estimatedBefore);
    // 実効保護は要求250より大幅に小さい（食い潰し防止のキャップが効いている）。
    expect(outcome.stats.protectedChapters).toBeLessThan(outcome.stats.chapters);
    expect(outcome.stats.protectedChapters).toBeGreaterThanOrEqual(1);
    expect(findOrphanToolPairs(outcome.messages).orphanCalls).toBe(0);
    expect(hasSystemRole(outcome.messages)).toBe(false);
  });
});

/**
 * Compactor: プロンプト合成。
 *
 * - 維持ターンを原文のまま ＋ Historian 要約を先頭ブロックに合成する。
 * - 入力配列には一切触れない（インメモリ合成のみ）。
 *   セッション JSONL は完全無傷・可逆（`reversible: true`）。
 */

import type { TriageResult, Turn } from "./types.js";

export interface CompactResult {
  promptPrefix: string;
  keptTurns: Turn[];
  summarizedIds: number[];
  droppedCount: number;
  summary: string;
  /** 常に true: 合成のみで入力・セッションを書き換えない。 */
  reversible: boolean;
}

export function composePrompt(keptTurns: Turn[], summary: string): string {
  const kept = keptTurns.map((t) => t.text).join("\n---\n");
  if (summary && kept) {
    return `# 仮眠メモリ（要約）\n${summary}\n\n# 維持された会話\n${kept}`;
  }
  if (summary) return `# 仮眠メモリ（要約）\n${summary}`;
  return kept;
}

export function compact(turns: Turn[], decisions: TriageResult[], summary: string): CompactResult {
  const n = Math.min(turns.length, decisions.length);
  const keptTurns: Turn[] = [];
  const summarizedIds: number[] = [];
  let droppedCount = 0;
  for (let i = 0; i < n; i++) {
    const turn = turns[i];
    const decision = decisions[i];
    if (!turn || !decision) continue;
    if (decision.choice === "維持") keptTurns.push(turn);
    else if (decision.choice === "要約") summarizedIds.push(turn.id);
    else droppedCount += 1;
  }
  return {
    promptPrefix: composePrompt(keptTurns, summary),
    keptTurns,
    summarizedIds,
    droppedCount,
    summary,
    reversible: true,
  };
}

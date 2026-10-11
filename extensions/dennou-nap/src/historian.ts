/**
 * Historian: 選抜一括要約。
 *
 * - 「落とす」ノイズを除外し、維持＋要約の流れだけを Historian コンテキストに載せる。
 * - 要約対象（「要約」判定のターン）のみを一括で summarizer に渡す（1回の呼び出し）。
 * - 既定 summarizer は抽出型（LLM 不要でオフライン動作）。実運用では上位 LLM を注入する。
 */

import type { TriageResult, Turn } from "./types.js";

export type Summarizer = (targets: string[], context: string) => Promise<string> | string;

export const DEFAULT_EXTRACT_CHARS = 200;

export function createExtractiveSummarizer(
  maxCharsPerTurn: number = DEFAULT_EXTRACT_CHARS,
): Summarizer {
  return (texts: string[], context: string): string => {
    const body = texts
      .map((t) => (t.length > maxCharsPerTurn ? `${t.slice(0, maxCharsPerTurn)}…` : t))
      .join("\n---\n");
    if (!context) return body;
    if (!body) return `# 会話の流れ\n${context}`;
    return `# 会話の流れ\n${context}\n\n# 要約対象\n${body}`;
  };
}

/**
 * 「落とす」を除外した会話全体の流れ（維持＋要約）をテキスト化する。
 * turns と decisions の長さが食い違ったら短い方に合わせる（fail-safe）。
 */
export function buildHistorianContext(turns: Turn[], decisions: TriageResult[]): string {
  const n = Math.min(turns.length, decisions.length);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const turn = turns[i];
    const decision = decisions[i];
    if (!turn || !decision) continue;
    if (decision.choice === "落とす") continue;
    const tag = decision.choice === "維持" ? "[維持]" : "[要約対象]";
    lines.push(`${tag} T${turn.id}: ${turn.text}`);
  }
  return lines.join("\n");
}

export interface HistorianResult {
  summary: string;
  summarizedIds: number[];
  context: string;
}

export async function summarizeSelection(
  turns: Turn[],
  decisions: TriageResult[],
  summarizer?: Summarizer,
): Promise<HistorianResult> {
  const n = Math.min(turns.length, decisions.length);
  const context = buildHistorianContext(turns, decisions);
  const targets: Turn[] = [];
  for (let i = 0; i < n; i++) {
    const turn = turns[i];
    const decision = decisions[i];
    if (turn && decision?.choice === "要約") targets.push(turn);
  }
  if (targets.length === 0) {
    return { summary: "", summarizedIds: [], context };
  }
  const fn = summarizer ?? createExtractiveSummarizer();
  const summary = await fn(
    targets.map((t) => t.text),
    context,
  );
  return { summary, summarizedIds: targets.map((t) => t.id), context };
}

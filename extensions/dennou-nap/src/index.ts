/**
 * dennou-nap エントリーポイント。
 *
 * DennouAibou（Kasou）／単体利用向けの依存ゼロのコア。パイプライン:
 * ターン化 → 章分割 → System 1 仕分け → Historian 選抜一括要約 → プロンプト合成。
 */

export * from "./types.js";
export * from "./auto-compact.js";
export * from "./config-loader.js";
export * from "./system-one-client.js";
export * from "./compartment.js";
export * from "./historian.js";
export * from "./compactor.js";

import { compact } from "./compactor.js";
import { splitIntoChapters } from "./compartment.js";
import { loadDennouNapConfig, type LoadOptions } from "./config-loader.js";
import { summarizeSelection, type Summarizer } from "./historian.js";
import { SystemOneClient } from "./system-one-client.js";
import type { Chapter, ChatMessage, TriageResult, Turn } from "./types.js";

export interface NapDeps {
  client: Pick<SystemOneClient, "judgeMany">;
  summarizer?: Summarizer;
  maGapMs?: number;
  /** false のとき System 1・Historian を呼ばず全維持で返す（config `enabled` の配線用）。 */
  enabled?: boolean;
}

export interface NapResult {
  chapters: Chapter[];
  turns: Turn[];
  decisions: TriageResult[];
  summary: string;
  summarizedIds: number[];
  /** Historian に渡した全体文脈（維持＋要約の流れ）。Summarizer への第2引数と同一。 */
  context: string;
  promptPrefix: string;
  droppedCount: number;
}

/**
 * 仮眠圧縮パイプライン。`messages` は読み取り専用（破壊しない）。
 * セッション JSONL への書き込みは行わない。
 */
export async function nap(messages: ChatMessage[], deps: NapDeps): Promise<NapResult> {
  if (deps.enabled === false) {
    const disabledChapters = splitIntoChapters(messages, deps.maGapMs);
    const disabledTurns = disabledChapters.flatMap((c) => c.turns);
    const disabledDecisions: TriageResult[] = disabledTurns.map(() => ({
      choice: "維持" as const,
      confidence: 1,
      probabilities: { 維持: 1, 要約: 0, 落とす: 0 },
      reason: "disabled: nap skipped",
    }));
    const disabledCompacted = compact(disabledTurns, disabledDecisions, "");
    return {
      chapters: disabledChapters,
      turns: disabledTurns,
      decisions: disabledDecisions,
      summary: "",
      summarizedIds: [],
      context: "",
      promptPrefix: disabledCompacted.promptPrefix,
      droppedCount: 0,
    };
  }
  const chapters = splitIntoChapters(messages, deps.maGapMs);
  const turns = chapters.flatMap((c) => c.turns);
  const decisions = await deps.client.judgeMany(turns.map((t) => t.text));
  const historian = await summarizeSelection(turns, decisions, deps.summarizer);
  const compacted = compact(turns, decisions, historian.summary);
  return {
    chapters,
    turns,
    decisions,
    summary: historian.summary,
    summarizedIds: historian.summarizedIds,
    context: historian.context,
    promptPrefix: compacted.promptPrefix,
    droppedCount: compacted.droppedCount,
  };
}

export interface NapPluginApi {
  registerTool?: (tool: unknown, opts?: unknown) => void;
  registerService?: (service: unknown) => void;
  logger?: { info(message: string): void };
}

/** ハーネス非依存のプラグイン定義。両ローダから参照できる。 */
export const plugin = {
  id: "dennou-nap",
  name: "Dennou Nap（仮眠圧縮）",
  description:
    "時間認識ブロック分割 ＋ System 1 直感仕分け ＋ Historian 選抜一括要約によるインテリジェント圧縮",
};

function createClientFromConfig(options?: LoadOptions): SystemOneClient {
  const cfg = loadDennouNapConfig(options);
  return new SystemOneClient({
    endpoint: cfg.systemOne.endpoint,
    model: cfg.systemOne.model,
    apiKey: cfg.systemOne.apiKey,
    fallback: cfg.systemOne.fallback,
    timeoutMs: cfg.timeoutMs,
    concurrency: cfg.concurrency,
    failureThreshold: cfg.failureThreshold,
    cooldownMs: cfg.cooldownMs,
  });
}

export function resolveNapOptions(options?: LoadOptions): {
  load: () => ReturnType<typeof loadDennouNapConfig>;
  createClient: () => SystemOneClient;
} {
  return {
    load: () => loadDennouNapConfig(options),
    createClient: () => createClientFromConfig(options),
  };
}

export default {
  ...plugin,
  register(api: NapPluginApi): void {
    // コアのみ同梱。ハーネス側の配線（tool / service 登録）は opt-in。
    api.logger?.info("dennou-nap: loaded (core only; harness wiring is opt-in).");
  },
};

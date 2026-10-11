/**
 * dennou-nap（電脳仮眠）— bundled プラグインエントリ（DEBLOAT §42）。
 *
 * コア実装は `./src/index.js`（外部依存ゼロ）。このエントリは3つの責務だけを持つ:
 * 1. `definePluginEntry` による正式なプラグイン登録（`openclaw.plugin.json` の id と一致）。
 * 2. `./src/index.js` の全公開シンボルの再エクスポート。
 * 3. 本体ランナー（`attempt.ts`）向けのフェイルオープン圧縮ファサード
 *    `compressPromptForNap`。Gateway のインメモリ設定から System 1 クライアントを
 *    組み立て、85% 閾値到達時のインメモリ圧縮を実行する。
 *
 * 圧縮はプロンプト先頭への要約合成のみ。セッション JSONL は一切書き換えない
 * （`compressToTarget` の `reversible: true` 契約をそのまま継承）。
 */

import { definePluginEntry } from "../../src/plugin-sdk/plugin-entry.js";
import {
  compressToTarget,
  estimateTokens,
  isConfident,
  resolveDennouNapConfigFromSection,
  SystemOneClient,
  type CompactableMessage,
  type CompressOutcome,
  type DennouNapConfig,
  type TriageFn,
} from "./src/index.js";

export * from "./src/index.js";

/**
 * 1 回の圧縮で使う System 1 呼び出し回数の既定上限（最古ターンから消費）。
 * ホットパスの最大待機時間をバウンドする。concurrency 8 × timeout 2,000ms で
 * 最悪 128 / 8 × 2,000ms = 32s に収まり、上限超過分は「維持」で安全側に倒れる。
 */
export const DEFAULT_NAP_TRIAGE_BUDGET = 128;

/**
 * 85% 閾値到達時のインメモリ圧縮（プロンプト先頭への要約合成のみ）。
 *
 * 本体ランナー専用。例外は呼び出し側（`attempt.ts`）の `try / catch` で
 * フェイルオープンさせるため、ここでは握り潰さずに伝播させる。
 */
export async function compressPromptForNap(params: {
  /** 圧縮対象のプロンプト履歴（生 branch・未折りたたみ空間）。読み取り専用。 */
  messages: CompactableMessage[];
  /** モデルコンテキスト窓。maxKeptRatio・保護章キャップの基準になる。 */
  contextWindow: number;
  /** プロバイダ実測の prompt tokens。未指定時は nap 自身の推定器にフォールバックする。 */
  measuredTokens?: number;
  /** `plugins.entries["dennou-nap"].config`。未指定・不正時は既定値（Jev クラウド）。 */
  config?: Record<string, unknown>;
  /** 1 回の圧縮で使う System 1 呼び出し回数の上限。既定は `DEFAULT_NAP_TRIAGE_BUDGET`。 */
  triageBudget?: number;
}): Promise<CompressOutcome> {
  const cfg: DennouNapConfig = resolveDennouNapConfigFromSection(params.config);
  const estimated = estimateTokens(params.messages);
  const usageTokens = params.measuredTokens ?? estimated;

  // config `enabled: false` の遵守: System 1 を一切呼ばずに入力をそのまま返す。
  // 本体側（attempt.ts）でも entry の enabled を見ているが、ここは単体利用や
  // 二重配線時の防衛ラインとして自前で貫く（テストで固定する契約）。
  if (cfg.enabled === false) {
    return {
      applied: false,
      messages: params.messages,
      stats: {
        fired: false,
        tokensBefore: usageTokens,
        contextWindow: params.contextWindow,
        usageRatio: params.contextWindow > 0 ? usageTokens / params.contextWindow : 0,
        estimatedBefore: estimated,
        estimatedAfter: estimated,
        chapters: 0,
        keepTurns: 0,
        summarizeTurns: 0,
        dropTurns: 0,
        evictedChapters: 0,
        protectedChapters: 0,
        targetMissed: false,
        maxKeptTokens: Math.max(1, Math.floor(params.contextWindow * cfg.maxKeptRatio)),
        keptPastTokens: 0,
        keptScaledDownTurns: 0,
        orphanToolResultsRemoved: 0,
        orphanToolCallsRemoved: 0,
        triageFailures: 0,
        summaryFromCache: false,
        elapsedMs: 0,
      },
      summaryText: "",
      firstKeptInputIndex: -1,
    };
  }

  const client = new SystemOneClient({
    endpoint: cfg.systemOne.endpoint,
    model: cfg.systemOne.model,
    apiKey: cfg.systemOne.apiKey,
    fallback: cfg.systemOne.fallback,
    timeoutMs: cfg.timeoutMs,
    concurrency: cfg.concurrency,
    failureThreshold: cfg.failureThreshold,
    cooldownMs: cfg.cooldownMs,
  });
  // 確信度が `confidenceThreshold` 未満の仕分けは鵜呑みにせず「維持」へ倒す
  // （fail-open: System 1 が落ちても confidence 0 → 全維持で安全側に倒れる）。
  const triage: TriageFn = async (texts) => {
    const results = await client.judgeMany(texts);
    return results.map((result) =>
      isConfident(result, cfg.confidenceThreshold) ? result.choice : "維持",
    );
  };
  return compressToTarget(params.messages, {
    contextWindow: params.contextWindow,
    usageTokens,
    thresholdRatio: cfg.thresholdRatio,
    targetRatio: cfg.targetRatio,
    maGapMs: cfg.maGapMs,
    maxKeptRatio: cfg.maxKeptRatio,
    protectRecentChapters: cfg.protectRecentChapters,
    triage,
    triageBudget: params.triageBudget ?? DEFAULT_NAP_TRIAGE_BUDGET,
  });
}

export default definePluginEntry({
  id: "dennou-nap",
  name: "Dennou Nap（仮眠圧縮）",
  description:
    "時間認識章分割 ＋ System 1 直感仕分け ＋ Historian 選抜一括要約によるインメモリ圧縮（電脳仮眠）",
  register() {
    // コアのみ同梱。圧縮は本体ランナー（attempt.ts）から compressPromptForNap 経由で駆動する。
  },
});

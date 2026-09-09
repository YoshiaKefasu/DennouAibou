/**
 * context-pruner — 裏方圧縮 ステップ 2: 一時退避安全弁（インメモリフィルター）
 *
 * 仕様: DENNOU_DOCS/COMPACTION_FEATURE.md §7.3 / §7.4 / §7.5
 *
 * コンテキストが evictionThresholdTokens（既定 950K = 1M - reserve 50K）を超え、
 * 裏方 Historian の要約が未完了のまま上限 1M に迫った場合、プロンプト構築時に
 * 「直近 protectedRecentTokens（既定 250K）より古い過去ブロック群」を一時的に
 * 除外（テンポラリ退避）するフェイルセーフ。
 *
 * 設計メモ:
 * - ファイルI/O・セッション操作は一切行わない純粋関数。セッションファイル
 *   （.jsonl）上の実ログは 100% 保持され、プロンプトへの注入のみがスキップされる。
 *   退避は常に可逆で、SESSION_INTEGRITY_GUARD の親子リンク破壊リスクを構造的に
 *   排除する（§7.5）。
 * - 直近 protectedRecentTokens トークンは「1文字も削らない不可侵領域」（§7.4）。
 *   退避対象は常にそれより古い過去分のみ。トークン推定はステップ 1
 *   （compartment.ts の estimateMessageChars / estimateMessageTokens、約4文字=1
 *   トークン）に統一する。
 * - 250K 境界はステップ 1 の時間認識（detectTemporalPauses、§7.1）で求まる
 *   「会話の間（ま）」のうち、境界の手前で最も新しいものを優先して自然分割する。
 *   「間」が無い場合はメッセージ境界でフォールバック分割する。
 * - 退避発火時は先頭にシステム注記（role: "user" の notice message）を付与する。
 *   AgentMessage 型に "system" ロールが無いため "user" で表現する（設計書 §7.5
 *   は role: "system" または role: "user" のどちらかを許容する）。
 * - toolCall/toolResult ペアリング整合性: 保持テールの先頭が孤児 toolResult に
 *   ならないよう、ペアとなる assistant メッセージまで境界を後退させる
 *   （境界後退は「保持を増やす」方向にしか動かないため、直近 250K 保護を下回らない）。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  detectTemporalPauses,
  estimateMessageTokens,
  DEFAULT_MIN_PAUSE_THRESHOLD_MS,
  DEFAULT_PAUSE_MULTIPLIER,
} from "./compartment.js";

/** 退避発火閾値（既定 950K トークン = 1M コンテキスト - 50K reserve）。 */
export const DEFAULT_EVICTION_THRESHOLD_TOKENS = 950_000;
/** 不可侵の直近保護ウィンドウ（§7.4。この領域は1文字も削らない）。 */
export const DEFAULT_PROTECTED_RECENT_TOKENS = 250_000;
/** 退避時にプロンプト先頭へ付与するシステム注記。 */
export const DEFAULT_EVICTION_NOTICE =
  "[システム注記: コンテキスト上限接近のため、直近250K以前の過去ログは裏方要約完了まで一時退避中]";
/** 退避閾値の基準コンテキストサイズ（KASOU 運用設定 contextTokens: 1,000,000）。 */
export const DEFAULT_EVICTION_BASE_CONTEXT_TOKENS = 1_000_000;

/** 一時退避安全弁のオプション（すべて省略可）。 */
export type EvictionOptions = {
  /** 退避を発火する全体推定トークン閾値（既定 950,000）。 */
  evictionThresholdTokens?: number;
  /** 不可侵の直近保護トークン数（既定 250,000）。 */
  protectedRecentTokens?: number;
  /** 「会話の間（ま）」と判定する最小の絶対沈黙フロア ms（既定 30分）。 */
  minPauseThresholdMs?: number;
  /** 平均インターバルの何倍で「間」とみなすかの係数（既定 3.0）。 */
  pauseMultiplier?: number;
  /** 退避時に先頭へ付与する注記テキスト（既定 DEFAULT_EVICTION_NOTICE）。 */
  noticeText?: string;
};

/** 一時退避の実行結果。 */
export type EvictionResult = {
  /** フィルタリング後のメッセージ配列（退避時は注記 + 直近保護テール）。 */
  messages: AgentMessage[];
  /** 退避が発火したか（1件以上を除外した場合のみ true）。 */
  evicted: boolean;
  /** 入力全体の推定トークン数。 */
  totalTokens: number;
  /** 退避されたメッセージ数。 */
  evictedMessageCount: number;
  /** 退避された推定トークン数。 */
  evictedTokens: number;
  /** 保持された直近（保護テール）の推定トークン数。 */
  protectedTokens: number;
};

/** kernel の compaction 設定のうち、安全弁が参照する最小形（agents.defaults.compaction）。 */
export type CompactionConfigLike = {
  reserveTokens?: number;
  keepRecentTokens?: number;
};

/** 有効な正の数値のみ通す（不正値は null としてデフォルトへフォールバック）。 */
function positiveFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function resolveEvictionOptions(options?: EvictionOptions): Required<EvictionOptions> {
  return {
    evictionThresholdTokens: Math.floor(
      positiveFinite(options?.evictionThresholdTokens) ?? DEFAULT_EVICTION_THRESHOLD_TOKENS,
    ),
    protectedRecentTokens: Math.floor(
      positiveFinite(options?.protectedRecentTokens) ?? DEFAULT_PROTECTED_RECENT_TOKENS,
    ),
    minPauseThresholdMs: Math.floor(
      positiveFinite(options?.minPauseThresholdMs) ?? DEFAULT_MIN_PAUSE_THRESHOLD_MS,
    ),
    pauseMultiplier: positiveFinite(options?.pauseMultiplier) ?? DEFAULT_PAUSE_MULTIPLIER,
    noticeText:
      typeof options?.noticeText === "string" && options.noticeText.trim() !== ""
        ? options.noticeText.trim()
        : DEFAULT_EVICTION_NOTICE,
  };
}

/**
 * 環境変数キルスイッチ: `DENNOU_SKIP_EVICTION_SAFETY_VALVE=1` のとき安全弁を無効化する。
 * 判定は純粋関数（env を注入可能）にして単体テスト可能にする。
 */
export function isEvictionSafetyValveEnabled(
  env: { DENNOU_SKIP_EVICTION_SAFETY_VALVE?: string } = process.env,
): boolean {
  return env.DENNOU_SKIP_EVICTION_SAFETY_VALVE !== "1";
}

/**
 * kernel の compaction 設定（`agents.defaults.compaction` のスライス）を
 * EvictionOptions へ反映する。未指定の項目は既定値のまま（undefined で返す）。
 *
 * - `reserveTokens` 指定時: `evictionThresholdTokens = baseContextTokens - reserveTokens`
 *   （既定 base = 1,000,000。reserve 50,000 で 950,000 = DEFAULT_EVICTION_THRESHOLD_TOKENS）。
 * - `keepRecentTokens` 指定時: `protectedRecentTokens` を上書きする。
 */
export function resolveEvictionOptionsFromCompaction(
  compaction: CompactionConfigLike | undefined,
  baseContextTokens: number = DEFAULT_EVICTION_BASE_CONTEXT_TOKENS,
): EvictionOptions {
  const options: EvictionOptions = {};
  if (
    typeof compaction?.reserveTokens === "number" &&
    Number.isFinite(compaction.reserveTokens) &&
    compaction.reserveTokens >= 0
  ) {
    options.evictionThresholdTokens = Math.max(
      1,
      Math.floor(baseContextTokens) - Math.floor(compaction.reserveTokens),
    );
  }
  if (
    typeof compaction?.keepRecentTokens === "number" &&
    Number.isFinite(compaction.keepRecentTokens) &&
    compaction.keepRecentTokens > 0
  ) {
    options.protectedRecentTokens = Math.floor(compaction.keepRecentTokens);
  }
  return options;
}

/**
 * 保持テール先頭の toolResult に対応する toolCall を含む直近の assistant メッセージ
 * インデックスを探す。見つからない場合は undefined（孤児 toolResult の可能性）。
 */
function findToolCallParentIndex(
  messages: readonly AgentMessage[],
  toolResultIndex: number,
): number | undefined {
  const target = messages[toolResultIndex];
  if (target?.role !== "toolResult") {
    return undefined;
  }
  const toolCallId = target.toolCallId;
  for (let i = toolResultIndex - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") {
      continue;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    const hasCall = content.some(
      (block) =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "toolCall" &&
        (block as { id?: unknown }).id === toolCallId,
    );
    if (hasCall) {
      return i;
    }
  }
  return undefined;
}

/**
 * 一時退避安全弁（§7.3 / §7.4 / §7.5）。
 *
 * 1. 入力全体の推定トークン数が閾値以下なら退避しない（元の配列をそのまま返す）。
 * 2. 超過時は末尾から逆走査し、直近の累積トークンが protectedRecentTokens に
 *    達する最小境界を特定する（直近保護ウィンドウは不可侵）。
 * 3. ステップ 1 の時間認識（detectTemporalPauses）で求まる「会話の間（ま）」の
 *    うち、境界手前で最も新しいものを優先して自然分割する。
 * 4. toolCall/toolResult のペアリング整合性を保つ（先頭に孤児 toolResult を置かない）。
 * 5. 250K より古いメッセージをプロンプトから除外し、先頭にシステム注記を付与する。
 *
 * 純粋なインメモリ変換であり、セッションファイル（.jsonl）への読み書きは一切行わない。
 */
export function applyPromptEvictionSafetyValve(
  messages: AgentMessage[],
  options?: EvictionOptions,
): EvictionResult {
  const opts = resolveEvictionOptions(options);
  const estimates = messages.map(estimateMessageTokens);
  const totalTokens = estimates.reduce((sum, value) => sum + value, 0);

  const noEviction = (): EvictionResult => ({
    messages,
    evicted: false,
    totalTokens,
    evictedMessageCount: 0,
    evictedTokens: 0,
    protectedTokens: totalTokens,
  });

  // 閾値以下: 退避不要（§7.3 の発火条件に未達）
  if (totalTokens <= opts.evictionThresholdTokens) {
    return noEviction();
  }
  if (messages.length === 0) {
    return noEviction();
  }

  // ── 直近保護ウィンドウの境界特定（末尾から逆走査）──
  // boundary = suffixTokens[boundary..end] >= protectedRecentTokens を満たす最小 index
  const minProtected = Math.max(1, opts.protectedRecentTokens);
  let boundary = messages.length;
  let suffixTokens = 0;
  while (boundary > 0 && suffixTokens < minProtected) {
    boundary -= 1;
    suffixTokens += estimates[boundary];
  }
  // 保護ウィンドウが全体を覆う場合（設定異常など）は退避しない
  if (boundary === 0) {
    return noEviction();
  }

  // ── 「会話の間（ま）」による自然分割（§7.1）──
  // 境界の手前（g + 1 <= boundary。つまり切っても保護 250K を下回らない）にある
  // 最後の pause を優先する。無ければメッセージ境界（boundary）でフォールバック。
  const pauses = detectTemporalPauses(messages, {
    minPauseThresholdMs: opts.minPauseThresholdMs,
    pauseMultiplier: opts.pauseMultiplier,
  });
  let cut = boundary;
  for (let i = pauses.length - 1; i >= 0; i--) {
    if (pauses[i] + 1 <= boundary) {
      cut = pauses[i] + 1;
      break;
    }
  }

  // ── toolCall/toolResult ペアリング整合性 ──
  // 保持テールの先頭が toolResult なら、その toolCall を持つ assistant メッセージまで
  // 境界を後退させる（保持が増える方向のみ。直近保護を下回らない）。
  // 対応する toolCall が見つからない異常データ（孤児 toolResult）だけ先頭から切り落とす。
  while (cut < messages.length && messages[cut].role === "toolResult") {
    const parentIndex = findToolCallParentIndex(messages, cut);
    if (parentIndex === undefined) {
      cut += 1;
      continue;
    }
    cut = parentIndex;
    break;
  }
  if (cut === 0) {
    return noEviction();
  }

  const evictedMessageCount = cut;
  const protectedTokens = estimates.slice(cut).reduce((sum, value) => sum + value, 0);
  const notice: AgentMessage = {
    role: "user",
    content: opts.noticeText,
    timestamp: Date.now(),
  };

  return {
    messages: [notice, ...messages.slice(cut)],
    evicted: true,
    totalTokens,
    evictedMessageCount,
    evictedTokens: totalTokens - protectedTokens,
    protectedTokens,
  };
}

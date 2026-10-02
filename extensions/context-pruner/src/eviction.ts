/**
 * context-pruner — 裏方圧縮 ステップ 2/3: 一時退避安全弁（インメモリフィルター）＋
 * 章立て要約目次への差し替え
 *
 * 仕様: DENNOU_DOCS/COMPACTION_FEATURE.md §7.3 / §7.4 / §7.5
 *
 * コンテキストが evictionThresholdTokens（既定 1M 基準で 950K = baseContextTokens の 95%。
 * 500K モデルなら 475K、200K モデルなら 190K）を超え、
 * 裏方 Historian の要約が未完了のまま上限に迫った場合、プロンプト構築時に
 * 超過分が解消するまで最古の章から1章ずつ段階的に押し出す（漸進的スライディング
 * 退避）。直近 protectedRecentTokens（モデル適応スケーリングフロア。既定 1M 基準で
 * 128K、500K で 64K、200K で 16K）は不可侵の下限フロアであり、
 * 一括崖落ちドロップは行わない。
 *
 * ステップ 3 の拡張（§7.5 の「要約完成時の復帰・差し替え」）:
 * 退避対象となった過去領域のうち、要約（BlockSummary）が完成しているブロック群は
 * 単なる「過去ログ退避中注記」の代わりに、historian.ts の formatTableOfContents で
 * 生成した「章立て要約目次メッセージ（role: "user"）」へ差し替えてプロンプト先頭に
 * 復帰注入する。まだ要約が完了していないブロックがある場合は、その分の一時退避注記も
 * 併記する。これによりプロンプトは「章立て要約目次（数千トークン）＋ 直近保護テール
 * （1M 基準で 128K）の生データ」という理想的な軽量状態に落ち着く。
 *
 * 設計メモ:
 * - ファイルI/O・セッション操作は一切行わない純粋関数。セッションファイル
 *   （.jsonl）上の実ログは 100% 保持され、プロンプトへの注入のみがスキップ・差し替え
 *   される。退避は常に可逆で、SESSION_INTEGRITY_GUARD の親子リンク破壊リスクを構造的に
 *   排除する（§7.5）。
 * - 直近 protectedRecentTokens トークンは「1文字も削らない不可侵領域」（§7.4）。
 *   退避対象は常にそれより古い過去分のみ。トークン推定はステップ 1
 *   （compartment.ts の estimateMessageChars / estimateMessageTokens、約4文字=1
 *   トークン）に統一する。
 * - 章境界はステップ 1 の時間認識（detectTemporalPauses、§7.1）で求まる
 *   「会話の間（ま）」と partitionHistoryBlocks のブロック終端の和集合から、
 *   古い順に「先頭からの累積が超過分（total - threshold）に届く最初の境界」を
 *   採用する。第1章だけで収まれば第1章のみ退避し、第2章以降は生のまま残す。
 *   候補が無い・届かない場合は超過分に達する最小メッセージ境界まで進める
 *   （上限は直近保護フロアにクランプ）。
 * - 要約の差し替え適否判定: 退避領域へ完全に含まれるブロック（要約の endTime が
 *   保持テール先頭メッセージのタイムスタンプより前）の要約のみを目次へ適用する
 *   （保持テール途中にまでかかるブロックの要約は適用しない = 直近保護テールは決して
 *   差し替え・削除されない）。タイムスタンプが解釈できない場合は差し替えを見送る
 *   （要約の誤挿入を防ぐ安全側の挙動）。
 * - 退避発火時は先頭にシステム注記（role: "user" の notice message）を付与する。
 *   AgentMessage 型に "system" ロールが無いため "user" で表現する（設計書 §7.5
 *   は role: "system" または role: "user" のどちらかを許容する）。
 * - toolCall/toolResult ペアリング整合性: 保持テールの先頭が孤児 toolResult に
 *   ならないよう、ペアとなる assistant メッセージまで境界を後退させる
 *   （境界後退は「保持を増やす」方向にしか動かないため、直近保護フロアを下回らない）。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  detectTemporalPauses,
  estimateMessageTokens,
  partitionHistoryBlocks,
  resolveMeasuredPromptTokens,
  toEpochMs,
  DEFAULT_MIN_PAUSE_THRESHOLD_MS,
  DEFAULT_PAUSE_MULTIPLIER,
} from "./compartment.js";
import { formatTableOfContents, type BlockSummary } from "./historian.js";

/** 退避発火閾値（既定 950K トークン = 1M 基準コンテキストの 95%。小規模モデルは 95% へスケーリング）。 */
export const DEFAULT_EVICTION_THRESHOLD_TOKENS = 950_000;
/** 不可侵の直近保護ウィンドウのレガシーフォールバック（§7.4。base 不正時のみ使用。通常はモデル適応スケーリングフロア 128K/64K/16K）。 */
export const DEFAULT_PROTECTED_RECENT_TOKENS = 250_000;
/** 退避閾値の基準コンテキストサイズ（KASOU 運用設定 contextTokens: 1,000,000）。 */
export const DEFAULT_EVICTION_BASE_CONTEXT_TOKENS = 1_000_000;

/** 保護トークン数の短表記（128_000 → "128K"、1_000_000 → "1M"、端数はそのまま）。 */
export function formatProtectedTokensLabel(tokens: number): string {
  const floored = Math.floor(tokens);
  if (!Number.isFinite(floored) || floored <= 0) {
    return String(tokens);
  }
  if (floored % 1_000_000 === 0) {
    return `${floored / 1_000_000}M`;
  }
  if (floored % 1_000 === 0) {
    return `${floored / 1_000}K`;
  }
  return String(floored);
}

/**
 * 実際に保護される `protectedRecentTokens` の値に応じた動的注記。
 * 1M で 128K、500K で 64K、200K で 16K 等の表記になる。
 */
export function formatEvictionNotice(tokens: number): string {
  return `[システム注記: コンテキスト上限接近のため、直近${formatProtectedTokensLabel(tokens)}以前の過去ログは裏方要約完了まで一時退避中]`;
}
/** 退避時にプロンプト先頭へ付与するシステム注記（既定 1M 基準 = 128K 表記）。 */
export const DEFAULT_EVICTION_NOTICE = formatEvictionNotice(128_000);

/** 一時退避安全弁のオプション（すべて省略可）。 */
export type EvictionOptions = {
  /** 退避を発火する全体トークン閾値（実測優先。未指定時はモデル 95% 既定 = 1M で 950,000）。 */
  evictionThresholdTokens?: number;
  /** 不可侵の直近保護トークン数（実測/CJK補正推定で逆算。未指定時はスケーリングフロア）。 */
  protectedRecentTokens?: number;
  /** 「会話の間（ま）」と判定する最小の絶対沈黙フロア ms（既定 30分）。 */
  minPauseThresholdMs?: number;
  /** 平均インターバルの何倍で「間」とみなすかの係数（既定 3.0）。 */
  pauseMultiplier?: number;
  /** 退避時に先頭へ付与する注記テキスト（既定は protectedRecentTokens に応じた動的注記）。 */
  noticeText?: string;
  /**
   * 完了済みのブロック要約群（§7.5 の復帰差し替え用。opt-in）。
   * 退避領域に完全に含まれる要約済みブロックだけが章立て要約目次へ差し替えられる。
   */
  summaries?: BlockSummary[];
  /** 完了済みのブロック要約群（blockId キーの Map 版。reconcileBlockSummaries の出力をそのまま渡せる）。 */
  summaryMap?: Map<string, BlockSummary>;
  /** セッション transcript から累積した実測 prompt/context tokens。 */
  measuredTotalTokens?: number;
  /** transcript message または sessions.json の usage 値。実測値を優先する。 */
  measuredUsage?: readonly unknown[];
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
  /** 章立て要約目次へ差し替え適用された要約数（0 のときは注記のみの退避）。 */
  appliedSummaryCount: number;
};

/** kernel の compaction 設定のうち、安全弁が参照する最小形（agents.defaults.compaction）。 */
export type CompactionConfigLike = {
  /** Master switch for compaction and its pre-compaction side effects (default: true). */
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
};

/**
 * compaction 全体のキルスイッチ: `agents.defaults.compaction.enabled === false` のとき true。
 * 未指定（undefined）は既定の有効（false を返す）として扱い、既存動作を変えない。
 */
export function isCompactionDisabled(compaction: CompactionConfigLike | undefined): boolean {
  return compaction?.enabled === false;
}

/** 有効な正の数値のみ通す（不正値は null としてデフォルトへフォールバック）。 */
function positiveFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** summaries と summaryMap を統合する（summaries 優先、blockId で重複排除）。 */
function collectSummaries(options?: EvictionOptions): BlockSummary[] {
  const collected: BlockSummary[] = [];
  const seen = new Set<string>();
  const push = (summary: BlockSummary): void => {
    if (typeof summary.blockId === "string" && !seen.has(summary.blockId)) {
      seen.add(summary.blockId);
      collected.push(summary);
    }
  };
  for (const summary of options?.summaries ?? []) {
    push(summary);
  }
  for (const summary of options?.summaryMap?.values() ?? []) {
    push(summary);
  }
  return collected;
}

type ResolvedEvictionOptions = Required<
  Omit<EvictionOptions, "summaries" | "summaryMap" | "measuredTotalTokens" | "measuredUsage">
> & {
  /** summaries と summaryMap を統合・重複排除した配列。 */
  summaries: BlockSummary[];
  measuredTotalTokens?: number;
  measuredUsage?: readonly unknown[];
};

function resolveEvictionOptions(options?: EvictionOptions): ResolvedEvictionOptions {
  const protectedRecentTokens = Math.floor(
    positiveFinite(options?.protectedRecentTokens) ?? DEFAULT_PROTECTED_RECENT_TOKENS,
  );
  return {
    evictionThresholdTokens: Math.floor(
      positiveFinite(options?.evictionThresholdTokens) ?? DEFAULT_EVICTION_THRESHOLD_TOKENS,
    ),
    protectedRecentTokens,
    minPauseThresholdMs: Math.floor(
      positiveFinite(options?.minPauseThresholdMs) ?? DEFAULT_MIN_PAUSE_THRESHOLD_MS,
    ),
    pauseMultiplier: positiveFinite(options?.pauseMultiplier) ?? DEFAULT_PAUSE_MULTIPLIER,
    noticeText:
      typeof options?.noticeText === "string" && options.noticeText.trim() !== ""
        ? options.noticeText.trim()
        : formatEvictionNotice(protectedRecentTokens),
    summaries: collectSummaries(options),
    ...(options?.measuredTotalTokens !== undefined
      ? { measuredTotalTokens: options.measuredTotalTokens }
      : {}),
    ...(options?.measuredUsage ? { measuredUsage: options.measuredUsage } : {}),
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
 * EvictionOptions へ反映する。
 *
 * - `reserveTokens` 指定時: `evictionThresholdTokens = baseContextTokens - reserveTokens`
 *   （既定 base = 1,000,000。reserve 50,000 で 950,000 = DEFAULT_EVICTION_THRESHOLD_TOKENS）。
 *   明示指定があればこちらを優先する。
 * - `reserveTokens` 未指定時: `evictionThresholdTokens = モデルの 95%`
 *  （1M: 950K / 500K: 475K / 200K: 190K。小規模モデルでも安全弁が発火する）。
 * - `keepRecentTokens` 指定時: `protectedRecentTokens` を上書きする。
 * - `keepRecentTokens` 未指定時: `baseContextTokens` に応じたモデル適応スケーリング
 *   保護フロアを設定する（1M: 128K / 500K: 64K / 200K: 16K / それ未満: max(8K, base*0.08)）。
 */
export function resolveEvictionOptionsFromCompaction(
  compaction: CompactionConfigLike | undefined,
  baseContextTokens: number = DEFAULT_EVICTION_BASE_CONTEXT_TOKENS,
): EvictionOptions {
  const options: EvictionOptions = {};
  const base = Math.floor(baseContextTokens);
  const validBase = Number.isFinite(base) && base > 0 ? base : DEFAULT_EVICTION_BASE_CONTEXT_TOKENS;
  if (
    typeof compaction?.reserveTokens === "number" &&
    Number.isFinite(compaction.reserveTokens) &&
    compaction.reserveTokens >= 0
  ) {
    options.evictionThresholdTokens = Math.max(1, validBase - Math.floor(compaction.reserveTokens));
  } else {
    options.evictionThresholdTokens = resolveScaledEvictionThresholdTokens(validBase);
  }
  if (
    typeof compaction?.keepRecentTokens === "number" &&
    Number.isFinite(compaction.keepRecentTokens) &&
    compaction.keepRecentTokens > 0
  ) {
    options.protectedRecentTokens = Math.floor(compaction.keepRecentTokens);
  } else {
    options.protectedRecentTokens = resolveScaledProtectedRecentTokens(baseContextTokens);
  }
  return options;
}

/**
 * モデルコンテキストサイズに応じた退避発火閾値のスケーリング（コンテキストの 95%）。
 * 明示的な `reserveTokens` が無い場合のデフォルトを返す。
 *
 * - 1M: 950,000 / 500K: 475,000 / 200K: 190,000
 */
export function resolveScaledEvictionThresholdTokens(baseContextTokens: number): number {
  const base = Math.floor(baseContextTokens);
  if (!Number.isFinite(base) || base <= 0) {
    return DEFAULT_EVICTION_THRESHOLD_TOKENS;
  }
  return Math.max(1, Math.floor(base * 0.95));
}

/**
 * モデルコンテキストサイズに応じた保護フロアのスケーリング。
 * 明示的な `keepRecentTokens` が無い場合のデフォルトを返す。
 *
 * - base >= 1,000,000: 128,000 (128K)
 * - base >= 500,000: 64,000 (64K)
 * - base >= 200,000: 16,000 (16K)
 * - それ未満: max(8,000, floor(base * 0.08))
 */
export function resolveScaledProtectedRecentTokens(baseContextTokens: number): number {
  const base = Math.floor(baseContextTokens);
  if (!Number.isFinite(base) || base <= 0) {
    return DEFAULT_PROTECTED_RECENT_TOKENS;
  }
  if (base >= 1_000_000) {
    return 128_000;
  }
  if (base >= 500_000) {
    return 64_000;
  }
  if (base >= 200_000) {
    return 16_000;
  }
  return Math.max(8_000, Math.floor(base * 0.08));
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
 * 一時退避安全弁（§7.3 / §7.4 / §7.5）。人間らしい漸進的忘却。
 *
 * 1. provider/session の実測 prompt tokens（利用可能な場合）を優先し、無ければ
 *    CJK 補正済みの入力推定トークン数を使う。閾値以下なら退避しない（元の配列をそのまま返す）。
 * 2. 超過時は必要な最小退避量 neededEvictionTokens = total - threshold を求め、
 *    末尾から逆走査し直近 protectedRecentTokens に達する最小境界 maxCutIndex を
 *    特定する（直近保護ウィンドウは不可侵の下限フロア）。
 * 3. 時間認識の「間」（detectTemporalPauses）と partitionHistoryBlocks のブロック
 *    終端の和集合を章境界候補とし、古い順に「先頭からの累積が超過分に届く最初の
 *    境界」を cut に採用する（第1章だけで収まれば第1章のみ退避）。
 *    候補が無い・届かない場合は超過分に達する最小メッセージ境界まで進める
 *    （上限は maxCutIndex にクランプ）。
 * 4. toolCall/toolResult のペアリング整合性を保つ（先頭に孤児 toolResult を置かない）。
 * 5. 退避領域 [0..cut-1] に完全に含まれる要約済みブロックだけを目次化し先頭へ注入。
 *    退避されなかった章は生メッセージのまま残る。
 *
 * 純粋なインメモリ変換であり、セッションファイル（.jsonl）への読み書きは一切行わない。
 */
export function applyPromptEvictionSafetyValve(
  messages: AgentMessage[],
  options?: EvictionOptions,
): EvictionResult {
  const opts = resolveEvictionOptions(options);
  const estimates = messages.map(estimateMessageTokens);
  const estimatedTotalTokens = estimates.reduce((sum, value) => sum + value, 0);
  const measuredTotalTokens =
    positiveFinite(opts.measuredTotalTokens) ??
    (opts.measuredUsage ? resolveMeasuredPromptTokens(opts.measuredUsage) : undefined);
  // Provider/session usage is the source of truth for the firing decision. Scale
  // each message's CJK-aware estimate to the measured current context so the
  // protected-tail reverse scan uses the same units as the scaled-floor policy.
  const measurementScale =
    measuredTotalTokens !== undefined && estimatedTotalTokens > 0
      ? measuredTotalTokens / estimatedTotalTokens
      : 1;
  const effectiveEstimates =
    measuredTotalTokens !== undefined
      ? estimates.map((value) => Math.floor(value * measurementScale))
      : estimates;
  if (measuredTotalTokens !== undefined && effectiveEstimates.length > 0) {
    const scaledTotal = effectiveEstimates.reduce((sum, value) => sum + value, 0);
    effectiveEstimates[effectiveEstimates.length - 1] += measuredTotalTokens - scaledTotal;
  }
  const totalTokens = measuredTotalTokens ?? estimatedTotalTokens;

  const noEviction = (): EvictionResult => ({
    messages,
    evicted: false,
    totalTokens,
    evictedMessageCount: 0,
    evictedTokens: 0,
    protectedTokens: totalTokens,
    appliedSummaryCount: 0,
  });

  // 閾値以下: 退避不要（§7.3 の発火条件に未達）
  if (totalTokens <= opts.evictionThresholdTokens) {
    return noEviction();
  }
  if (messages.length === 0) {
    return noEviction();
  }

  // ── 超過分と直近保護フロア（§7.4）──
  // neededEvictionTokens: 閾値以下に収めるために最低限退避すべきトークン量。
  // maxCutIndex: suffixTokens[maxCutIndex..end] >= protectedRecentTokens を満たす
  // 最小 index。cut はこれを超えられない（直近保護ウィンドウは不可侵）。
  const neededEvictionTokens = totalTokens - opts.evictionThresholdTokens;
  const minProtected = Math.max(1, opts.protectedRecentTokens);
  let maxCutIndex = messages.length;
  let suffixTokens = 0;
  while (maxCutIndex > 0 && suffixTokens < minProtected) {
    maxCutIndex -= 1;
    suffixTokens += effectiveEstimates[maxCutIndex];
  }
  // 保護ウィンドウが全体を覆う場合（設定異常など）は退避しない
  if (maxCutIndex === 0) {
    return noEviction();
  }

  // 先頭からの累積退避トークン（実測スケール済み推定の prefix sum）。
  const prefixTokens = new Array<number>(messages.length + 1);
  prefixTokens[0] = 0;
  for (let i = 0; i < messages.length; i++) {
    prefixTokens[i + 1] = prefixTokens[i] + effectiveEstimates[i];
  }

  // ── 章（ブロック）境界の候補を古い順に収集（§7.1 / §7.2）──
  // 「間」の直後 (p + 1) と partitionHistoryBlocks の各ブロック終端 (endIndex + 1)
  // の和集合。0 < cand <= maxCutIndex のみ有効（直近保護フロアを侵さない）。
  const candidates = new Set<number>();
  const pauses = detectTemporalPauses(messages, {
    minPauseThresholdMs: opts.minPauseThresholdMs,
    pauseMultiplier: opts.pauseMultiplier,
  });
  for (const pause of pauses) {
    const cand = pause + 1;
    if (cand > 0 && cand <= maxCutIndex) {
      candidates.add(cand);
    }
  }
  for (const block of partitionHistoryBlocks(messages, {
    minPauseThresholdMs: opts.minPauseThresholdMs,
    pauseMultiplier: opts.pauseMultiplier,
  })) {
    const cand = block.endIndex + 1;
    if (cand > 0 && cand <= maxCutIndex) {
      candidates.add(cand);
    }
  }
  const orderedCandidates = [...candidates].sort((a, b) => a - b);

  // ── 最古の章から順にスライド判定 ──
  // 先頭からの累積 prefixTokens[cand] が超過分に届く【最初の（最も手前の）境界】
  // を採用。第1章だけで収まれば第1章のみ退避し、第2章以降は生のまま残る。
  let cut = -1;
  for (const cand of orderedCandidates) {
    if (prefixTokens[cand] >= neededEvictionTokens) {
      cut = cand;
      break;
    }
  }
  if (cut === -1) {
    // 候補が無い、またはどの候補でも超過分に届かない場合: 超過分に達する
    // 最小メッセージ境界まで進める（上限は maxCutIndex にクランプ）。
    cut = maxCutIndex;
    for (let i = 1; i <= maxCutIndex; i++) {
      if (prefixTokens[i] >= neededEvictionTokens) {
        cut = i;
        break;
      }
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
  const protectedTokens = effectiveEstimates.slice(cut).reduce((sum, value) => sum + value, 0);
  const evictedTokens = totalTokens - protectedTokens;

  // ── 章立て要約目次による復帰差し替え（§7.5 通常成功パス）──
  // 退避された過去領域のうち、要約が完了しているブロック（endTime が保持テール先頭
  // タイムスタンプより前 = 完全に退避領域へ含まれるブロック）だけを
  // formatTableOfContents の目次メッセージ（role: "user"）へ差し替えてプロンプト先頭へ
  // 復帰注入する。まだ要約が完了していない分（coveredTokens が退避トークンに満たない分）は
  // 従来どおり一時退避注記を併記する。
  // タイムスタンプが解釈できない場合は差し替えを見送る（要約の誤挿入を防ぐ安全側の挙動）。
  const applicable: BlockSummary[] = [];
  let coveredTokens = 0;
  if (cut < messages.length) {
    const boundaryEpochMs = toEpochMs(messages[cut].timestamp);
    if (boundaryEpochMs !== null) {
      for (const summary of opts.summaries) {
        const endMs = toEpochMs(summary.endTime);
        if (endMs !== null && endMs < boundaryEpochMs) {
          applicable.push(summary);
          const tokens =
            typeof summary.tokenCount === "number" && Number.isFinite(summary.tokenCount)
              ? Math.max(0, Math.floor(summary.tokenCount))
              : 0;
          coveredTokens += tokens;
        }
      }
    }
  }
  const allEvictedCovered = coveredTokens >= evictedTokens;

  const front: AgentMessage[] = [];
  if (applicable.length > 0) {
    front.push({
      role: "user",
      content: formatTableOfContents(applicable),
      timestamp: Date.now(),
    });
  }
  if (!allEvictedCovered) {
    front.push({ role: "user", content: opts.noticeText, timestamp: Date.now() });
  }

  return {
    messages: [...front, ...messages.slice(cut)],
    evicted: true,
    totalTokens,
    evictedMessageCount,
    evictedTokens,
    protectedTokens,
    appliedSummaryCount: applicable.length,
  };
}

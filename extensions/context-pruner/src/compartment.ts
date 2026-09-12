/**
 * context-pruner — 裏方圧縮 ステップ 1: ブロック分割エンジン（時間認識＋サイズ上限）
 *
 * 仕様: DENNOU_DOCS/COMPACTION_FEATURE.md §7.1 / §7.2
 *
 * 会話メッセージ列から「会話の間（ま）」を認識し、1ブロック（章）のサイズ上限
 * （maxHistoryShare、既定 500K トークン）手前の自然な切れ目でブロック
 * （コンパートメント）に分割する純粋関数モジュール。
 *
 * - 時間認識（§7.1）: 各メッセージのタイムスタンプからインターバルを算出し、
 *   「平均インターバル × pauseMultiplier かつ minPauseThresholdMs（既定30分）
 *   以上」の沈黙を「会話の途切れ・間（ま）」として検出する。
 * - サイズ上限（§7.2）: maxBlockTokens（既定 500,000 = contextTokens 1M ×
 *   maxHistoryShare 0.5）に達する手前で、直近の自然な「間」のポイントで分割する。
 *   「間」が無い場合は上限を超えない最後のメッセージ境界でフォールバック分割する。
 *
 * 設計メモ:
 * - ファイルI/O・セッション操作は一切行わない純粋関数（本ステップは計算・分割
 *   ロジックと単体テストの新設のみ。既存のセッションファイル/会話データは変更しない）。
 * - トークン推定は「約4文字 = 1トークン」の簡易近似（カーネル側の
 *   CHARS_PER_TOKEN_ESTIMATE と同じ係数）。ブロック分割のバジェット管理が目的の
 *   ため高精度なトークナイザは使わない。画像ブロックは Base64 data 文字列も
 *   テキスト同様に文字数へ含める。
 * - タイムスタンプは epoch ミリ秒（number）と ISO 8601 文字列の両方を許容する
 *   （インメモリの AgentMessage は number、セッションJSONL由来は文字列の場合がある）。
 * - 単一メッセージが maxBlockTokens を超える極端なメッセージ（巨大ツール結果等）は
 *   メッセージ単位の分割がスコープ外のため単独ブロック化する（既知の限界:
 *   そのブロックだけはバジェット超過になり得る）。
 */

import {
  estimateStringChars,
  estimateTokensFromChars,
  CHARS_PER_TOKEN_ESTIMATE,
} from "openclaw/plugin-sdk/text-runtime";

/** 会話メッセージの最小構造（分割ロジックが必要とするフィールドのみ）。 */
export type CompartmentMessage = {
  /** メッセージのタイムスタンプ（epoch ミリ秒 or ISO 8601 文字列） */
  timestamp: number | string;
  /** メッセージ内容（トークン推定に使用。ロールにより string またはブロック配列） */
  content?: unknown;
};

/** 1ブロック（コンパートメント / 1章）のメタデータ。 */
export type HistoryBlock = {
  /** 一意のブロックID（例: "block-1"） */
  id: string;
  /** 開始メッセージインデックス（messages 配列の 0 始まり） */
  startIndex: number;
  /** 終了メッセージインデックス（含む） */
  endIndex: number;
  /** ブロック内のメッセージ数 */
  messageCount: number;
  /** 開始タイムスタンプ（先頭メッセージのもの） */
  startTime: number | string;
  /** 終了タイムスタンプ（末尾メッセージのもの） */
  endTime: number | string;
  /** 推定トークン数（約4文字 = 1トークンの簡易近似） */
  tokenCount: number;
  /** 前のブロックとの間の沈黙時間（ミリ秒）。先頭ブロックには無い */
  boundaryPauseMs?: number;
};

/** ブロック分割オプション（すべて省略可）。 */
export type PartitionOptions = {
  /** 1ブロックの最大トークンバジェット（既定 500,000） */
  maxBlockTokens?: number;
  /** 「間」と判定する最小の絶対沈黙フロア ms（既定 30分 = 1,800,000） */
  minPauseThresholdMs?: number;
  /** 平均インターバルの何倍で「間」とみなすかの係数（既定 3.0） */
  pauseMultiplier?: number;
};

/** 既定の1ブロック最大トークン数（§7.2: contextTokens 1M × maxHistoryShare 0.5） */
export const DEFAULT_MAX_BLOCK_TOKENS = 500_000;
/** 既定の「間」判定絶対フロア（30分） */
export const DEFAULT_MIN_PAUSE_THRESHOLD_MS = 30 * 60 * 1000;
/** 既定の平均インターバル倍率 */
export const DEFAULT_PAUSE_MULTIPLIER = 3.0;

/** 有効な正の数値のみ通す（不正値は null としてデフォルトへフォールバック）。 */
function positiveFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function resolvePartitionOptions(options?: PartitionOptions): Required<PartitionOptions> {
  return {
    maxBlockTokens: Math.floor(positiveFinite(options?.maxBlockTokens) ?? DEFAULT_MAX_BLOCK_TOKENS),
    minPauseThresholdMs: Math.floor(
      positiveFinite(options?.minPauseThresholdMs) ?? DEFAULT_MIN_PAUSE_THRESHOLD_MS,
    ),
    pauseMultiplier: positiveFinite(options?.pauseMultiplier) ?? DEFAULT_PAUSE_MULTIPLIER,
  };
}

/** タイムスタンプを epoch ミリ秒に正規化する。解釈できない場合は null。 */
export function toEpochMs(timestamp: number | string): number | null {
  if (typeof timestamp === "number") {
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof timestamp === "string" && timestamp.trim() !== "") {
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** 2メッセージ間の沈黙時間（ms）。タイムスタンプ欠損・時計戻りは undefined。 */
function computeGapMs(left: CompartmentMessage, right: CompartmentMessage): number | undefined {
  const a = toEpochMs(left.timestamp);
  const b = toEpochMs(right.timestamp);
  if (a === null || b === null) {
    return undefined;
  }
  const delta = b - a;
  return delta >= 0 ? delta : undefined;
}

/** メッセージ content から文字数を概算する（string 直 or ブロック配列の text/data 合計）。 */
export function estimateMessageChars(content: unknown): number {
  if (typeof content === "string") {
    return estimateStringChars(content);
  }
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const record = block as Record<string, unknown>;
      if (typeof record.text === "string") {
        total += estimateStringChars(record.text);
      } else if (typeof record.data === "string") {
        total += estimateStringChars(record.data);
      }
    }
    return total;
  }
  return 0;
}

/** メッセージの推定トークン数（CJK補正済み。空でも構造分の1トークン）。 */
export function estimateMessageTokens(message: CompartmentMessage): number {
  const chars = estimateMessageChars(message.content);
  return chars > 0 ? estimateTokensFromChars(chars) : 1;
}

/**
 * プロバイダーが返した usage から現在の prompt/context トークンを抽出する。
 * 実測 usage は文字数推定より先に安全弁の判定と保持量換算へ使う。
 */
function resolvePromptTokensFromUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const number = (...values: unknown[]): number | undefined => {
    const value = values.find((candidate) => typeof candidate === "number");
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const input = number(
    record.input,
    record.inputTokens,
    record.input_tokens,
    record.promptTokens,
    record.prompt_tokens,
  );
  const cacheRead = number(
    record.cacheRead,
    record.cache_read,
    record.cacheReadInputTokens,
    record.cache_read_input_tokens,
    record.cached_tokens,
  );
  const cacheWrite = number(
    record.cacheWrite,
    record.cache_write,
    record.cacheCreationInputTokens,
    record.cache_creation_input_tokens,
  );
  const total = number(record.total, record.totalTokens, record.total_tokens);
  const prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  if (prompt > 0) {
    return prompt;
  }
  return total !== undefined && total > 0 ? total : undefined;
}

/**
 * Transcript message 群に含まれる provider usage の最新 prompt/context snapshot を返す。
 * usage が一件も無い場合は undefined を返し、呼び出し側が文字数推定へフォールバックできる。
 * `/status` の累積表示は別の読み取り経路で全 usage を合算するため、ここは現在の
 * prompt build と比較するための「最新実測値」に限定する。
 */
export function resolveMeasuredPromptTokens(messages: readonly unknown[]): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const record = message as Record<string, unknown>;
    const usage =
      record.usage ??
      (record.message && typeof record.message === "object" && !Array.isArray(record.message)
        ? (record.message as Record<string, unknown>).usage
        : undefined);
    const promptTokens = resolvePromptTokensFromUsage(usage);
    if (promptTokens !== undefined) {
      latest = promptTokens;
    }
  }
  return latest;
}

/**
 * 会話の「間（ま）」を検出し、そのギャップインデックス一覧を返す。
 *
 * 返り値の各要素 g は「messages[g] と messages[g+1] の間に『間』がある」ことを表す
 * （g は左側メッセージのインデックス）。partitionHistoryBlocks はこの g を
 * 「ブロックの終端境界」（ブロックは g まで、次は g+1 から）として使う。
 *
 * 判定条件（§7.1）: インターバルが「平均インターバル × pauseMultiplier」以上
 * **かつ**「minPauseThresholdMs（絶対フロア）」以上のとき「間」とみなす。
 *
 * タイムスタンプが解釈できない箇所はインターバル連鎖をリセットし、間隔が負
 * （時計戻り・順序異常）の箇所はインターバル計算から除外する。
 */
export function detectTemporalPauses(
  messages: readonly CompartmentMessage[],
  options?: PartitionOptions,
): number[] {
  const opts = resolvePartitionOptions(options);

  // 第1パス: 有効なインターバルと対応するギャップ（左側メッセージインデックス）を収集
  const intervals: number[] = [];
  const gaps: number[] = [];
  let prevEpochMs: number | null = null;
  for (let i = 0; i < messages.length; i++) {
    const epochMs = toEpochMs(messages[i].timestamp);
    if (epochMs === null) {
      prevEpochMs = null; // 欠損タイムスタンプ: この箇所でインターバル連鎖をリセット
      continue;
    }
    if (prevEpochMs !== null) {
      const delta = epochMs - prevEpochMs;
      if (delta >= 0) {
        intervals.push(delta);
        gaps.push(i - 1);
      }
    }
    prevEpochMs = epochMs;
  }
  if (intervals.length === 0) {
    return [];
  }

  const meanIntervalMs = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const thresholdMs = Math.max(meanIntervalMs * opts.pauseMultiplier, opts.minPauseThresholdMs);

  const pauses: number[] = [];
  for (let k = 0; k < intervals.length; k++) {
    if (intervals[k] >= thresholdMs) {
      pauses.push(gaps[k]);
    }
  }
  return pauses;
}

/**
 * 会話メッセージ列をブロック（コンパートメント）に分割する。
 *
 * 戦略（§7.1 / §7.2）:
 * 1. 先頭から累積トークンを数え、maxBlockTokens を超えそうになった時点で、
 *    現在のブロック内にある「最後の自然な間（ま）」のギャップで分割する
 *    （そのギャップ以降の累積がバジェット内に収まる場合のみ。収まらない場合は
 *    より手前の「間」を試す）。
 * 2. ブロック内に「間」が無い（または全てバジェット超過になる）場合は、
 *    上限を超えない最後のメッセージ境界（超過直前）でフォールバック分割する。
 * 3. 単一メッセージがバジェットを超える場合は単独ブロック化する
 *    （メッセージ内分割はスコープ外の既知の限界）。
 *
 * 返り値はメッセージ列全体を連続的にカバーする HistoryBlock の配列
 * （空入力は空配列）。タイムスタンプが解釈できなくても位置ベースで分割は継続する。
 */
export function partitionHistoryBlocks(
  messages: readonly CompartmentMessage[],
  options?: PartitionOptions,
): HistoryBlock[] {
  const opts = resolvePartitionOptions(options);
  if (messages.length === 0) {
    return [];
  }

  // トークン推定と累積和（分割後の tokenCount / 再累積を O(1) で求めるため）
  const tokenEstimates = messages.map(estimateMessageTokens);
  const prefixTokens = new Array<number>(messages.length + 1);
  prefixTokens[0] = 0;
  for (let i = 0; i < messages.length; i++) {
    prefixTokens[i + 1] = prefixTokens[i] + tokenEstimates[i];
  }

  // 「間」のギャップ一覧（昇順）。分割時にカーソルを進めながら消費する
  const pauseGaps = detectTemporalPauses(messages, options);
  let pauseCursor = 0;

  const blocks: HistoryBlock[] = [];
  const closeBlock = (startIndex: number, endIndex: number): void => {
    let boundaryPauseMs: number | undefined;
    if (startIndex > 0) {
      boundaryPauseMs = computeGapMs(messages[startIndex - 1], messages[startIndex]);
    }
    blocks.push({
      id: `block-${blocks.length + 1}`,
      startIndex,
      endIndex,
      messageCount: endIndex - startIndex + 1,
      startTime: messages[startIndex].timestamp,
      endTime: messages[endIndex].timestamp,
      tokenCount: prefixTokens[endIndex + 1] - prefixTokens[startIndex],
      ...(boundaryPauseMs !== undefined ? { boundaryPauseMs } : {}),
    });
  };

  let start = 0;
  let runningTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    const tokens = tokenEstimates[i];

    // 単一メッセージがバジェット超過（巨大ツール結果など）: 単独ブロック化
    if (tokens > opts.maxBlockTokens) {
      if (i > start) {
        closeBlock(start, i - 1);
      }
      closeBlock(i, i);
      start = i + 1;
      runningTokens = 0;
      continue;
    }

    if (i > start && runningTokens + tokens > opts.maxBlockTokens) {
      // このブロック窓内のギャップを消費（以降の分割では再利用しない）
      while (pauseCursor < pauseGaps.length && pauseGaps[pauseCursor] < i) {
        pauseCursor++;
      }
      // 上限を超えない「最後の自然な間」を探す。無ければ上限直前でフォールバック
      let cut = i - 1;
      for (let k = pauseCursor - 1; k >= 0 && pauseGaps[k] >= start; k--) {
        if (prefixTokens[i + 1] - prefixTokens[pauseGaps[k] + 1] <= opts.maxBlockTokens) {
          cut = pauseGaps[k];
          break;
        }
      }
      closeBlock(start, cut);
      start = cut + 1;
      // 新しいブロックの累積（messages[start..i] を含む）
      runningTokens = prefixTokens[i + 1] - prefixTokens[start];
    } else {
      runningTokens += tokens;
    }
  }
  if (start < messages.length) {
    closeBlock(start, messages.length - 1);
  }
  return blocks;
}

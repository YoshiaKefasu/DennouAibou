/**
 * 自動圧縮コア（context ハンドラと手動 /nap が共有・DRY）。
 *
 * 保証の考え方:
 * - 発火判定は `getContextUsage()` のプロバイダ実測 tokens（折りたたみ後＝folded）を第一に使う。
 *   自前推定は usage が null の時だけフォールバックする。
 * - 圧縮量は「比率」で決める。推定器とプロバイダ実測の絶対値は
 *   （プロンプトキャッシュ等で）ずれ得るため、
 *   `allowed = 推定(入力) × target/実測 × 安全マージン` まで削る。
 *   これで推定器のキャリブレーション誤差に依らず target 以下を狙える。
 * - 計測空間の統一: `usageTokens` は必ず圧縮入力（生 branch＝未折りたたみ）と
 *   同一空間の値を渡す。folded 実測をそのまま渡すと2発目以降に keep 予算が
 *   膨らみ target を超過するため、呼び出し側で生空間へ補正する
 *  （`resolveRawCompressionTokens`: `max(folded, 推定(生))`）。
 *
 * Note: 最終安全弁は持たない。本体の `context-pruner` に委譲する。
 *
 * 不変条件:
 * - system ロールは作らない・通さない（先頭注入は user ロール1件）。
 * - ターン原子性: toolCall と対応 toolResult を分断しない。
 * - 出力先頭が孤立 toolResult にならない。全 toolResult に対応 toolCall がある。
 */

import type { TriageChoice } from "./types.js";

/** SDK の AgentMessage に構造的に一致する最小形（SDKへの直接依存なし）。 */
export interface CompactableMessage {
  role: string;
  content: unknown;
  timestamp?: number | string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
}

export interface CompactTurn {
  id: number;
  messages: CompactableMessage[];
  text: string;
  startedAt?: number;
  endedAt?: number;
}

export interface CompactChapter {
  id: number;
  turns: CompactTurn[];
  startedAt?: number;
  endedAt?: number;
  gapBeforeMs?: number;
}

/** ターン単位の仕分け結果（維持/要約/落とす）。失敗時は呼び出し側で「維持」に倒す。 */
export type TriageFn = (texts: string[]) => Promise<TriageChoice[]>;

export type SummarizerFn = (targets: string[], context: string) => Promise<string> | string;

export interface CompressOptions {
  /**
   * 圧縮入力（生 branch＝未折りたたみ空間）の現在トークン。null 不可。
   * 呼び出し側は folded 実測（`getContextUsage().tokens`）をそのまま渡さず、
   * 生空間へ補正した値（`resolveRawCompressionTokens`）を渡すこと。
   */
  usageTokens: number;
  contextWindow: number;
  thresholdRatio: number;
  targetRatio: number;
  maGapMs: number;
  /**
   * 生データ維持ブロックのトークン上限比率（contextWindow連動）。既定0.25・範囲0.05〜0.5。
   * 過去章の維持合計が `contextWindow * maxKeptRatio` を超えたら
   * 最も古い維持から順に要約へ昇華させる。範囲外は既定に倒す。
   */
  maxKeptRatio?: number;
  /**
   * 直近章保持ガード（note #146）: 末尾この章数は仕分け・要約の対象外として
   * 100%生保持する。既定250。最新章の免疫は別不変条件のため最低1章は常に保護。
   */
  protectRecentChapters?: number;
  /** System 1 仕分け。未指定なら全維持（Laya/Jev 全滅時と等価）。 */
  triage?: TriageFn;
  /** 1回の圧縮で使う System 1 呼び出し回数の上限（最古ターンから消費）。超過分は「維持」。既定は無制限。 */
  triageBudget?: number;
  /** Historian 要約。未指定なら決定論的抜粋。 */
  summarizer?: SummarizerFn;
  /** true のとき閾値未満でも強制圧縮（手動 /nap 用）。 */
  force?: boolean;
}

export interface CompressStats {
  fired: boolean;
  /** 発火判定に使った実測値。 */
  tokensBefore: number;
  contextWindow: number;
  usageRatio: number;
  /** 推定器で測った入力サイズ。 */
  estimatedBefore: number;
  /** 推定器で測った出力サイズ。 */
  estimatedAfter: number;
  chapters: number;
  keepTurns: number;
  summarizeTurns: number;
  dropTurns: number;
  evictedChapters: number;
  /** 直近章ガード（note #146）で保護した章数（動的キャップ適用後の実効値）。 */
  protectedChapters: number;
  /**
   * 出力が内部予算（allowedEst＝推定×target/実測×安全マージン）に収まらなかったら true。
   * 保護部の不可侵・単一巨大章などで起きる。呼び出し側はこの信号で
   * 本体 context-pruner 等の最終手段へ委譲する（要約ヘッダだけ足した
   * applied:true の成功偽装はしない——targetMissed で正直に申告する）。
   */
  targetMissed: boolean;
  /** 生維持上限トークン（contextWindow * maxKeptRatio）。 */
  maxKeptTokens: number;
  /** 処理対象の過去章に残った生維持トークン（上限内に収まる）。 */
  keptPastTokens: number;
  /** 上限超過で要約へ昇華させた維持ターン数（最も古い順）。 */
  keptScaledDownTurns: number;
  orphanToolResultsRemoved: number;
  orphanToolCallsRemoved: number;
  /** System 1 呼び出しの失敗（タイムアウト・エラー・不正形状）で「維持」に倒したターン数。 */
  triageFailures: number;
  summaryFromCache: boolean;
  elapsedMs: number;
}

export interface CompressOutcome {
  applied: boolean;
  messages: CompactableMessage[];
  stats: CompressStats;
  /** 先頭に注入した要約メッセージの本文（applied のときのみ非空）。 */
  summaryText: string;
  /**
   * kept 先頭に対応する入力配列インデックス（`input` 座標・system 込み）。
   * 逆引き不要で `branchMessages[index].id` から firstKeptEntryId を直接引ける。
   * kept 無し・未適用時は -1。
   */
  firstKeptInputIndex: number;
}

/** 推定器の換算レート。プロバイダ実測より大きめに出る保守側の値。 */
export const CHARS_PER_TOKEN = 3;
/** 画像1枚の固定コスト（推定）。 */
export const IMAGE_TOKEN_COST = 1500;
/** 決定論的要約で各ターンから抜粋する文字数。 */
export const DETERMINISTIC_EXCERPT_CHARS = 400;
/** 目標に対する安全マージン（推定誤差・要約文の上振れ吸収）。 */
const TARGET_MARGIN = 0.9;
/**
 * 保護章キャップの予算比率（要約ヘッダ＝目次＋抜粋分の余白）。
 * 保護部の生合計を `allowedEst` ギリギリまで詰めると、要約ヘッダを足した
 * 最終出力が予算を超過するため、`allowedEst * PROTECT_BUDGET_RATIO` を
 * 保護判定の上限にする。
 */
const PROTECT_BUDGET_RATIO = 0.95;
/** 生維持上限の既定比率（contextWindow連動）。config既定と同一。 */
export const DEFAULT_MAX_KEPT_RATIO = 0.25;
/** maxKeptRatio の許容範囲。範囲外は既定に倒す。 */
export const MIN_MAX_KEPT_RATIO = 0.05;
export const MAX_MAX_KEPT_RATIO = 0.5;
/**
 * 直近章ガードの既定値（compressToTarget未指定時）。
 * config-loader の既定値（250）・スキーマ既定（250）と同一。
 * 実効保護章数は target 以内に収まる範囲まで自動で絞られるため、
 * 章数が少ない会話でも保護部だけで target を食い潰さない（下の動的キャップ参照）。
 * 最低1章（最新章免疫）は常に保護する。
 */
export const DEFAULT_PROTECT_RECENT_CHAPTERS = 250;

/** maxKeptRatio正規化: 非数・範囲外は既定に倒す。 */
function normalizeKeptRatio(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_KEPT_RATIO;
  }
  if (value < MIN_MAX_KEPT_RATIO || value > MAX_MAX_KEPT_RATIO) {
    return DEFAULT_MAX_KEPT_RATIO;
  }
  return value;
}

/** protectRecentChapters正規化: 非数は既定(250)・負数は0に倒し整数化する。 */
function normalizeProtectCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_PROTECT_RECENT_CHAPTERS;
  }
  return Math.max(0, Math.floor(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function partChars(part: unknown): { chars: number; images: number } {
  if (!isRecord(part)) return { chars: 0, images: 0 };
  const type = part["type"];
  if (type === "text" && typeof part["text"] === "string") {
    return { chars: part["text"].length, images: 0 };
  }
  if (type === "thinking" && typeof part["thinking"] === "string") {
    return { chars: part["thinking"].length, images: 0 };
  }
  if (type === "toolCall") {
    const name = typeof part["name"] === "string" ? part["name"] : "";
    let args = "";
    try {
      args = JSON.stringify(part["arguments"] ?? {});
    } catch {
      args = "";
    }
    const id = typeof part["id"] === "string" ? part["id"] : "";
    return { chars: name.length + args.length + id.length, images: 0 };
  }
  if (type === "image") {
    for (const [key, value] of Object.entries(part)) {
      if (key === "data") continue; // base64本体は走査しない
      if (typeof value === "string" && value.includes("inbound_media")) {
        return { chars: value.length, images: 1 };
      }
    }
    return { chars: 0, images: 1 };
  }
  return { chars: 0, images: 0 };
}

/** toolCall 引数・画像を含む保守的推定。 */
export function estimateMessageTokens(message: CompactableMessage): number {
  const content = message.content;
  let chars = message.role.length;
  let images = 0;
  if (typeof content === "string") {
    chars += content.length;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      const r = partChars(part);
      chars += r.chars;
      images += r.images;
    }
  } else if (isRecord(content)) {
    try {
      chars += JSON.stringify(content).length;
    } catch {
      chars += 64;
    }
  }
  if (typeof message.toolCallId === "string") chars += message.toolCallId.length;
  if (typeof message.toolName === "string") chars += message.toolName.length;
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKEN_COST;
}

export function estimateTokens(messages: CompactableMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

function turnText(messages: CompactableMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const content = m.content;
    if (typeof content === "string") {
      lines.push(`${m.role}: ${content}`);
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part["type"] === "text" && typeof part["text"] === "string") {
          parts.push(part["text"]);
        } else if (part["type"] === "thinking" && typeof part["thinking"] === "string") {
          parts.push(part["thinking"]);
        } else if (part["type"] === "toolCall") {
          const name = typeof part["name"] === "string" ? part["name"] : "tool";
          let args = "";
          try {
            args = JSON.stringify(part["arguments"] ?? {});
          } catch {
            args = "";
          }
          parts.push(`[toolCall ${name} ${args}]`);
        } else if (part["type"] === "image") {
          let kept = "";
          for (const [key, value] of Object.entries(part)) {
            if (key === "data") continue; // base64本体は走査しない
            if (typeof value === "string" && value.includes("inbound_media")) {
              kept = value;
              break;
            }
          }
          parts.push(kept || "[image]");
        }
      }
      lines.push(`${m.role}: ${parts.join("\n")}`);
    } else {
      lines.push(`${m.role}: [non-text content]`);
    }
  }
  return lines.join("\n");
}

/**
 * User 発話起点のターン化。先頭の非 User 群は Turn 0 にまとめ、
 * toolCall→toolResult の並びを途中で割らない（user が来るまで flush しない）。
 */
export function buildCompactTurns(messages: CompactableMessage[]): CompactTurn[] {
  const turns: CompactTurn[] = [];
  let current: CompactableMessage[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    let startedAt: number | undefined;
    let endedAt: number | undefined;
    for (const m of current) {
      const ts =
        typeof m.timestamp === "number" && Number.isFinite(m.timestamp)
          ? m.timestamp
          : typeof m.timestamp === "string" && m.timestamp.length > 0
            ? Date.parse(m.timestamp)
            : NaN;
      if (!Number.isFinite(ts)) continue;
      if (startedAt === undefined || (ts as number) < startedAt) {
        startedAt = ts as number;
      }
      if (endedAt === undefined || (ts as number) > endedAt) {
        endedAt = ts as number;
      }
    }
    turns.push({
      id: turns.length,
      messages: current,
      text: turnText(current),
      startedAt,
      endedAt,
    });
    current = [];
  };
  for (const m of messages) {
    if (m.role === "user" && current.length > 0) flush();
    current.push(m);
  }
  flush();
  return turns;
}

export function splitCompactChapters(turns: CompactTurn[], maGapMs: number): CompactChapter[] {
  const chapters: CompactChapter[] = [];
  let current: CompactTurn[] = [];
  let gapBefore: number | undefined;
  const flush = (): void => {
    if (current.length === 0) return;
    let startedAt: number | undefined;
    let endedAt: number | undefined;
    for (const t of current) {
      if (t.startedAt !== undefined) {
        if (startedAt === undefined || t.startedAt < startedAt) {
          startedAt = t.startedAt;
        }
      }
      if (t.endedAt !== undefined) {
        if (endedAt === undefined || t.endedAt > endedAt) {
          endedAt = t.endedAt;
        }
      }
    }
    chapters.push({
      id: chapters.length,
      turns: current,
      startedAt,
      endedAt,
      gapBeforeMs: gapBefore,
    });
    current = [];
    gapBefore = undefined;
  };
  let prevEnd: number | undefined;
  for (const turn of turns) {
    if (
      prevEnd !== undefined &&
      turn.startedAt !== undefined &&
      turn.startedAt - prevEnd > maGapMs
    ) {
      flush();
      gapBefore = turn.startedAt - prevEnd;
    }
    current.push(turn);
    if (turn.endedAt !== undefined) prevEnd = turn.endedAt;
  }
  flush();
  return chapters;
}

/** FNV-1a 32bit ハッシュ（キャッシュキー用・暗号用途ではない）。 */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** ターン仕分けのキャッシュ（メッセージ内容ハッシュ→判定）。 */
const triageCache = new Map<string, TriageChoice>();
/** 章要約のキャッシュ（要約対象全体ハッシュ→要約文）。 */
const summaryCache = new Map<string, string>();
/**
 * キャッシュの上限件数。超過時は挿入順の最古（先頭）から削除する。
 * LRU ではないが、長期稼働（Kasou の常駐セッション）でのメモリ増加を
 * 抑えるためだけの単純な上限。削除コストは削除件数分のみ。
 */
const MAX_AUTO_COMPACT_CACHE_ENTRIES = 2000;

/** Map の挿入順を利用して最古エントリから削除し、上限内に収める。 */
function capAutoCompactCache(cache: Map<string, unknown>): void {
  if (cache.size <= MAX_AUTO_COMPACT_CACHE_ENTRIES) return;
  const excess = cache.size - MAX_AUTO_COMPACT_CACHE_ENTRIES;
  const keys = cache.keys();
  for (let i = 0; i < excess; i++) {
    const oldest = keys.next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function clearAutoCompactCache(): void {
  triageCache.clear();
  summaryCache.clear();
}

export function autoCompactCacheSize(): {
  triage: number;
  summary: number;
} {
  return { triage: triageCache.size, summary: summaryCache.size };
}

/** 決定論的要約: 各ターン先頭 N 字の抜粋（LLM不要・再帰呼び出しなし）。 */
export function deterministicSummary(
  targets: string[],
  maxCharsPerTurn: number = DETERMINISTIC_EXCERPT_CHARS,
): string {
  return targets
    .map((t) => {
      const flat = t.replace(/\s+/g, " ").trim();
      return flat.length > maxCharsPerTurn ? `${flat.slice(0, maxCharsPerTurn)}…` : flat;
    })
    .join("\n---\n");
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function collectToolCallIds(messages: CompactableMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isRecord(part) && part["type"] === "toolCall" && typeof part["id"] === "string") {
        ids.add(part["id"]);
      }
    }
  }
  return ids;
}

function collectToolResultIds(messages: CompactableMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === "toolResult" && typeof m.toolCallId === "string") {
      ids.add(m.toolCallId);
    }
  }
  return ids;
}

/**
 * ペア整合の消毒（双方向）:
 * - 対応 toolCall が残っていない toolResult を除去。
 * - 対応 toolResult がない toolCall パート（割り込み等で跨いだ残骸）を除去。
 *   パート除去で content が空になった assistant メッセージは落とす。
 * - 先頭の孤立 toolResult 群を除去。
 */
export function sanitizePairs(messages: CompactableMessage[]): {
  messages: CompactableMessage[];
  removed: number;
  removedCalls: number;
} {
  const callIds = collectToolCallIds(messages);
  const resultIds = collectToolResultIds(messages);
  const kept: CompactableMessage[] = [];
  let removed = 0;
  let removedCalls = 0;
  for (const m of messages) {
    if (m.role === "toolResult" && typeof m.toolCallId === "string" && !callIds.has(m.toolCallId)) {
      removed += 1;
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const filtered = m.content.filter((part) => {
        if (
          isRecord(part) &&
          part["type"] === "toolCall" &&
          typeof part["id"] === "string" &&
          !resultIds.has(part["id"])
        ) {
          removedCalls += 1;
          return false;
        }
        return true;
      });
      if (filtered.length === 0) {
        removed += 1;
        continue;
      }
      kept.push(filtered.length === m.content.length ? m : { ...m, content: filtered });
      continue;
    }
    kept.push(m);
  }
  // 先頭の孤立 toolResult（toolCallId 無し・対応なし）を落とす。
  let head = 0;
  while (head < kept.length) {
    const m = kept[head];
    if (!m || m.role !== "toolResult") break;
    removed += 1;
    head += 1;
  }
  return { messages: kept.slice(head), removed, removedCalls };
}

export function hasSystemRole(messages: CompactableMessage[]): boolean {
  return messages.some((m) => m.role === "system");
}

export interface OrphanPairCounts {
  orphanResults: number;
  orphanCalls: number;
}

/** 双方向のペア整合検査。両方0が正常。 */
export function findOrphanToolPairs(messages: CompactableMessage[]): OrphanPairCounts {
  const callIds = collectToolCallIds(messages);
  const resultIds = collectToolResultIds(messages);
  let orphanResults = 0;
  let orphanCalls = 0;
  for (const m of messages) {
    if (m.role === "toolResult" && typeof m.toolCallId === "string" && !callIds.has(m.toolCallId)) {
      orphanResults += 1;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (
          isRecord(part) &&
          part["type"] === "toolCall" &&
          typeof part["id"] === "string" &&
          !resultIds.has(part["id"])
        ) {
          orphanCalls += 1;
        }
      }
    }
  }
  if (messages.length > 0 && messages[0]?.role === "toolResult") {
    orphanResults += 1;
  }
  return { orphanResults, orphanCalls };
}

/** 旧API（toolResult方向のみ）。新規は findOrphanToolPairs を使う。 */
export function findOrphanToolResults(messages: CompactableMessage[]): number {
  return findOrphanToolPairs(messages).orphanResults;
}

async function resolveChoicesForTurns(
  turns: CompactTurn[],
  triage: TriageFn | undefined,
): Promise<{ decided: Map<number, TriageChoice>; failed: number }> {
  const decided = new Map<number, TriageChoice>();
  const pending: Array<{ id: number; text: string }> = [];
  for (const turn of turns) {
    const key = hashText(turn.text);
    const cached = triageCache.get(key);
    if (cached !== undefined) {
      decided.set(turn.id, cached);
    } else {
      pending.push({ id: turn.id, text: turn.text });
    }
  }
  if (pending.length === 0) return { decided, failed: 0 };
  if (!triage) {
    for (const p of pending) decided.set(p.id, "維持");
    return { decided, failed: 0 };
  }
  let results: TriageChoice[];
  let failed = 0;
  try {
    results = await triage(pending.map((p) => p.text));
  } catch {
    // 無言にしない: 呼び出し失敗は failed として数え、呼び出し側の統計・通知に出す。
    failed = pending.length;
    results = pending.map(() => "維持" as TriageChoice);
  }
  for (let k = 0; k < pending.length; k++) {
    const p = pending[k];
    if (!p) continue;
    const raw: TriageChoice | undefined = results[k];
    if (raw !== "維持" && raw !== "要約" && raw !== "落とす") failed += 1;
    const c: TriageChoice = raw === "維持" || raw === "要約" || raw === "落とす" ? raw : "維持";
    decided.set(p.id, c);
    const turn = turns.find((t) => t.id === p.id);
    if (turn) triageCache.set(hashText(turn.text), c);
  }
  capAutoCompactCache(triageCache);
  return { decided, failed };
}

async function resolveSummary(
  targets: string[],
  context: string,
  summarizer: SummarizerFn | undefined,
): Promise<{ summary: string; fromCache: boolean }> {
  if (targets.length === 0) return { summary: "", fromCache: false };
  const key = hashText(targets.join("\n\x00\n"));
  const cached = summaryCache.get(key);
  if (cached !== undefined) return { summary: cached, fromCache: true };
  let summary = "";
  if (summarizer) {
    try {
      summary = await summarizer(targets, context);
    } catch {
      summary = "";
    }
  }
  if (!summary) summary = deterministicSummary(targets);
  summaryCache.set(key, summary);
  capAutoCompactCache(summaryCache);
  return { summary, fromCache: false };
}

/**
 * 圧縮コア。入力配列は破壊しない。
 * force=true のとき閾値未満でも圧縮する（手動 /nap 用）。
 */
export async function compressToTarget(
  input: CompactableMessage[],
  options: CompressOptions,
): Promise<CompressOutcome> {
  const started = Date.now();
  // system は context の入力に含まれないはずだが、混入時は除外（system不可）。
  const messages = input.filter((m) => m.role !== "system");
  // messages[k] ↔ input[originalIndices[k]] の対応表（firstKept 引き当て用）。
  const originalIndices: number[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i]?.role !== "system") originalIndices.push(i);
  }
  const { usageTokens, contextWindow, thresholdRatio, targetRatio, maGapMs } = options;
  const keptRatio = normalizeKeptRatio(options.maxKeptRatio);
  const maxKeptTokens = Math.max(1, Math.floor(contextWindow * keptRatio));

  const emptyStats = (fired: boolean): CompressStats => ({
    fired,
    tokensBefore: usageTokens,
    contextWindow,
    usageRatio: contextWindow > 0 && usageTokens >= 0 ? usageTokens / contextWindow : 0,
    estimatedBefore: estimateTokens(messages),
    estimatedAfter: estimateTokens(messages),
    chapters: 0,
    keepTurns: 0,
    summarizeTurns: 0,
    dropTurns: 0,
    evictedChapters: 0,
    protectedChapters: 0,
    targetMissed: false,
    maxKeptTokens,
    keptPastTokens: 0,
    keptScaledDownTurns: 0,
    orphanToolResultsRemoved: 0,
    orphanToolCallsRemoved: 0,
    triageFailures: 0,
    summaryFromCache: false,
    elapsedMs: Date.now() - started,
  });

  const usageRatio = contextWindow > 0 && usageTokens >= 0 ? usageTokens / contextWindow : 0;
  if (!options.force && usageRatio < thresholdRatio) {
    const stats = emptyStats(false);
    return { applied: false, messages, stats, summaryText: "", firstKeptInputIndex: -1 };
  }

  const estimatedBefore = estimateTokens(messages);
  const targetTokens = Math.floor(contextWindow * targetRatio);
  // 比率で落とす: 推定器とプロバイダ実測の絶対ズレに依らない。
  // usageTokens が正のときだけ比率を使い、0以下なら絶対値で比較する。
  const scale = usageTokens > 0 ? targetTokens / usageTokens : Number.POSITIVE_INFINITY;
  const allowedEst = Number.isFinite(scale)
    ? Math.max(1, Math.floor(estimatedBefore * scale * TARGET_MARGIN))
    : targetTokens;

  const turns = buildCompactTurns(messages);
  const chapters = splitCompactChapters(turns, maGapMs);

  // 最古の章から順に仕分けし、削減見込みが目標に達したら打ち切る。
  // 直近章ガード（note #146: 末尾P章・最低1章）は仕分け対象外（＝維持）。
  const turnRawEst = (t: CompactTurn): number => {
    let total = 0;
    for (const m of t.messages) total += estimateMessageTokens(m);
    return total;
  };
  const turnExcerptEst = (t: CompactTurn): number =>
    Math.ceil(Math.min(t.text.length, DETERMINISTIC_EXCERPT_CHARS) / CHARS_PER_TOKEN);
  const neededSaving = Math.max(0, estimatedBefore - allowedEst);
  const budget =
    options.triageBudget === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.triageBudget));
  // 直近章ガード（note #146）: 末尾P章は仕分け対象外（100%生保持・最新章免疫と合流）。
  // 動的上限キャップ: 要求Pが全体章数に対して大きすぎる（例: 既定250に対し7章しかない）と
  // 保護部の生データだけで allowedEst を食い潰し、退避・ターンドロップの余地がなくなって
  // 要約ヘッダ分だけ膨らんだ applied:true（圧縮ノーオペ）を返す病理になる。
  // そのため保護章数を「保護部の生合計が allowedEst 以内に収まる章数」まで古い側から絞る。
  // 最低1章（最新章）は常に保護する。絞っても収まらない単一巨大章の残りは
  // targetMissed で申告し、最終手段（本体 context-pruner）へ委譲する。
  const requestedProtect = normalizeProtectCount(options.protectRecentChapters);
  const chapterRawTokens = chapters.map((ch) => {
    let total = 0;
    for (const t of ch.turns) total += turnRawEst(t);
    return total;
  });
  // 章末尾からの累積和: suffixSums[i] ＝ 末尾 i 章の生合計（O(C) で前計算）。
  const suffixSums: number[] = new Array(chapters.length + 1).fill(0);
  for (let i = chapters.length - 1; i >= 0; i--) {
    suffixSums[chapters.length - i] =
      (suffixSums[chapters.length - i - 1] ?? 0) + (chapterRawTokens[i] ?? 0);
  }
  const protectBudget = Math.floor(allowedEst * PROTECT_BUDGET_RATIO);
  let effectiveProtect =
    chapters.length === 0 ? 0 : Math.min(Math.max(1, requestedProtect), chapters.length);
  while (effectiveProtect > 1) {
    if ((suffixSums[effectiveProtect] ?? 0) <= protectBudget) break;
    effectiveProtect -= 1;
  }
  const protectedFrom = chapters.length - effectiveProtect;
  const choices = new Map<number, TriageChoice>();
  let spent = 0;
  let saving = 0;
  let triageFailures = 0;
  if (options.triage && neededSaving > 0 && chapters.length > 0) {
    for (const ch of chapters) {
      if (saving >= neededSaving * 1.2) break;
      if (ch.id >= protectedFrom) break;
      if (spent >= budget) break;
      const uncached = ch.turns.filter((t) => !triageCache.has(hashText(t.text)));
      if (uncached.length > 0) {
        if (spent + uncached.length > budget) break;
        spent += uncached.length;
      }
      const { decided: chapterDecided, failed } = await resolveChoicesForTurns(
        ch.turns,
        options.triage,
      );
      triageFailures += failed;
      for (const [id, c] of chapterDecided) choices.set(id, c);
      for (const t of ch.turns) {
        const c = choices.get(t.id) ?? "維持";
        if (c === "落とす") saving += turnRawEst(t);
        else if (c === "要約") {
          saving += Math.max(0, turnRawEst(t) - turnExcerptEst(t));
        }
      }
    }
  }
  const decisionOf = (turnId: number): TriageChoice => choices.get(turnId) ?? "維持";

  // 生維持上限スケーリング: 処理対象の過去章の維持合計が上限超過なら、
  // 最も古い維持から順に要約へ昇華させて上限内に収める。
  // これで長期稼働でも維持生ブロックの蓄積で窓を突き抜けない。
  // 保護章（直近P章）の維持は上限計算の対象外＝不可侵。
  let keptScaledDownTurns = 0;
  const pastKeptTokensOf = (
    evict?: Set<number>,
    extra?: Set<number>,
  ): { total: number; byTurn: Array<{ id: number; tokens: number }> } => {
    const byTurn: Array<{ id: number; tokens: number }> = [];
    let total = 0;
    for (const ch of chapters) {
      if (ch.id >= protectedFrom) continue;
      if (evict?.has(ch.id)) continue;
      for (const t of ch.turns) {
        if (extra?.has(t.id)) continue;
        if (decisionOf(t.id) !== "維持") continue;
        const tokens = turnRawEst(t);
        byTurn.push({ id: t.id, tokens });
        total += tokens;
      }
    }
    return { total, byTurn };
  };
  {
    const { total, byTurn } = pastKeptTokensOf();
    if (total > maxKeptTokens) {
      const ordered = [...byTurn].sort((a, b) => a.id - b.id);
      let running = total;
      for (const entry of ordered) {
        if (running <= maxKeptTokens) break;
        choices.set(entry.id, "要約");
        running -= entry.tokens;
        keptScaledDownTurns += 1;
      }
    }
  }

  // Historian 文脈: 落とす除外・維持＋要約の流れ。
  const contextLines: string[] = [];
  const summarizeTargets: string[] = [];
  for (const t of turns) {
    const c = decisionOf(t.id);
    if (c === "落とす") continue;
    contextLines.push(`[${c === "維持" ? "維持" : "要約対象"}] T${t.id}: ${t.text}`);
    if (c === "要約") summarizeTargets.push(t.text);
  }
  const historianContext = contextLines.join("\n");
  const { summary, fromCache } = await resolveSummary(
    summarizeTargets,
    historianContext,
    options.summarizer,
  );

  // 章ごとの内訳（目次用）。
  const chapterNotes = chapters.map((ch) => {
    let keep = 0;
    let sum = 0;
    let drop = 0;
    for (const t of ch.turns) {
      const c = decisionOf(t.id);
      if (c === "維持") keep += 1;
      else if (c === "要約") sum += 1;
      else drop += 1;
    }
    const first = ch.turns[0];
    const last = ch.turns[ch.turns.length - 1];
    const head = first ? oneLine(first.text, 60) : "";
    return {
      chapter: ch,
      keep,
      sum,
      drop,
      toc: `第${ch.id}章 T${first?.id ?? 0}-T${last?.id ?? 0}（${ch.turns.length}ターン: 維持${keep}/要約${sum}/落とす${drop}）: ${head}`,
    };
  });

  // 最古の章から順に適用し、目標以下になるまで「退避（目次1行残し）」で削る。
  // 最新章は常に生で残す（直近文脈の保護）。
  const evicted = new Set<number>();
  const buildOutput = (evict: Set<number>, summaryBody: string): CompactableMessage[] => {
    const tocLines: string[] = [];
    const keptMsgs: CompactableMessage[] = [];
    for (const note of chapterNotes) {
      if (evict.has(note.chapter.id)) {
        tocLines.push(`- ${note.toc}【退避】`);
        continue;
      }
      tocLines.push(`- ${note.toc}`);
      for (const t of note.chapter.turns) {
        const c = decisionOf(t.id);
        if (c === "維持") keptMsgs.push(...t.messages);
      }
    }
    const body = [
      "<dennou-nap-summary>",
      "# 章目次",
      ...tocLines,
      "",
      "# 要約",
      summaryBody || "（要約対象なし）",
      "</dennou-nap-summary>",
    ].join("\n");
    const summaryMsg: CompactableMessage = {
      role: "user",
      content: body,
      timestamp: Date.now(),
    };
    return [summaryMsg, ...keptMsgs];
  };

  const summaryBody = summary;
  let output = buildOutput(evicted, summaryBody);
  let evictedChapters = 0;
  // 保護章（末尾P章・最低1章）以外を最古から退避。
  const evictable = chapterNotes
    .filter((n) => n.chapter.id < protectedFrom)
    .map((n) => n.chapter.id);
  for (const chapterId of evictable) {
    if (estimateTokens(output) <= allowedEst) break;
    evicted.add(chapterId);
    evictedChapters += 1;
    output = buildOutput(evicted, summaryBody);
  }

  // ターン単位フォールバック: 章退避で目標に届かない場合
  // （単一章・巨大な最新章など）は最古の保持ターンから捨てて目標まで削り込む。
  // 最新ターンは保護。最終安全弁は本体 context-pruner に委譲するため
  // 要約の切り詰めは行わない。
  // ターン単位フォールバックで落としたターンID（firstKept 引き当て用に外へ残す）。
  const extraDropped = new Set<number>();
  if (estimateTokens(output) > allowedEst && chapters.length > 0) {
    const droppedTurnIds = new Set<number>();
    for (const note of chapterNotes) {
      if (evicted.has(note.chapter.id)) continue;
      // 直近章ガード（note #146）: 保護章はターンドロップの対象外。
      if (note.chapter.id >= protectedFrom) continue;
      for (const t of note.chapter.turns) {
        if (decisionOf(t.id) === "維持") droppedTurnIds.add(t.id);
      }
    }
    // 最新ターンは保護。
    const newestTurnId = turns.length - 1;
    droppedTurnIds.delete(newestTurnId);
    const ordered = [...droppedTurnIds].sort((a, b) => a - b);
    const rebuild = (extra: Set<number>, body: string): CompactableMessage[] => {
      const tocLines: string[] = [];
      const keptMsgs: CompactableMessage[] = [];
      for (const note of chapterNotes) {
        if (evicted.has(note.chapter.id)) {
          tocLines.push(`- ${note.toc}【退避】`);
          continue;
        }
        tocLines.push(`- ${note.toc}`);
        for (const t of note.chapter.turns) {
          if (extra.has(t.id)) continue;
          if (decisionOf(t.id) === "維持") keptMsgs.push(...t.messages);
        }
      }
      const text = [
        "<dennou-nap-summary>",
        "# 章目次",
        ...tocLines,
        "",
        "# 要約",
        body || "（要約対象なし）",
        "</dennou-nap-summary>",
      ].join("\n");
      return [{ role: "user", content: text, timestamp: Date.now() }, ...keptMsgs];
    };
    const extra = extraDropped;
    output = rebuild(extra, summaryBody);
    for (const turnId of ordered) {
      if (estimateTokens(output) <= allowedEst) break;
      extra.add(turnId);
      output = rebuild(extra, summaryBody);
    }
  }

  const sanitized = sanitizePairs(output);
  output = sanitized.messages;

  // ノーオペガード: 削減需要（neededSaving>0）があるのに出力が入力より
  // 縮んでいない＝退避・ターンドロップの余地ゼロ（単一章＝全章保護など）の場合、
  // 要約ヘッダ分だけ肥大化した applied:true を返さず、入力そのままの
  // applied:false で返す（targetMissed=true で最終手段へ委譲）。
  // neededSaving<=0（推定上は既に予算内）の force 圧縮は対象外——
  // 目次付きヘッダを足す意図的な圧縮のため。
  const noOp = neededSaving > 0 && estimateTokens(output) >= estimatedBefore;
  if (noOp) {
    const stats: CompressStats = {
      fired: true,
      tokensBefore: usageTokens,
      contextWindow,
      usageRatio,
      estimatedBefore,
      estimatedAfter: estimatedBefore,
      chapters: chapters.length,
      keepTurns: turns.length,
      summarizeTurns: 0,
      dropTurns: 0,
      evictedChapters: 0,
      protectedChapters: chapters.length - protectedFrom,
      targetMissed: estimatedBefore > allowedEst,
      maxKeptTokens,
      keptPastTokens: 0,
      keptScaledDownTurns,
      orphanToolResultsRemoved: 0,
      orphanToolCallsRemoved: 0,
      triageFailures,
      summaryFromCache: fromCache,
      elapsedMs: Date.now() - started,
    };
    return {
      applied: false,
      messages,
      stats,
      summaryText: "",
      firstKeptInputIndex: -1,
    };
  }

  let keepTurns = 0;
  let summarizeTurns = 0;
  let dropTurns = 0;
  for (const t of turns) {
    const c = decisionOf(t.id);
    if (c === "維持") keepTurns += 1;
    else if (c === "要約") summarizeTurns += 1;
    else dropTurns += 1;
  }

  const firstMsg = output[0];
  const summaryText =
    firstMsg && firstMsg.role === "user" && typeof firstMsg.content === "string"
      ? firstMsg.content
      : "";
  // kept 先頭の入力インデックスを決定時に直接求める（逆引き不要・KISS）。
  // sanitize のコピー（assistant 浅いコピー）で参照一致が外れても影響を受けないよう、
  // 出力参照ではなく「最初に残った維持ターンの先頭メッセージ」を入力座標で返す。
  // 各ターンは user 始まりのため先頭は user（sanitize 対象外）で安定する。
  // Note: あえて sanitize 後生存確認はしない。先頭維持ターンが user 始まりである限り
  // firstKept 以降は全て残るため、appendCompaction の折りたたみ境界として正しい。
  let firstKeptInputIndex = -1;
  outer: for (const note of chapterNotes) {
    if (evicted.has(note.chapter.id)) continue;
    for (const t of note.chapter.turns) {
      if (extraDropped.has(t.id)) continue;
      if (decisionOf(t.id) !== "維持") continue;
      const firstKeptMsg = t.messages[0];
      if (!firstKeptMsg) continue;
      const filteredIdx = messages.indexOf(firstKeptMsg);
      if (filteredIdx < 0) continue;
      const orig = originalIndices[filteredIdx];
      if (orig === undefined) continue;
      firstKeptInputIndex = orig;
      break outer;
    }
  }
  // 最終出力に実際に残った過去章の生維持トークン（退避・ターンドロップ反映後）。
  // 出力不変条件: 過去章の生維持は maxKeptTokens 以下を保証する。
  // 全体の target 収まりはベストエフォート: 保護部の不可侵で届かない場合は
  // targetMissed=true で申告し、呼び出し側（本体 context-pruner）へ委譲する。
  const keptPastTokens = pastKeptTokensOf(evicted, extraDropped).total;
  const estimatedAfter = estimateTokens(output);
  const stats: CompressStats = {
    fired: true,
    tokensBefore: usageTokens,
    contextWindow,
    usageRatio,
    estimatedBefore,
    estimatedAfter,
    chapters: chapters.length,
    keepTurns,
    summarizeTurns,
    dropTurns,
    evictedChapters,
    protectedChapters: chapters.length - protectedFrom,
    targetMissed: estimatedAfter > allowedEst,
    maxKeptTokens,
    keptPastTokens,
    keptScaledDownTurns,
    orphanToolResultsRemoved: sanitized.removed,
    orphanToolCallsRemoved: sanitized.removedCalls,
    triageFailures,
    summaryFromCache: fromCache,
    elapsedMs: Date.now() - started,
  };
  return { applied: true, messages: output, stats, summaryText, firstKeptInputIndex };
}

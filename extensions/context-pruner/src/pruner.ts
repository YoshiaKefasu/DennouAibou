/**
 * context-pruner プラグインの純粋ロジック（ファイルI/Oなし）
 *
 * 仕様: DENNOU_DOCS/COMPACTION_FEATURE.md §4.2 / §4.3
 *
 * 設計メモ（書き込み時セマンティクス）:
 * - `tool_result_persist` フックは「今まさに永続化される1件のツール結果」だけを扱う。
 *   ツール結果は実行直後に永続化されるため、フックが見るのは常に「現在進行中ターン」
 *   の結果であり、トランスクリプト末尾からの相対位置（findAssistantCutoffIndex 方式）は
 *   この時点では評価できない。
 * - そこで「直近 N ターン保護」は、セッションごとの**観測済みアシスタント発言数**を
 *   カウンタとして持ち、観測開始（session_start / プロセス起動）からの最初の
 *   `keepLastAssistants` ターンを完全保護するフェンスとして実装する。
 *   これは「直近3回のアシスタント発言以降のツール結果は生保持」の書き込み時解釈であり、
 *   トランスクリプト全体に対する「末尾から N ターン保護」は共有エンジン
 *   （src/dennou-soul/prune-engine.ts の findAssistantCutoffIndex）が担う。
 * - `id` / `parentId` / `toolCallId` / `toolName` / `isError` 等のJSON構造は 100% 保持し、
 *   `content` の中身だけを正準プレースホルダー `[出力省略: {行数}行 / {サイズ} 正常終了]`
 *   に置換する。SESSION_INTEGRITY_GUARD の検証を通過し、孤児ノードを生まない。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildCanonicalPlaceholder,
  formatPrunableSizeLabel,
  hasPlaceholderMarker,
} from "../../../src/dennou-soul/prune-engine.js";

/** プラグイン設定（plugins.entries["context-pruner"].config 相当） */
export type ContextPrunerConfig = {
  /** 機能のON/OFF */
  enabled: boolean;
  /** 保護する直近アシスタント発言数（観測フェンス） */
  keepLastAssistants: number;
  /** この文字数以上のツール結果のみプレースホルダー化対象 */
  minPrunableToolChars: number;
  /** true のときデフォルトで生出力を保持する */
  defaultPreserve: boolean;
  /** カスタムプレースホルダー（省略時は正準フォーマット） */
  placeholder?: string;
  /** このキーワードを含む結果は決してPruneしない（設定パス等） */
  protectedContentKeywords?: string[];
};

/** 既定の保護キーワード（dennou-soul のデフォルトと同じ） */
export const CONTEXT_PRUNER_DEFAULT_KEYWORDS: readonly string[] = [
  "AGENTS.md",
  "SOUL.md",
  "DENNOU_RULES",
];

/**
 * 50k cap（安全弁）: 1回のツール結果がこの文字数を超える極端な巨大出力の場合、
 * 先頭25,000文字と末尾25,000文字を残して中間を切り詰める
 * （通常圧縮ではなく、モデルのコンテキスト圧死を防ぐ安全弁。明示保存時にも適用）。
 */
export const TOOL_RESULT_SAFETY_CAP_CHARS = 50_000;
export const TOOL_RESULT_SAFETY_CAP_HEAD_CHARS = 25_000;
export const TOOL_RESULT_SAFETY_CAP_TAIL_CHARS = 25_000;
export const TOOL_RESULT_SAFETY_CAP_MARKER =
  "\n\n[Tool result truncated: exceeds 50,000 chars safety cap]\n\n";

/** raw 設定値を ContextPrunerConfig に正規化する（不正値はデフォルトにフォールバック） */
export function resolveContextPrunerConfig(raw: unknown): ContextPrunerConfig {
  const base: ContextPrunerConfig = {
    enabled: true,
    keepLastAssistants: 3,
    minPrunableToolChars: 1200,
    defaultPreserve: false,
  };
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const cfg = raw as Record<string, unknown>;
  return {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : base.enabled,
    keepLastAssistants:
      typeof cfg.keepLastAssistants === "number" && Number.isFinite(cfg.keepLastAssistants)
        ? Math.max(0, Math.floor(cfg.keepLastAssistants))
        : base.keepLastAssistants,
    minPrunableToolChars:
      typeof cfg.minPrunableToolChars === "number" && Number.isFinite(cfg.minPrunableToolChars)
        ? Math.max(0, Math.floor(cfg.minPrunableToolChars))
        : base.minPrunableToolChars,
    defaultPreserve:
      typeof cfg.defaultPreserve === "boolean" ? cfg.defaultPreserve : base.defaultPreserve,
    placeholder:
      typeof cfg.placeholder === "string" && cfg.placeholder.trim()
        ? cfg.placeholder.trim()
        : undefined,
    protectedContentKeywords: Array.isArray(cfg.protectedContentKeywords)
      ? cfg.protectedContentKeywords.filter((k): k is string => typeof k === "string")
      : undefined,
  };
}

export type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

export function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
  return message.role === "toolResult";
}

/** ツール結果の全テキストブロック文字数合計（UTF-16単位）。 */
export function getToolResultTextChars(message: ToolResultMessage): number {
  let total = 0;
  for (const block of message.content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      total += block.text.length;
    }
  }
  return total;
}

/** ツール結果の全テキストブロックを結合する（キーワード判定・行数計算用）。 */
export function getToolResultText(message: ToolResultMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** 既にプレースホルダー化されたエントリかどうか（冪等性ガード）。 */
export function hasPlaceholderMarkerInMessage(message: ToolResultMessage): boolean {
  return hasPlaceholderMarker(getToolResultText(message));
}

/**
 * 50,000文字超の安全弁。先頭25,000文字 + 末尾25,000文字を残し、
 * 中間に `[Tool result truncated: exceeds 50,000 chars safety cap]` を挿入する。
 * JSON構造（id, parentId, toolCallId, toolName, isError）は保持される。
 */
export function applyToolResultSafetyCap(message: ToolResultMessage): ToolResultMessage {
  const text = getToolResultText(message);
  if (text.length <= TOOL_RESULT_SAFETY_CAP_CHARS) {
    return message;
  }
  const head = text.slice(0, TOOL_RESULT_SAFETY_CAP_HEAD_CHARS);
  const tail = text.slice(text.length - TOOL_RESULT_SAFETY_CAP_TAIL_CHARS);
  return {
    ...message,
    content: [{ type: "text", text: `${head}${TOOL_RESULT_SAFETY_CAP_MARKER}${tail}` }],
  };
}

/** キーワード保護（case-insensitive）。設定ファイルパス等が含まれる結果は除外する。 */
export function isProtectedByKeywordInMessage(
  message: ToolResultMessage,
  keywords: readonly string[],
): boolean {
  if (keywords.length === 0) {
    return false;
  }
  const text = getToolResultText(message).toLowerCase();
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

/**
 * 正準プレースホルダーを組み立てる。
 * `[出力省略: {行数}行 / {サイズ} 正常終了]`（customPlaceholder 指定時はそれを優先）。
 * 行数・サイズは置換前の元テキストから算出する。
 */
export function buildMessagePlaceholder(
  message: ToolResultMessage,
  customPlaceholder?: string,
): string {
  if (typeof customPlaceholder === "string" && customPlaceholder.trim()) {
    return customPlaceholder.trim();
  }
  const text = getToolResultText(message);
  const lineCount = Math.max(1, text.split("\n").length);
  const sizeLabel = formatPrunableSizeLabel(getToolResultTextChars(message));
  return buildCanonicalPlaceholder({ lineCount, sizeLabel });
}

export type PruneDecision = {
  /** 永続化すべきメッセージ（置換なしなら入力と同じ参照） */
  message: AgentMessage;
  /** content が正準プレースホルダーに置換されたか */
  placeholderized: boolean;
  /** 50k 安全弁による切り詰めが適用されたか */
  capped: boolean;
};

/**
 * 書き込み時（tool_result_persist）の単一メッセージ変換。
 *
 * 判定順:
 * 1. 無効時 / ツール結果以外 → 無変換
 * 2. 冪等性ガード（既に `[出力省略:` または `[Old tool output` を含む → 二重置換しない）
 * 3. isError → 生保持
 * 4. defaultPreserve → 生保持
 * 5. 50k 安全弁（超えたら head/tail 切り詰め）→ 以降も判定を続行
 * 6. minPrunableToolChars 未満 → 生保持
 * 7. 重要キーワード保護（設定パス等）→ 生保持
 * 8. 直近 keepLastAssistants ターン保護（観測フェンス）→ 生保持
 * 9. それ以外 → content を正準プレースホルダーに置換
 *
 * @param message - 永続化直前のツール結果メッセージ
 * @param config - プラグイン設定
 * @param opts.assistantTurnCount - このセッションで観測済みのアシスタント発言数
 */
export function transformToolResultForPersistence(
  message: AgentMessage,
  config: ContextPrunerConfig,
  opts?: { assistantTurnCount?: number },
): PruneDecision {
  const noop: PruneDecision = { message, placeholderized: false, capped: false };
  if (!config.enabled) {
    return noop;
  }
  if (!isToolResultMessage(message)) {
    return noop;
  }

  // 冪等性ガード: 既にプレースホルダー化されたエントリは二重に置換しない
  if (hasPlaceholderMarkerInMessage(message)) {
    return noop;
  }

  // エラー結果は常に生保持
  if (message.isError) {
    return noop;
  }

  // 明示保存（preserve: true / defaultPreserve: true）は生データのまま
  if (config.defaultPreserve) {
    return noop;
  }

  const originalText = getToolResultText(message);
  if (originalText.length === 0) {
    return noop;
  }

  // 50k 安全弁（preserve に関係なく適用される安全上限）
  let next: ToolResultMessage = message;
  let capped = false;
  if (originalText.length > TOOL_RESULT_SAFETY_CAP_CHARS) {
    next = applyToolResultSafetyCap(message);
    capped = true;
  }

  // サイズ閾値: 短い出力はそもそもプレースホルダー化しない
  if (getToolResultTextChars(next) < config.minPrunableToolChars) {
    return { message: next, placeholderized: false, capped };
  }

  // 重要キーワード保護（設定パス等のアンカー情報が含まれる結果は除外）
  const keywords = config.protectedContentKeywords ?? CONTEXT_PRUNER_DEFAULT_KEYWORDS;
  if (isProtectedByKeywordInMessage(next, keywords)) {
    return { message: next, placeholderized: false, capped };
  }

  // 直近 N ターン保護: 観測開始から keepLastAssistants ターン以内は生保持。
  // keepLastAssistants=0 は保護なし（全件対象）を意味する。
  const assistantTurnCount = opts?.assistantTurnCount ?? 0;
  if (config.keepLastAssistants > 0 && assistantTurnCount <= config.keepLastAssistants) {
    return { message: next, placeholderized: false, capped };
  }

  // プレースホルダー化（JSON構造は不変、content のみ置換）
  const placeholder = buildMessagePlaceholder(message, config.placeholder);
  return {
    message: { ...next, content: [{ type: "text", text: placeholder }] },
    placeholderized: true,
    capped,
  };
}

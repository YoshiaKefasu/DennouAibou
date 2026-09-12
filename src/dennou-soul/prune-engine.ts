/**
 * 共通Pruneエンジン
 *
 * 閉じたセッション・アクティブセッションの両方で使う行レベルPruneロジック。
 * ファイルI/Oは含まず、行配列の変換のみを行う純粋関数。
 *
 * COMPACTION_FEATURE.md Phase 1 により:
 * - 従来の行数ベース `keepLastTools` を廃止し、アシスタント発言境界ベースの
 *   `keepLastAssistants`（直近 N 回のアシスタント発言を保護）に一本化した。
 * - `pruneToolResultEntry` は export 化し、冪等性ガード（二重置換防止）を追加した。
 */
import type { DennouSessionToolsPruneConfig, DennouPruneProtectionConfig } from "./types.js";

/**
 * プレースホルダー化済みとみなすマーカー。
 *
 * - `[出力省略:` … 本プロジェクトの正準プレースホルダー（`[出力省略: N行 / X 正常終了]`）。
 *   画像用プレースホルダー `[出力省略: 画像データ (NKB) 正常終了]` / テキスト併記形式も
 *   同じプレフィックスを持つため、このマーカーで検知される。
 * - `[Old tool output` … 旧 OpenClaw 製 context-pruning の互換マーカー
 *
 * どちらかを含むツール結果は「既にプレースホルダー化済み」と判定し、二重に置換しない。
 */
export const PLACEHOLDER_MARKERS: readonly string[] = ["[出力省略:", "[Old tool output"];

/**
 * 50k cap（安全弁）: preserve: true による明示保存時であっても、1回のツール結果が
 * この文字数を超える極端な巨大出力は許容しない（モデルのコンテキスト圧死を防ぐ）。
 * kernel（session-tool-result-guard の preserve 時サイズ上限）と
 * context-pruner プラグイン（applyToolResultSafetyCap）で共有する単一の値。
 */
export const TOOL_RESULT_SAFETY_CAP_CHARS = 50_000;

/** 文字列にプレースホルダーマーカーが含まれるか（冪等性判定用）。 */
export function hasPlaceholderMarker(text: string): boolean {
  return PLACEHOLDER_MARKERS.some((marker) => text.includes(marker));
}

/**
 * バイト数（文字数）を人間可読なサイズ表記に整形する。
 * 例: 120 → "120B", 3481 → "3.4KB", 15360 → "15KB", 3400000 → "3.4MB"
 */
export function formatPrunableSizeLabel(chars: number): string {
  if (!Number.isFinite(chars) || chars < 0) {
    return "0B";
  }
  if (chars < 1024) {
    return `${chars}B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let value = chars / 1024;
  let unit = "KB" as string;
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${unit}`;
}

/**
 * 正準プレースホルダーテキストを組み立てる。
 *
 * 仕様（COMPACTION_FEATURE.md §4.3）: `[出力省略: {行数}行 / {サイズ} 正常終了]`
 *
 * @param lineCount - 元テキストの行数
 * @param sizeLabel - 元テキストのサイズ表記（例: "3.4KB"）
 * @param status - 実行状態（デフォルト "正常終了"）
 */
export function buildCanonicalPlaceholder(params: {
  lineCount: number;
  sizeLabel: string;
  status?: string;
}): string {
  return `[出力省略: ${params.lineCount}行 / ${params.sizeLabel} ${params.status ?? "正常終了"}]`;
}

/** JSONLの1行を表すパース済みエントリ */
interface JsonlEntry {
  raw: string;
  parsed: Record<string, unknown>;
}

/**
 * 1行のJSONLをパースする。
 * JSONパースに失敗した行は undefined を返す（行はそのまま保持）。
 */
export function parseLine(line: string): JsonlEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return { raw: line, parsed: JSON.parse(trimmed) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/**
 * エントリがツール結果（toolResult）かどうかを判定する。
 */
export function isToolResultEntry(entry: JsonlEntry): boolean {
  const msg = entry.parsed.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return false;
  return msg.role === "toolResult";
}

/**
 * ツール結果エントリのテキスト内容＋画像データの合計文字数を返す。
 * type: "image" ブロック（Base64 data）もサイズ合計に含める
 * （画像ツール結果のサイズ認識と直近ターン保護後の遅延プレースホルダー化）。
 */
export function getToolResultContentLength(entry: JsonlEntry): number {
  const msg = entry.parsed.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return 0;

  const content = msg.content;
  if (!Array.isArray(content)) return 0;

  let totalLength = 0;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (typeof block.text === "string") {
      totalLength += block.text.length;
    }
    if (block.type === "image" && typeof block.data === "string") {
      totalLength += block.data.length;
    }
  }
  return totalLength;
}

/**
 * ツール結果エントリの全テキスト内容を結合して返す（保護判定用）。
 */
export function getToolResultTextContent(entry: JsonlEntry): string {
  const msg = entry.parsed.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return "";

  const content = msg.content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

/**
 * パス区切りを正規化して大文字小文字を統一する。
 */
function normalizePathSeparators(s: string): string {
  return s.replace(/\\/g, "/").toLowerCase();
}

/**
 * JSON文字列中のエスケープされたバックスラッシュを緩和し、
 * パス判定用の正規化へ通しやすくする。
 */
function unescapeJsonBackslashes(s: string): string {
  return s.replace(/\\\\/g, "\\");
}

/**
 * コンテンツ内にprotectedContentKeywordsのいずれかが含まれるか（case-insensitive）。
 */
export function isProtectedByKeyword(
  entry: JsonlEntry,
  protection?: DennouPruneProtectionConfig,
): boolean {
  if (!protection?.protectedContentKeywords?.length) return false;
  const text = getToolResultTextContent(entry).toLowerCase();
  return protection.protectedContentKeywords.some((keyword) =>
    text.includes(keyword.toLowerCase()),
  );
}

/**
 * コンテンツ内にワークスペースパス（ランタイム自動取得）が含まれるか。
 * パス区切りは正規化して比較し、大文字小文字は区別しない。
 */
export function isProtectedByWorkspacePath(
  entry: JsonlEntry,
  protection?: DennouPruneProtectionConfig,
): boolean {
  if (!protection?.resolvedWorkspacePaths?.length) return false;
  // 取りこぼしを避けるため、表示用テキストだけでなく JSONL 行全体も見る。
  // 例: パスが構造化フィールドに入り text には出ないケース、
  //     JSONエスケープで "D:\\..." になっているケース。
  const text = normalizePathSeparators(getToolResultTextContent(entry));
  const raw = normalizePathSeparators(unescapeJsonBackslashes(entry.raw));
  return protection.resolvedWorkspacePaths.some((wsPath) => {
    const normalizedWsPath = normalizePathSeparators(wsPath);
    return text.includes(normalizedWsPath) || raw.includes(normalizedWsPath);
  });
}

/**
 * プレースホルダー化済みエントリかどうかを判定する（冪等性ガード）。
 * 既に `[出力省略:` または `[Old tool output` を含むツール結果は二重に置換しない。
 */
export function isAlreadyPlaceholderized(entry: JsonlEntry): boolean {
  return hasPlaceholderMarker(getToolResultTextContent(entry));
}

/**
 * ツール結果エントリの content のみを placeholder に置き換え、
 * JSON構造（id, parentId, toolCallId, toolName, isError など）を保持したまま
 * JSON文字列として返す。
 *
 * これにより session-file-repair が malformed line として落とすことがなくなり、
 * parent chain が切れない。
 *
 * 冪等性: 既にプレースホルダー化されたエントリ（`[出力省略:` または
 * `[Old tool output` を含む）は置換せず、元の行をそのまま返す。
 */
export function pruneToolResultEntry(entry: JsonlEntry, placeholder: string): string {
  // 冪等性ガード: 既にプレースホルダー化済みなら二重に置換しない
  if (isAlreadyPlaceholderized(entry)) {
    return entry.raw;
  }
  const cloned: Record<string, unknown> = JSON.parse(JSON.stringify(entry.parsed));
  const msg = cloned.message as Record<string, unknown> | undefined;
  if (msg && typeof msg === "object") {
    msg.content = [{ type: "text", text: placeholder }];
  }
  return JSON.stringify(cloned);
}

/**
 * アシスタント発言境界のカットオフ index を求める（findAssistantCutoffIndex 方式）。
 *
 * セッション末尾から数えて `keepLastAssistants` 回目のアシスタント発言の行 index を返す。
 * `index < cutoff` のツール結果が Prune 対象となり、`index >= cutoff` は保護される
 * （直近 N ターンのツール出力は現在進行形の思考に必要なため生データを保持する）。
 *
 * @param lines - JSONL行配列（末尾空行除去済み）
 * @param keepLastAssistants - 保護する直近アシスタント発言数
 * @returns カットオフ index。`keepLastAssistants <= 0` の場合は全行対象のため
 *          lines.length を返す。保護対象のアシスタント発言が足りない場合は
 *          null を返し、呼び出し側は何も Prune しない（安全側）。
 */
export function findAssistantCutoffIndex(
  lines: string[],
  keepLastAssistants: number,
): number | null {
  if (keepLastAssistants <= 0) {
    return lines.length;
  }
  let remaining = keepLastAssistants;
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseLine(lines[i]);
    if (!entry) {
      continue;
    }
    const msg = entry.parsed.message as Record<string, unknown> | undefined;
    if (msg && typeof msg === "object" && msg.role === "assistant") {
      remaining--;
      if (remaining === 0) {
        return i;
      }
    }
  }
  // 保護対象のアシスタント発言が足りない → 全行保護（何もPruneしない）
  return null;
}

/**
 * 行配列に対してPrune判定を行い、変換後の行配列とPrune行数を返す。
 *
 * @param lines - 元の行配列（末尾空行は除去済みであること）
 * @param config - Prune設定
 * @param logger - ログ出力関数
 * @param protection - 保護設定（省略時は保護なし）
 * @returns 変換後の行配列とPrune行数
 */
export function pruneToolOutputLines(
  lines: string[],
  config: DennouSessionToolsPruneConfig,
  logger: (msg: string) => void,
  protection?: DennouPruneProtectionConfig,
): { resultLines: string[]; prunedCount: number } {
  let prunedCount = 0;
  const resultLines: string[] = [];

  // アシスタント発言境界のカットオフを事前計算する（直近 N ターン保護）。
  // アシスタント発言が足りない場合は null → 全行保護（何もPruneしない）。
  const cutoffIndex = findAssistantCutoffIndex(lines, config.keepLastAssistants);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const entry = parseLine(line);

    // パースできない行はそのまま保持
    if (!entry) {
      resultLines.push(line);
      continue;
    }

    // ツール結果でなければそのまま
    if (!isToolResultEntry(entry)) {
      resultLines.push(line);
      continue;
    }

    // 冪等性ガード: 既にプレースホルダー化済みのエントリは二重に置換しない
    if (isAlreadyPlaceholderized(entry)) {
      resultLines.push(line);
      continue;
    }

    // 保護ルール: キーワードマッチ → 保護
    if (isProtectedByKeyword(entry, protection)) {
      resultLines.push(line);
      continue;
    }

    // 保護ルール: ワークスペースパスマッチ → 保護
    if (isProtectedByWorkspacePath(entry, protection)) {
      resultLines.push(line);
      continue;
    }

    // 直近 keepLastAssistants 回のアシスタント発言以降（index >= cutoff）は保護。
    // カットオフが null の場合は全行保護。
    if (cutoffIndex === null || i >= cutoffIndex) {
      resultLines.push(line);
      continue;
    }

    // 文字数チェック
    const contentLength = getToolResultContentLength(entry);
    if (contentLength < config.minPrunableToolChars) {
      resultLines.push(line);
      continue;
    }

    // Prune対象 → プレースホルダに置き換え
    if (config.dryRun) {
      // DRY-RUN時は行ごとのログを出さない（ログ洪水防止）。
      // 呼び出し元でファイル単位サマリーのみ出す。
      resultLines.push(line); // dry-run時は実際には置き換えない
    } else {
      logger(`[DennouAibou] PRUNE: line ${i + 1} (${contentLength} chars)`);
      resultLines.push(pruneToolResultEntry(entry, config.placeholder));
    }
    prunedCount++;
  }

  return { resultLines, prunedCount };
}

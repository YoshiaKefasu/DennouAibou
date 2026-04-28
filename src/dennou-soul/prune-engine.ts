/**
 * 共通Pruneエンジン
 *
 * 閉じたセッション・アクティブセッションの両方で使う行レベルPruneロジック。
 * ファイルI/Oは含まず、行配列の変換のみを行う純粋関数。
 */
import type { DennouSessionToolsPruneConfig, DennouPruneProtectionConfig } from "./types.js";

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
 * ツール結果エントリのテキスト内容の合計文字数を返す。
 */
export function getToolResultContentLength(entry: JsonlEntry): number {
  const msg = entry.parsed.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return 0;

  const content = msg.content;
  if (!Array.isArray(content)) return 0;

  let totalLength = 0;
  for (const item of content) {
    if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
      totalLength += item.text.length;
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
 * コンテンツ内にprotectedContentKeywordsのいずれかが含まれるか（case-insensitive）。
 */
export function isProtectedByKeyword(
  entry: JsonlEntry,
  protection?: DennouPruneProtectionConfig,
): boolean {
  if (!protection?.protectedContentKeywords?.length) return false;
  const text = getToolResultTextContent(entry).toLowerCase();
  return protection.protectedContentKeywords.some(
    (keyword) => text.includes(keyword.toLowerCase()),
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
  const text = normalizePathSeparators(getToolResultTextContent(entry));
  return protection.resolvedWorkspacePaths.some(
    (wsPath) => text.includes(normalizePathSeparators(wsPath)),
  );
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
  const totalLines = lines.length;

  for (let i = 0; i < totalLines; i++) {
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

    // 末尾から keepLastTools 以内のエントリは保護
    const positionFromEnd = totalLines - i;
    if (positionFromEnd <= config.keepLastTools) {
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
      logger(`[DennouAibou] DRY-RUN would prune: line ${i + 1} (${contentLength} chars)`);
      resultLines.push(line); // dry-run時は実際には置き換えない
    } else {
      logger(`[DennouAibou] PRUNE: line ${i + 1} (${contentLength} chars)`);
      resultLines.push(config.placeholder);
    }
    prunedCount++;
  }

  return { resultLines, prunedCount };
}

/**
 * アクティブセッションJSONLのツール出力をIdle検知後にPruneする
 *
 * セーフガード:
 * 1. 一時ファイル経由のatomic write（書き込み中のプロセスとの競合防止）
 * 2. mtime比較による書き込み検出（読み取り後に他プロセスが書き込んだら中断）
 * 3. Prune前後の mtime double-check
 *
 * 行レベルのPruneロジックは `prune-engine.ts` に委譲。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type DennouSessionToolsPruneConfig, type DennouPruneProtectionConfig } from "./types.js";
import { pruneToolOutputLines } from "./prune-engine.js";
import { logDebug } from "../logger.js";

/** 安全なatomic renameのための一時ファイル拡張子 */
const TMP_EXT = ".prune-tmp";

/**
 * アクティブセッションファイルをPruneする。
 *
 * 安全機構:
 * - 一時ファイルに書き出してから atomic rename する
 * - 読み取り後にファイルが変更された（mtime変化）場合は中断する
 *
 * @param filePath - 対象JSONLファイルの絶対パス
 * @param config - Prune設定
 * @param logger - ログ出力関数
 * @returns Pruneした行数。中断した場合は -1 を返す
 */
export function pruneActiveSessionFile(
  filePath: string,
  config: DennouSessionToolsPruneConfig,
  logger: (msg: string) => void = console.log,
  protection?: DennouPruneProtectionConfig,
): number {
  if (!config.enabled) return 0;

  // ファイル存在確認
  if (!fs.existsSync(filePath)) {
    logger(`[DennouAibou] SKIP (not found): ${filePath}`);
    return 0;
  }

  // 読み取り前にmtimeを記録
  let originalStat: fs.Stats;
  try {
    originalStat = fs.statSync(filePath);
  } catch {
    logger(`[DennouAibou] SKIP (stat failed): ${filePath}`);
    return 0;
  }
  const mtimeBefore = originalStat.mtimeMs;

  // 全行を読み込み
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  // 末尾の空行を除去
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  // 共通エンジンでPrune判定
  const { resultLines, prunedCount } = pruneToolOutputLines(lines, config, (msg) => {
    logger(`[DennouAibou] ${filePath} ${msg}`);
  }, protection);

  if (prunedCount === 0) return 0;

  // dry-runの場合は書き込まない
  if (config.dryRun) {
    logger(`[DennouAibou] DRY-RUN would prune ${filePath} (${prunedCount} lines)`);
    return prunedCount;
  }

  // ---- mtime double-check ----
  // 読み取り後にファイルが変更されたら中断（他プロセスが書き込んだ可能性）
  let currentStat: fs.Stats;
  try {
    currentStat = fs.statSync(filePath);
  } catch {
    // ファイルが消えた → 中断
    logger(`[DennouAibou] ABORT (file disappeared): ${filePath}`);
    return -1;
  }

  if (currentStat.mtimeMs !== mtimeBefore) {
    logger(`[DennouAibou] ABORT (file changed after read): ${filePath}`);
    return -1; // 呼び出し元に「中断した」ことを伝える
  }

  // ---- atomic write ----
  // 閉じたファイルと違い、アクティブセッションは上流がいつ書き込むかわからない。
  // 一時ファイルに書き出してから atomic rename することで安全に置き換える。
  const tmpPath = filePath + TMP_EXT;

  try {
    const output = resultLines.join("\n") + "\n";
    fs.writeFileSync(tmpPath, output, "utf8");

    // 書き込み後に再度 mtime を確認
    try {
      currentStat = fs.statSync(filePath);
    } catch {
      // ファイルが消えた
      fs.rmSync(tmpPath, { force: true });
      logger(`[DennouAibou] ABORT (file disappeared after write): ${filePath}`);
      return -1;
    }

    if (currentStat.mtimeMs !== mtimeBefore) {
      // 書き込み中に変更された → 一時ファイルを削除して中断
      fs.rmSync(tmpPath, { force: true });
      logger(`[DennouAibou] ABORT (file changed during write): ${filePath}`);
      return -1;
    }

    // atomic rename
    fs.renameSync(tmpPath, filePath);
    logger(`[DennouAibou] PRUNED ${filePath} (${prunedCount} lines)`);
    return prunedCount;
  } catch (err) {
    // 後片付け
    fs.rmSync(tmpPath, { force: true });
    logger(
      `[DennouAibou] ERROR pruning ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return -1;
  }
}

/**
 * 指定ディレクトリ内の特定のアクティブセッションファイルをPruneする。
 * セッションIDからファイルパスを構築する。
 *
 * @param sessionsDir - セッションディレクトリの絶対パス
 * @param sessionId - セッションID（ファイル名の一部）
 * @param config - Prune設定
 * @param logger - ログ出力関数
 * @returns Pruneした行数
 */
export function pruneActiveSessionById(
  sessionsDir: string,
  sessionId: string,
  config: DennouSessionToolsPruneConfig,
  logger: (msg: string) => void = logDebug,
  protection?: DennouPruneProtectionConfig,
): number {
  if (!config.enabled) return 0;

  const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) {
    logger(`[DennouAibou] SKIP (active session not found): ${filePath}`);
    return 0;
  }

  return pruneActiveSessionFile(filePath, config, logger, protection);
}

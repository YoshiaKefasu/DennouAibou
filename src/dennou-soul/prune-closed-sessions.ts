/**
 * 閉じたセッションJSONLファイルのツール出力をPruneする
 *
 * 対象: `*.jsonl.deleted.*` および `*.jsonl.reset.*` のファイル。
 * アクティブセッション (`*.jsonl`) は決して触らない。
 *
 * Prune条件:
 * 1. `role: "toolResult"` のエントリ
 * 2. content の文字数が `minPrunableToolChars` 以上
 * 3. セッション末尾から `keepLastTools` 以内でない
 *
 * Pruneされたエントリはプレースホルダ行に置き換える（行数は変えない）。
 *
 * 行レベルのPruneロジックは `prune-engine.ts` に委譲。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { type DennouSessionToolsPruneConfig, type DennouPruneProtectionConfig } from "./types.js";
import { pruneToolOutputLines } from "./prune-engine.js";

/**
 * 単一の閉じたセッションファイルに対してPruneを実行する。
 *
 * @param filePath - 対象JSONLファイルの絶対パス
 * @param config - Prune設定
 * @param logger - ログ出力関数（省略時はconsole.log）
 * @returns Pruneした行数
 */
export function pruneClosedSessionFile(
  filePath: string,
  config: DennouSessionToolsPruneConfig,
  logger: (msg: string) => void = console.log,
  protection?: DennouPruneProtectionConfig,
): number {
  // 閉じたセッションファイルのみ対象
  const basename = path.basename(filePath);
  const isClosed = basename.includes(".jsonl.deleted.") || basename.includes(".jsonl.reset.");
  if (!isClosed) {
    logger(`[DennouAibou] SKIP (not closed): ${filePath}`);
    return 0;
  }

  // ファイル存在確認
  if (!fs.existsSync(filePath)) {
    logger(`[DennouAibou] SKIP (not found): ${filePath}`);
    return 0;
  }

  // 全行を読み込み
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  // 末尾の空行を除去（あった場合）
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  // 共通エンジンでPrune判定
  const { resultLines, prunedCount } = pruneToolOutputLines(lines, config, (msg) => {
    logger(`[DennouAibou] ${filePath} ${msg}`);
  }, protection);

  // dry-runの場合は書き込まない
  if (!config.dryRun && prunedCount > 0) {
    const output = resultLines.join("\n") + "\n";
    fs.writeFileSync(filePath, output, "utf8");
    logger(`[DennouAibou] WROTE ${filePath} (pruned ${prunedCount} lines)`);
  }

  return prunedCount;
}

/**
 * 指定ディレクトリ内の全閉じたセッションファイルを走査し、Pruneを実行する。
 *
 * @param sessionsDir - セッションディレクトリの絶対パス
 * @param config - Prune設定
 * @param logger - ログ出力関数（省略時はconsole.log）
 * @returns Pruneした総行数
 */
export function pruneAllClosedSessions(
  sessionsDir: string,
  config: DennouSessionToolsPruneConfig,
  logger: (msg: string) => void = console.log,
  protection?: DennouPruneProtectionConfig,
): number {
  if (!fs.existsSync(sessionsDir)) {
    logger(`[DennouAibou] SKIP (directory not found): ${sessionsDir}`);
    return 0;
  }

  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  let totalPruned = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(sessionsDir, entry.name);

    // 閉じたセッションのみ対象
    if (!entry.name.includes(".jsonl.deleted.") && !entry.name.includes(".jsonl.reset.")) {
      continue;
    }

    const pruned = pruneClosedSessionFile(fullPath, config, logger, protection);
    totalPruned += pruned;
  }

  return totalPruned;
}

/**
 * 全エージェントのセッションディレクトリを走査し、Pruneを実行する。
 *
 * @param config - Prune設定
 * @param logger - ログ出力関数
 * @param protection - 保護設定
 */
export function pruneAllAgentsClosedSessions(
  config: DennouSessionToolsPruneConfig,
  logger: (msg: string) => void = console.log,
  protection?: DennouPruneProtectionConfig,
): number {
  const agentsDir = path.join(os.homedir(), ".openclaw", "agents");
  if (!fs.existsSync(agentsDir)) {
    logger(`[DennouAibou] SKIP (agents directory not found): ${agentsDir}`);
    return 0;
  }

  const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true });
  let totalPruned = 0;

  for (const agentDir of agentDirs) {
    if (!agentDir.isDirectory()) continue;
    const sessionsDir = path.join(agentsDir, agentDir.name, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;

    const pruned = pruneAllClosedSessions(sessionsDir, config, logger, protection);
    totalPruned += pruned;
  }

  return totalPruned;
}

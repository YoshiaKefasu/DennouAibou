/**
 * 電脳サブエージェント — ログ整形 (DENNOU_SUBAGENT.md §4.2).
 *
 * `get_subagent_result` が返す途中経過ログを、単なる `🔧 bash` ではなく
 * 「何を実行したか」が分かる 1 行にする（例: `🔧 bash: git status --short`）。
 * 純関数だけを置き、runner / agent-run の両方から使う。
 */

import { inferToolMetaFromArgs } from "../../../src/agents/pi-embedded-utils.js";

/** ツールログ 1 行の最大長（DENNOU_SUBAGENT.md §4.2）。 */
export const MAX_TOOL_LOG_DETAIL_CHARS = 100;

/** ツール名ごとの「主引数」キー。ここから 1 つ目の値を詳細として使う。 */
const PRIMARY_ARG_KEYS: Record<string, readonly string[]> = {
  bash: ["command", "cmd"],
  exec: ["command", "cmd"],
  read: ["path", "file_path", "file"],
  edit: ["path", "file_path", "file"],
  write: ["path", "file_path", "file"],
  ls: ["path", "dir"],
  grep: ["pattern", "query", "glob"],
  find: ["pattern", "glob", "query"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function pickFirstStringValue(record: Record<string, unknown>): string | undefined {
  for (const value of Object.values(record)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

/** 空白（改行含む）を 1 スペースに潰し、上限文字数で切り詰める。 */
function collapseAndTruncate(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * ツール引数から「何をしたか」の 1 行詳細を抽出する。
 *
 * - `bash` → `git status --short`
 * - `read` / `edit` / `write` → `src/main.ts`
 * - `grep` / `find` → `TODO in src/`
 * - それ以外 → core の `inferToolMetaFromArgs` にフォールバック
 */
export function formatToolLogDetail(toolName: string, args: unknown): string | undefined {
  const name = toolName.trim().toLowerCase();
  const record = isRecord(args) ? args : undefined;
  if (!record) {
    return undefined;
  }

  if (name === "grep" || name === "find") {
    const pattern = pickString(record, PRIMARY_ARG_KEYS[name] ?? []);
    const where = pickString(record, ["path", "dir"]);
    if (pattern) {
      return where ? `${pattern} in ${where}` : pattern;
    }
    if (where) {
      return where;
    }
  } else {
    const primary = pickString(record, PRIMARY_ARG_KEYS[name] ?? []);
    if (primary) {
      return primary;
    }
  }

  const inferred = inferToolMetaFromArgs(name, args);
  if (inferred) {
    return inferred;
  }
  return pickFirstStringValue(record);
}

/** ツール実行ログの 1 行（例: `🔧 bash: git status --short`）。 */
export function formatToolLogLine(toolName: string, args: unknown): string {
  const name = toolName.trim() || "tool";
  const detail = formatToolLogDetail(name, args);
  const line = detail ? `🔧 ${name}: ${detail}` : `🔧 ${name}`;
  return collapseAndTruncate(line, MAX_TOOL_LOG_DETAIL_CHARS);
}

/** 割り込み指示をログに残す 1 行。 */
export function formatSteerLogLine(message: string): string {
  return collapseAndTruncate(`📨 追加指示: ${message}`, MAX_TOOL_LOG_DETAIL_CHARS);
}

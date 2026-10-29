/**
 * 電脳サブエージェント — ワークスペース定義スキャナ (DENNOU_SUBAGENT.md §2, §3).
 *
 * `workspace/agents/<name>.md` を走査し、YAML フロントマター
 * （`name` / `description` / `model` / `tools`）と本文（システムプロンプト）を抽出する。
 * 定義が無い場合はビルトイン定義をフォールバックとして保持する。
 *
 * Note: フロントマターは `yaml` パッケージで解析する。壊れた YAML は
 * フェイルオープン（メタデータ無し = ビルトイン名 + 本文のみ）として扱い、
 * サブエージェント機能そのものを停止させない。
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type AgentDefinitionSource = "workspace" | "builtin";

export type AgentDefinition = {
  /** 呼び出し名（小文字）。`subagent(agent=...)` のキーになる。 */
  name: string;
  description: string;
  /** `provider/model` 形式。未指定なら呼び出し元エージェントのモデルを継承する。 */
  model?: string;
  /**
   * 許可ツール名。未指定なら全ツール許可（`toolsAllow` を渡さない）。
   * Note: ここに制御系（`subagent` / `steer_subagent` / `stop_subagent`）や `memo` を
   * 書いても、実行時に `SUBAGENT_EXCLUDED_TOOLS` で除去される（再帰・兄弟操作・メモリ污染の遮断）。
   */
  tools?: string[];
  /** 本文 = 独立セッションのシステムプロンプト。 */
  systemPrompt: string;
  source: AgentDefinitionSource;
  filePath?: string;
};

/** ワークスペース直下のエージェント定義ディレクトリ名。 */
export const AGENTS_SUBDIR = "agents";

const EXECUTOR_PROMPT = [
  "あなたは電脳相棒 Kasou の右腕となる自律実行エージェント「Executor」です。",
  "KISS 原則を徹底し、最小限の安全な変更でコード実装や検証を行います。",
  "作業前に関連ファイルを読み、変更後は対象を絞った検証を一度だけ実行します。",
  "破壊的な操作（削除・一括巻き戻し・強制 push）は絶対に行いません。",
  "最後に、何を変更したのかと検証結果を簡潔にまとめて報告してください。",
].join("\n");

const EXPLORE_PROMPT = [
  "あなたは電脳相棒 Kasou の調査担当エージェント「Explore」です。",
  "読み取り専用で動作し、ファイルの変更・コマンドによる状態変更は行いません。",
  "質問に対して、根拠となるファイルパス・行・シンボルを挙げて簡潔に答えます。",
  "推測で断言せず、確認できた事実と未確認事項を分けて報告してください。",
].join("\n");

const REVIEWER_PROMPT = [
  "あなたは電脳相棒 Kasou のレビュー担当エージェント「Reviewer」です。",
  "読み取り専用で動作し、実装差分の正確性・安全性・回帰リスクのみを評価します。",
  "指摘は重大度順に、根拠（ファイルパス・行）付きで列挙してください。",
  "問題が無い場合は APPROVE と明記し、些末な好みの指摘は行いません。",
].join("\n");

/** ワークスペース定義が無いときのフォールバック定義。 */
export const BUILTIN_AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  {
    name: "executor",
    description: "コード実装・ファイル編集・コマンド実行を担当する自律エージェント",
    tools: ["bash", "read", "edit", "write", "grep", "find"],
    systemPrompt: EXECUTOR_PROMPT,
    source: "builtin",
  },
  {
    name: "explore",
    description: "コードベース調査・情報収集を担当する読み取り専用エージェント",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: EXPLORE_PROMPT,
    source: "builtin",
  },
  {
    name: "reviewer",
    description: "実装差分のレビュー・品質検証を担当する読み取り専用エージェント",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: REVIEWER_PROMPT,
    source: "builtin",
  },
];

function readString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function readTools(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tools = value
      .map((entry) => readString(entry))
      .filter((entry): entry is string => Boolean(entry));
    return tools.length > 0 ? tools : undefined;
  }
  const single = readString(value);
  if (!single) {
    return undefined;
  }
  const tools = single
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

/**
 * `---` 区切りのフロントマターブロックと本文へ分割する。
 * 先頭が `---` でない、または閉じ `---` が無い場合はメタデータ無しとして扱う。
 */
export function splitFrontmatter(content: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { meta: {}, body: normalized.trim() };
  }
  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      endIndex = index;
      break;
    }
  }
  if (endIndex === -1) {
    return { meta: {}, body: normalized.trim() };
  }
  const block = lines.slice(1, endIndex).join("\n");
  const body = lines
    .slice(endIndex + 1)
    .join("\n")
    .trim();
  let meta: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(block, { schema: "core" }) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    meta = {};
  }
  return { meta, body };
}

/** Markdown 1枚からエージェント定義を抽出する。 */
export function parseAgentDefinition(
  content: string,
  options: {
    fallbackName?: string;
    filePath?: string;
    source?: AgentDefinitionSource;
  } = {},
): AgentDefinition | undefined {
  const { meta, body } = splitFrontmatter(content);
  const rawName = readString(meta.name) ?? options.fallbackName ?? "";
  const name = rawName.trim().toLowerCase();
  if (!name) {
    return undefined;
  }
  return {
    name,
    description: readString(meta.description) ?? "",
    model: readString(meta.model),
    tools: readTools(meta.tools),
    systemPrompt: body,
    source: options.source ?? (options.filePath ? "workspace" : "builtin"),
    filePath: options.filePath,
  };
}

/** ディレクトリ内の `*.md` をすべて読み、名前昇順で定義を返す。 */
export function scanAgentDefinitions(dir: string): AgentDefinition[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const definitions: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const definition = parseAgentDefinition(content, {
      fallbackName: entry.name.slice(0, -3),
      filePath,
      source: "workspace",
    });
    if (definition) {
      definitions.push(definition);
    }
  }
  return definitions.sort((left, right) => left.name.localeCompare(right.name));
}

/** エージェント定義ディレクトリを解決する（`agentsDir` はワークスペース相対 or 絶対）。 */
export function resolveAgentsDir(workspaceDir: string, agentsDir?: string): string {
  const trimmed = agentsDir?.trim();
  if (trimmed) {
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(workspaceDir, trimmed);
  }
  return path.join(workspaceDir, AGENTS_SUBDIR);
}

/**
 * ビルトイン定義 + ワークスペース定義をマージした名前→定義マップを返す。
 * 同名の場合はワークスペース定義がビルトインを上書きする。
 */
export function loadAgentDefinitions(
  params: {
    workspaceDir?: string;
    agentsDir?: string;
    includeBuiltins?: boolean;
  } = {},
): Map<string, AgentDefinition> {
  const definitions = new Map<string, AgentDefinition>();
  if (params.includeBuiltins !== false) {
    for (const definition of BUILTIN_AGENT_DEFINITIONS) {
      definitions.set(definition.name, definition);
    }
  }
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return definitions;
  }
  for (const definition of scanAgentDefinitions(resolveAgentsDir(workspaceDir, params.agentsDir))) {
    definitions.set(definition.name, definition);
  }
  return definitions;
}

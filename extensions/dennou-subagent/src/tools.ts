/**
 * 電脳サブエージェント — エージェントツール (DENNOU_SUBAGENT.md §4).
 *
 * - `subagent(agent, task)`: 非同期で起動し、即座に `agent_id` を返す。
 * - `get_subagent_result(agent_id, wait?)`: 状態・最新ログ・最終結果を返す。
 */

import { Type } from "typebox";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../../src/agents/agent-scope.js";
import {
  readStringParam,
  textResult,
  type AnyAgentTool,
} from "../../../src/agents/tools/common.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { loadAgentDefinitions } from "./agent-scanner.js";
import type { SubagentManager, SubagentResult } from "./runner.js";

/** ツール生成に必要な呼び出し元コンテキスト（`OpenClawPluginToolContext` の部分集合）。 */
export type SubagentToolContext = {
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  config?: OpenClawConfig;
};

export const SubagentToolSchema = Type.Object({
  agent: Type.String({
    description:
      "呼び出すサブエージェント名（例: 'executor'）。workspace/agents/<name>.md かビルトイン定義（executor / explore / reviewer）から選ぶ。",
  }),
  task: Type.String({
    description: "サブエージェントへ依頼する具体的な指示。完了後に結果がシステム通知で届く。",
  }),
});

export const GetSubagentResultToolSchema = Type.Object({
  agent_id: Type.String({
    description: "subagent ツールが返したサブエージェントID（例: 'sub-1730000000000-a1b2c3'）。",
  }),
  wait: Type.Optional(
    Type.Boolean({
      description: "true なら完了まで待機する（既定: false、待機上限は120秒）。",
    }),
  ),
});

function resolveWorkspaceDir(context: SubagentToolContext): string {
  const explicit = context.workspaceDir?.trim();
  if (explicit) {
    return explicit;
  }
  const config = context.config;
  if (config) {
    const agentId = context.agentId?.trim() || resolveDefaultAgentId(config);
    return resolveAgentWorkspaceDir(config, agentId);
  }
  throw new Error(
    "サブエージェントのワークスペースが解決できません（workspaceDir も config も未指定）。",
  );
}

function resolveAgentDirFor(context: SubagentToolContext): string | undefined {
  const explicit = context.agentDir?.trim();
  if (explicit) {
    return explicit;
  }
  const config = context.config;
  if (!config) {
    return undefined;
  }
  return resolveAgentDir(config, context.agentId?.trim() || resolveDefaultAgentId(config));
}

function readWaitFlag(params: Record<string, unknown>): boolean {
  const raw = params.wait;
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    return raw.trim().toLowerCase() === "true";
  }
  return false;
}

/** `get_subagent_result` のテキスト表現。 */
export function formatSubagentResult(result: SubagentResult): string {
  const header = `【サブエージェント ${result.agentId} (${result.agent})】status: ${result.status}`;
  if (result.status === "completed") {
    return `${header}\n結果:\n${result.output.trim() || "(出力なし)"}`;
  }
  if (result.status === "failed") {
    const parts = [header, `エラー: ${result.error?.trim() || "不明なエラー"}`];
    if (result.output.trim()) {
      parts.push(`途中経過:\n${result.output.trim()}`);
    }
    return parts.join("\n");
  }
  const logLines = result.log.length > 0 ? result.log.join("\n") : "(まだログはありません)";
  return `${header}\n最新ログ:\n${logLines}`;
}

export function createSubagentTool(options: {
  manager: SubagentManager;
  context: SubagentToolContext;
  agentsDir?: string;
}): AnyAgentTool {
  return {
    label: "Subagent",
    name: "subagent",
    description:
      "ワークスペース定義のサブエージェントをバックグラウンド起動する。即座に agent_id を返し、完了結果は get_subagent_result またはシステム通知で受け取る。",
    parameters: SubagentToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const agent = readStringParam(params, "agent", { required: true });
      const task = readStringParam(params, "task", { required: true });
      const context = options.context;
      const workspaceDir = resolveWorkspaceDir(context);
      const definitions = loadAgentDefinitions({
        workspaceDir,
        agentsDir: options.agentsDir,
      });
      const started = options.manager.start({
        agent,
        task,
        definitions,
        context: {
          workspaceDir,
          agentDir: resolveAgentDirFor(context),
          configAgentId: context.agentId?.trim() || undefined,
          config: context.config,
          sessionKey: context.sessionKey,
        },
      });
      return textResult(
        `サブエージェント ${started.agent} を開始しました (agent_id: ${started.agentId}, status: ${started.status})。進捗は get_subagent_result で確認できます。`,
        started,
      );
    },
  };
}

export function createGetSubagentResultTool(options: { manager: SubagentManager }): AnyAgentTool {
  return {
    label: "Get Subagent Result",
    name: "get_subagent_result",
    description:
      "実行中または完了したサブエージェントの状態・最新ログ・最終結果を取得する。wait=true で完了まで待機できる。",
    parameters: GetSubagentResultToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const agentId = readStringParam(params, "agent_id") ?? readStringParam(params, "agentId");
      if (!agentId) {
        throw new Error("'agent_id' は必須です。");
      }
      const result = await options.manager.get(agentId, { wait: readWaitFlag(params) });
      return textResult(formatSubagentResult(result), result);
    },
  };
}

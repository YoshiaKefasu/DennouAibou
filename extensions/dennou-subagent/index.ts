/**
 * 電脳サブエージェント（dennou-subagent）— プラグインエントリ (DENNOU_SUBAGENT.md).
 *
 * 通話・テキストチャット・電脳屋敷のどこからでも同じ `subagent` / `get_subagent_result`
 * の2ツールを提供する完全独立プラグイン。メインエージェント（Kasou）のコンテキストを
 * 重い作業ログで汚染せず、ワークスペース定義（`workspace/agents/<name>.md`）の
 * 専門プロンプト・専門モデルでタスクを分担する。
 *
 * 責務は3つだけ:
 * 1. `subagent` / `get_subagent_result` ツールの登録。
 * 2. バックグラウンド実行マネージャー（`registerService`）の配線。
 * 3. 完了時のシステム通知（呼び出し元セッションへの自動報告）。
 */

import { definePluginEntry } from "../../src/plugin-sdk/plugin-entry.js";
import { createEmbeddedSubagentRunner, resolveSubagentModel } from "./src/agent-run.js";
import {
  AGENTS_SUBDIR,
  BUILTIN_AGENT_DEFINITIONS,
  loadAgentDefinitions,
  parseAgentDefinition,
  resolveAgentsDir,
  scanAgentDefinitions,
  splitFrontmatter,
} from "./src/agent-scanner.js";
import { createSystemEventNotifier, formatSubagentCompletionText } from "./src/notify.js";
import {
  createSubagentManager,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  MAX_LOG_LINES,
  MAX_RETAINED_RUNS,
} from "./src/runner.js";
import {
  createGetSubagentResultTool,
  createSubagentTool,
  formatSubagentResult,
  GetSubagentResultToolSchema,
  SubagentToolSchema,
} from "./src/tools.js";

export {
  AGENTS_SUBDIR,
  BUILTIN_AGENT_DEFINITIONS,
  createEmbeddedSubagentRunner,
  createGetSubagentResultTool,
  createSubagentManager,
  createSubagentTool,
  createSystemEventNotifier,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  formatSubagentCompletionText,
  formatSubagentResult,
  GetSubagentResultToolSchema,
  loadAgentDefinitions,
  MAX_LOG_LINES,
  MAX_RETAINED_RUNS,
  parseAgentDefinition,
  resolveAgentsDir,
  resolveSubagentModel,
  scanAgentDefinitions,
  splitFrontmatter,
  SubagentToolSchema,
};

export type { AgentDefinition, AgentDefinitionSource } from "./src/agent-scanner.js";
export type { EmbeddedSubagentRunnerDeps, RunEmbeddedAgentFn } from "./src/agent-run.js";
export type {
  SubagentManager,
  SubagentManagerOptions,
  SubagentNotifier,
  SubagentNotifyParams,
  SubagentResult,
  SubagentRun,
  SubagentRunFn,
  SubagentRunOutcome,
  SubagentRunRequest,
  SubagentStartParams,
  SubagentStartResult,
  SubagentStatus,
} from "./src/runner.js";
export type { SubagentToolContext } from "./src/tools.js";

export default definePluginEntry({
  id: "dennou-subagent",
  name: "電脳サブエージェント",
  description: "ワークスペース定義型 自律サブエージェント実行・管理プラグイン",
  register(api) {
    if (api.pluginConfig?.enabled === false) {
      api.logger.info("dennou-subagent: disabled by config");
      return;
    }

    const manager = createSubagentManager({
      runAgent: createEmbeddedSubagentRunner(),
      notify: createSystemEventNotifier(),
      logger: api.logger,
    });

    api.registerTool((ctx) => createSubagentTool({ manager, context: ctx }), {
      names: ["subagent"],
    });
    api.registerTool(() => createGetSubagentResultTool({ manager }), {
      names: ["get_subagent_result"],
    });

    api.registerService({
      id: "dennou-subagent",
      start(ctx) {
        const workspaceDir = ctx.workspaceDir?.trim();
        const definitions = loadAgentDefinitions({ workspaceDir });
        const workspaceCount = [...definitions.values()].filter(
          (definition) => definition.source === "workspace",
        ).length;
        api.logger.info(
          `dennou-subagent: 準備完了 — 利用可能なサブエージェント ${definitions.size} 件` +
            `（workspace/${AGENTS_SUBDIR}: ${workspaceCount} 件、ビルトイン: ${BUILTIN_AGENT_DEFINITIONS.length} 件）`,
        );
      },
      stop() {
        manager.stopAll("gateway 停止により中断されました");
      },
    });
  },
});

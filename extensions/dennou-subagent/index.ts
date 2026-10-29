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
import {
  createEmbeddedSteerAgent,
  createEmbeddedSubagentRunner,
  isExcludedSubagentTool,
  resolveSubagentModel,
  resolveSubagentTools,
  SUBAGENT_EXCLUDED_TOOLS,
} from "./src/agent-run.js";
import {
  AGENTS_SUBDIR,
  BUILTIN_AGENT_DEFINITIONS,
  loadAgentDefinitions,
  parseAgentDefinition,
  resolveAgentsDir,
  scanAgentDefinitions,
  splitFrontmatter,
} from "./src/agent-scanner.js";
import {
  formatSteerLogLine,
  formatToolLogDetail,
  formatToolLogLine,
  MAX_TOOL_LOG_DETAIL_CHARS,
} from "./src/log-format.js";
import { createSystemEventNotifier, formatSubagentCompletionText } from "./src/notify.js";
import {
  createSubagentManager,
  CALL_SESSION_KEY_PREFIX,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_GUARD_GRACE_MS,
  isCallSessionKey,
  isSubagentSessionKey,
  MAX_CONCURRENT_SUBAGENTS_CALL,
  MAX_CONCURRENT_SUBAGENTS_DEFAULT,
  MAX_LOG_LINES,
  MAX_RETAINED_RUNS,
  SUBAGENT_SESSION_KEY_PREFIX,
  SUBAGENT_STOPPED_REASON,
} from "./src/runner.js";
import {
  createGetSubagentResultTool,
  createStopSubagentTool,
  createSteerSubagentTool,
  createSubagentTool,
  formatSubagentResult,
  GetSubagentResultToolSchema,
  SteerSubagentToolSchema,
  StopSubagentToolSchema,
  SubagentToolSchema,
} from "./src/tools.js";

export {
  AGENTS_SUBDIR,
  BUILTIN_AGENT_DEFINITIONS,
  CALL_SESSION_KEY_PREFIX,
  createEmbeddedSteerAgent,
  createEmbeddedSubagentRunner,
  createGetSubagentResultTool,
  createStopSubagentTool,
  createSteerSubagentTool,
  createSubagentManager,
  createSubagentTool,
  createSystemEventNotifier,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_GUARD_GRACE_MS,
  formatSteerLogLine,
  formatSubagentCompletionText,
  formatSubagentResult,
  formatToolLogDetail,
  formatToolLogLine,
  GetSubagentResultToolSchema,
  isCallSessionKey,
  isExcludedSubagentTool,
  isSubagentSessionKey,
  loadAgentDefinitions,
  MAX_CONCURRENT_SUBAGENTS_CALL,
  MAX_CONCURRENT_SUBAGENTS_DEFAULT,
  MAX_LOG_LINES,
  MAX_RETAINED_RUNS,
  MAX_TOOL_LOG_DETAIL_CHARS,
  parseAgentDefinition,
  resolveAgentsDir,
  resolveSubagentModel,
  resolveSubagentTools,
  scanAgentDefinitions,
  splitFrontmatter,
  SteerSubagentToolSchema,
  StopSubagentToolSchema,
  SUBAGENT_EXCLUDED_TOOLS,
  SUBAGENT_SESSION_KEY_PREFIX,
  SUBAGENT_STOPPED_REASON,
  SubagentToolSchema,
};

export type { AgentDefinition, AgentDefinitionSource } from "./src/agent-scanner.js";
export type {
  EmbeddedSubagentRunnerDeps,
  ResolvedSubagentTools,
  RunEmbeddedAgentFn,
  SteerAgentFn,
  SubscribeAgentEventsFn,
} from "./src/agent-run.js";
export type {
  SteerAgent,
  SubagentControlResult,
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
      steerAgent: createEmbeddedSteerAgent(),
      notify: createSystemEventNotifier(),
      logger: api.logger,
    });

    api.registerTool((ctx) => createSubagentTool({ manager, context: ctx }), {
      names: ["subagent"],
    });
    api.registerTool(() => createGetSubagentResultTool({ manager }), {
      names: ["get_subagent_result"],
    });
    api.registerTool(() => createSteerSubagentTool({ manager }), {
      names: ["steer_subagent"],
    });
    api.registerTool(() => createStopSubagentTool({ manager }), {
      names: ["stop_subagent"],
    });

    // memo の構造的遮断（BLOCKER 3 の堅牢化）。
    // `tools` 未指定の定義（全ツール許可）でも memo が実行されないよう、
    // サブエージェントセッションからの呼び出しをランタイムで拒否する。
    api.on("before_tool_call", (event, ctx) => {
      if (!isSubagentSessionKey(ctx.sessionKey)) {
        return undefined;
      }
      if (!isExcludedSubagentTool(event.toolName)) {
        return undefined;
      }
      return {
        block: true,
        blockReason:
          "サブエージェントセッションでは memo ツールを使用できません（メモリ汚染防止）。",
      };
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

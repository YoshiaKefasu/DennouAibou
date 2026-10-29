/**
 * 電脳サブエージェント — 本番ランナー (DENNOU_SUBAGENT.md §4.1, §5).
 *
 * `runEmbeddedPiAgent` を使い、呼び出し元の会話とは独立したモデルセッションで
 * タスクを1ターン実行する。エージェント定義の本文を `extraSystemPrompt`、
 * `tools` を `toolsAllow` として渡すため、定義ファイルがそのまま実行ポリシーになる。
 *
 * Note: セッショントランスクリプトは1実行ごとの一時ディレクトリに置き、完了時に破棄する
 * （メインのセッションストアを汚染しないため）。成果物はマネージャー側の
 * `output` / `log` に保持される。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentEffectiveModelPrimary } from "../../../src/agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../src/agents/defaults.js";
import { parseModelRef } from "../../../src/agents/model-selection.js";
import type { RunEmbeddedPiAgentParams } from "../../../src/agents/pi-embedded-runner/run/params.js";
import {
  queueEmbeddedPiMessage,
  runEmbeddedPiAgent,
  type EmbeddedPiRunResult,
} from "../../../src/agents/pi-embedded.js";
import { onAgentEvent, type AgentEventPayload } from "../../../src/infra/agent-events.js";
import type { AgentDefinition } from "./agent-scanner.js";
import { formatToolLogLine } from "./log-format.js";
import type { SubagentRunFn, SubagentRunOutcome, SubagentRunRequest } from "./runner.js";

/**
 * サブエージェントに常時禁止するツール。
 *
 * - `memo`: 使い捨ての独立セッションなので、メインの能動記憶を同期させない（メモリ污染の構造的遮断）。
 * - `subagent` / `steer_subagent` / `stop_subagent`: オーケストレーション制御系。
 *   サブエージェント自身の再帰起動（無限増殖）や、兄弟エージェントの勝手な操作を防ぐ。
 */
export const SUBAGENT_EXCLUDED_TOOLS: readonly string[] = [
  "memo",
  "subagent",
  "steer_subagent",
  "stop_subagent",
];

/** 除外対象のツール名かどうか（大文字小文字は無視）。 */
export function isExcludedSubagentTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return SUBAGENT_EXCLUDED_TOOLS.some((excluded) => excluded === normalized);
}

/** 1ターンの組み込みエージェント実行関数（テストで差し替え可能）。 */
export type RunEmbeddedAgentFn = (params: RunEmbeddedPiAgentParams) => Promise<EmbeddedPiRunResult>;

/** エージェントイベント購読関数（テストで差し替え可能）。 */
export type SubscribeAgentEventsFn = (listener: (event: AgentEventPayload) => void) => () => void;

/** 実行中サブエージェントへの割り込み送信関数。 */
export type SteerAgentFn = (params: { runId: string; message: string }) => boolean;

export type EmbeddedSubagentRunnerDeps = {
  /** 既定は本物の `runEmbeddedPiAgent`。 */
  runEmbedded?: RunEmbeddedAgentFn;
  /** 既定は `onAgentEvent`（ツール実行ログの詳細化に使う）。 */
  subscribeAgentEvents?: SubscribeAgentEventsFn;
};

/**
 * 使用モデルを解決する。
 * 優先順: 定義の `model` → 呼び出し元エージェントの実効モデル → 既定プロバイダ/モデル。
 */
export function resolveSubagentModel(
  request: Pick<SubagentRunRequest, "definition" | "config" | "configAgentId">,
): { provider: string; model: string } {
  const explicit = request.definition.model?.trim();
  const inherited =
    explicit ||
    (request.config && request.configAgentId
      ? resolveAgentEffectiveModelPrimary(request.config, request.configAgentId)
      : undefined);
  const parsed = inherited ? parseModelRef(inherited, DEFAULT_PROVIDER) : null;
  return {
    provider: parsed?.provider ?? DEFAULT_PROVIDER,
    model: parsed?.model ?? DEFAULT_MODEL,
  };
}

function collectOutput(payloads: readonly { text?: string }[] | undefined): string {
  return (payloads ?? [])
    .map((payload) => (typeof payload.text === "string" ? payload.text.trim() : ""))
    .filter(Boolean)
    .join("\n");
}

/** 本番用の割り込み送信関数（`queueEmbeddedPiMessage` を runId で引く）。 */
export function createEmbeddedSteerAgent(): SteerAgentFn {
  return ({ runId, message }) => queueEmbeddedPiMessage(runId, message);
}

/** `runEmbedded` に渡すツール制御。 */
export type ResolvedSubagentTools = {
  /** 明示許可リスト。`undefined` は「制限なし（全ツール）」を意味する。 */
  toolsAllow?: string[];
  /** ツールを完全に無効化する（空配列の代わりに使う）。 */
  disableTools?: boolean;
};

/**
 * エージェント定義の `tools` から実際のツール制御を組み立てる。
 *
 * 重要な落とし穴: `runEmbeddedPiAgent` は `toolsAllow` が**空配列**のとき
 * 「指定なし」と同じく全ツール許可として扱う（`attempt.ts` の `length > 0` 判定）。
 * したがって `tools: ["memo"]` のように全部除外されて空になるケースで `[]` を渡すと
 * fail-open（除外ツールを含む全許可）に化ける。空になる場合は `disableTools: true` で
 * 「ツール 0 件」を明示する。
 *
 * Note: `tools` 未指定（全ツール許可）のときの除外ツール遮断は `toolsAllow` では表現できないため、
 * `before_tool_call` フック（`index.ts`）でサブエージェントセッションからの
 * `SUBAGENT_EXCLUDED_TOOLS`（memo / subagent / steer_subagent / stop_subagent）を実行時に拒否する。
 */
export function resolveSubagentTools(
  definition: Pick<AgentDefinition, "tools">,
): ResolvedSubagentTools {
  const declared = (definition.tools ?? []).map((name) => name.trim()).filter(Boolean);
  if (declared.length === 0) {
    return {};
  }
  const allowed = declared.filter((name) => !isExcludedSubagentTool(name));
  if (allowed.length === 0) {
    return { disableTools: true };
  }
  return { toolsAllow: allowed };
}

/** 本番用 `SubagentRunFn`。1タスク = 1独立モデルセッション。 */
export function createEmbeddedSubagentRunner(deps: EmbeddedSubagentRunnerDeps = {}): SubagentRunFn {
  const runEmbedded = deps.runEmbedded ?? runEmbeddedPiAgent;
  const subscribeAgentEvents = deps.subscribeAgentEvents ?? onAgentEvent;
  return async (request) => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "dennou-subagent-"));
    const sessionFile = path.join(sessionDir, "session.jsonl");
    const { provider, model } = resolveSubagentModel(request);
    const tools = resolveSubagentTools(request.definition);
    request.onLog(`▶ 開始 (${provider}/${model})`);
    // ツール実行ログの詳細化（DENNOU_SUBAGENT.md §4.2）。
    // `onAgentEvent` の `tool/start` には引数が含まれないため、引数付きの
    // エージェントイベントバスを runId で絞って購読する。
    const unsubscribe = subscribeAgentEvents((event) => {
      if (event.runId !== request.runId) {
        return;
      }
      if (event.stream !== "tool" || event.data?.phase !== "start") {
        return;
      }
      const name = typeof event.data.name === "string" ? event.data.name : "tool";
      request.onLog(formatToolLogLine(name, event.data.args));
    });
    try {
      const result = await runEmbedded({
        sessionId: request.runId,
        sessionKey: request.sessionKey,
        agentId: request.configAgentId,
        sessionFile,
        workspaceDir: request.workspaceDir,
        agentDir: request.agentDir,
        config: request.config,
        prompt: request.task,
        provider,
        model,
        extraSystemPrompt: request.definition.systemPrompt || undefined,
        // memo はサブエージェントに不要（同期させない）。空になったら disableTools で 0 件にする。
        toolsAllow: tools.toolsAllow,
        disableTools: tools.disableTools,
        timeoutMs: request.timeoutMs,
        runId: request.runId,
        abortSignal: request.signal,
      });

      const output = collectOutput(result.payloads);
      if (result.meta.aborted) {
        const outcome: SubagentRunOutcome = { error: "サブエージェント実行が中断されました。" };
        if (output) {
          outcome.output = output;
        }
        return outcome;
      }
      if (result.meta.error) {
        const outcome: SubagentRunOutcome = { error: result.meta.error.message };
        if (output) {
          outcome.output = output;
        }
        return outcome;
      }
      return { output: output || "(サブエージェントからのテキスト出力はありません)" };
    } finally {
      unsubscribe();
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {
        // 一時ディレクトリの掃除失敗は無視する（OS の tmp 掃除に任せる）。
      }
    }
  };
}

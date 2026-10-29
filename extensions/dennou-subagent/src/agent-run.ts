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
import { runEmbeddedPiAgent } from "../../../src/agents/pi-embedded.js";
import type { SubagentRunFn, SubagentRunOutcome, SubagentRunRequest } from "./runner.js";

function resolveModel(request: SubagentRunRequest): { provider: string; model: string } {
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

/** 本番用 `SubagentRunFn`。1タスク = 1独立モデルセッション。 */
export function createEmbeddedSubagentRunner(): SubagentRunFn {
  return async (request) => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "dennou-subagent-"));
    const sessionFile = path.join(sessionDir, "session.jsonl");
    const { provider, model } = resolveModel(request);
    request.onLog(`▶ 開始 (${provider}/${model})`);
    try {
      const result = await runEmbeddedPiAgent({
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
        toolsAllow:
          request.definition.tools && request.definition.tools.length > 0
            ? request.definition.tools
            : undefined,
        timeoutMs: request.timeoutMs,
        runId: request.runId,
        abortSignal: request.signal,
        onAgentEvent: (event) => {
          if (event.stream !== "tool" || event.data?.phase !== "start") {
            return;
          }
          const name = typeof event.data.name === "string" ? event.data.name : "tool";
          request.onLog(`🔧 ${name}`);
        },
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
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {
        // 一時ディレクトリの掃除失敗は無視する（OS の tmp 掃除に任せる）。
      }
    }
  };
}

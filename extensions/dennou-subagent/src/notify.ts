/**
 * 電脳サブエージェント — 完了通知 (DENNOU_SUBAGENT.md §4.4, §5).
 *
 * サブエージェントが完了/失敗した瞬間に、呼び出し元セッション（既定はメインセッション）へ
 * `role: "system"` の通知イベントを積み、イベントポンプを1回回して
 * 「最後に会話していたチャネル」へ Kasou から報告させる。
 * 依存は注入可能にしてあり、テストは実ゲートウェイ無しで通知内容だけ検証できる。
 */

import type { OpenClawConfig } from "../../../src/config/config.js";
import { resolveMainSessionKey } from "../../../src/config/sessions/main-session.js";
import { requestWakeNow, runEventPumpOnce } from "../../../src/infra/event-pump.js";
import { enqueueSystemEvent } from "../../../src/infra/system-events.js";
import type { SubagentNotifier, SubagentRun } from "./runner.js";

const MAX_SUMMARY_CHARS = 800;

function summarize(text: string | undefined, maxChars: number): string {
  const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "(出力なし)";
  }
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

/** メインセッションへ注入する完了通知テキスト。 */
export function formatSubagentCompletionText(run: SubagentRun): string {
  if (run.status === "failed") {
    return `[システム通知] サブエージェント ${run.agent} (${run.agentId}) が失敗しました。エラー: ${summarize(run.error, MAX_SUMMARY_CHARS)}`;
  }
  return `[システム通知] サブエージェント ${run.agent} (${run.agentId}) が完了しました。結果: ${summarize(run.output, MAX_SUMMARY_CHARS)}`;
}

export type SubagentNotifierDeps = {
  enqueueSystemEvent?: typeof enqueueSystemEvent;
  runEventPumpOnce?: typeof runEventPumpOnce;
  requestWakeNow?: typeof requestWakeNow;
  resolveSessionKey?: (config?: OpenClawConfig) => string;
};

export function createSystemEventNotifier(deps: SubagentNotifierDeps = {}): SubagentNotifier {
  const enqueue = deps.enqueueSystemEvent ?? enqueueSystemEvent;
  const pump = deps.runEventPumpOnce ?? runEventPumpOnce;
  const wake = deps.requestWakeNow ?? requestWakeNow;
  const resolveKey = deps.resolveSessionKey ?? ((config) => resolveMainSessionKey(config));

  return async ({ run, sessionKey, config }) => {
    const targetKey = sessionKey?.trim() || resolveKey(config);
    const reason = `dennou-subagent:${run.agentId}`;
    enqueue(formatSubagentCompletionText(run), {
      sessionKey: targetKey,
      contextKey: reason,
    });
    const result = await pump({
      cfg: config,
      sessionKey: targetKey,
      reason,
      heartbeat: { target: "last" },
    });
    // ポンプが走らなかった場合（処理中など）は wake を積んで取りこぼしを防ぐ。
    if (result.status === "skipped") {
      wake({ reason, sessionKey: targetKey });
    }
  };
}

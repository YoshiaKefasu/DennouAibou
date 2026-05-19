/**
 * アクティブセッションのIdle検知 + ツール出力Prune
 *
 * 上流の `onDiagnosticEvent()` で `session.state: "idle"` をlistenし、
 * `idleDelayMinutes` 分間沈黙が続いたらセッションJSONLのツール出力をPruneする。
 *
 * セーフガード:
 * 1. Idle Timer: ユーザーが復帰（processing）したら即座にタイマーをキャンセル
 * 2. Dry-Run: デフォルトはログ出力のみ
 * 3. 上流への影響ゼロ: エラーは console.warn で握る
 *
 * DENNOU_RULES.md Rule 1 (Encapsulation) に従い、上流コードは一切変更しない。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  onDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import type { DennouPruneProtectionConfig } from "./types.js";
import { getDennouConfig } from "./config.js";
import { pruneActiveSessionFile } from "./prune-active-session.js";
import { logDebug } from "../logger.js";

/**
 * セッションキー（`agent:{agentId}:{wsHash}`）→ タイマーID のマップ
 */
type IdleTimerEntry = {
  timer: ReturnType<typeof setTimeout>;
  /**
   * Session file id captured from the idle diagnostic event.
   * Some higher-level completion events only carry sessionKey; those must not
   * overwrite a richer timer that already knows the JSONL file to prune.
   */
  sessionId?: string;
};

const idleTimers = new Map<string, IdleTimerEntry>();

/**
 * `sessionKey` からエージェントIDを抽出する。
 *
 * sessionKey のフォーマット: `agent:{agentId}:{wsHash}`
 * 例: `agent:main:ws_hash` → `main`
 */
function extractAgentId(sessionKey: string): string | undefined {
  const parts = sessionKey.split(":");
  if (parts.length >= 2 && parts[0] === "agent") {
    return parts[1];
  }
  return undefined;
}

/**
 * エージェントIDとセッションIDからJSONLファイルの絶対パスを構築する。
 */
function buildSessionFilePath(agentId: string, sessionId: string): string {
  return path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

/**
 * Idleイベントを受信した際の処理
 *
 * configは `getDennouConfig()` から都度読み込むため、
 * openclaw.json の変更 → config-reload → 次回idleイベント のタイミングで自動反映される。
 */
function handleIdleEvent(
  evt: DiagnosticEventPayload & { type: "session.state" },
  protection?: DennouPruneProtectionConfig,
): void {
  const sessionKey = evt.sessionKey;
  if (!sessionKey) return;

  // idle以外は無視
  if (evt.state !== "idle") return;

  // configを都度読み込み（hot-reload対応）
  const dennocfg = getDennouConfig();
  const config = dennocfg.activeSessionToolsPrune;
  if (!config.enabled) return;

  // 既存のタイマーをクリア
  const existing = idleTimers.get(sessionKey);
  if (!evt.sessionId && existing?.sessionId) {
    logDebug(
      `[DennouAibou] Keep existing idle prune timer with sessionId=${existing.sessionId}; ignored sessionId-less idle event for sessionKey=${sessionKey}`,
    );
    return;
  }
  if (existing) {
    clearTimeout(existing.timer);
  }

  // 新しいIdleタイマーを起動
  const delayMs = config.idleDelayMinutes * 60_000;
  const timer = setTimeout(() => {
    idleTimers.delete(sessionKey);

    const agentId = extractAgentId(sessionKey);
    if (!agentId || !evt.sessionId) {
      console.warn(
        `[DennouAibou] SKIP prune (missing agentId or sessionId): sessionKey=${sessionKey}`,
      );
      return;
    }

    const filePath = buildSessionFilePath(agentId, evt.sessionId);
    if (!fs.existsSync(filePath)) {
      console.warn(`[DennouAibou] SKIP prune (session file gone): ${filePath}`);
      return;
    }

    const result = pruneActiveSessionFile(filePath, config, (msg) => {
      logDebug(msg);
    }, protection);

    if (result === -1) {
      console.warn(`[DennouAibou] Prune aborted for ${filePath} (file changed mid-operation)`);
    } else if (result > 0) {
      logDebug(
        `[DennouAibou] Idle prune complete: ${filePath} (${result} lines pruned)`,
      );
    }
  }, delayMs);

  idleTimers.set(sessionKey, { timer, sessionId: evt.sessionId });

  if (config.dryRun) {
    logDebug(
      `[DennouAibou] DRY-RUN idle timer set: sessionKey=${sessionKey} delay=${config.idleDelayMinutes}min`,
    );
  }
}

/**
 * Idle Prune Watcher を開始する。
 *
 * `onDiagnosticEvent()` で全 `session.state` イベントをlistenし、
 * `"idle"` に遷移したらタイマーを起動する。
 *
 * configは `getDennouConfig()` から都度読み込むため、openclaw.json の変更が
 * config-reload 経由で自動反映される。
 *
 * @param protection - 保護設定（ワークスペースパス自動解決済み）
 * @returns クリーンアップ関数（テストやシャットダウン時に呼び出す）
 */
export function startIdlePruneWatcher(
  protection?: DennouPruneProtectionConfig,
): () => void {
  const dennocfg = getDennouConfig();
  const config = dennocfg.activeSessionToolsPrune;
  if (!config.enabled) {
    logDebug("[DennouAibou] Idle prune watcher disabled by config");
    return () => {};
  }

  logDebug(
    `[DennouAibou] Idle prune watcher started (delay=${config.idleDelayMinutes}min, dryRun=${config.dryRun})`,
  );

  const removeListener = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
    try {
      if (evt.type !== "session.state") return;
      const stateEvt = evt as DiagnosticEventPayload & { type: "session.state" };

      if (stateEvt.state === "idle") {
        handleIdleEvent(stateEvt, protection);
      } else if (stateEvt.state === "processing" || stateEvt.state === "waiting") {
        // セッションがアクティブに戻った → タイマーキャンセル
        const sessionKey = stateEvt.sessionKey;
        if (sessionKey && idleTimers.has(sessionKey)) {
          clearTimeout(idleTimers.get(sessionKey)!.timer);
          idleTimers.delete(sessionKey);
        }
      }
    } catch (err) {
      console.warn(
        `[DennouAibou] Error in idle prune listener: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // クリーンアップ関数を返す
  return () => {
    removeListener();
    // 全タイマーをクリア
    for (const [key, entry] of idleTimers) {
      clearTimeout(entry.timer);
    }
    idleTimers.clear();
    logDebug("[DennouAibou] Idle prune watcher stopped");
  };
}

/**
 * 上流 saveSessionStore 完了後のポストフック
 *
 * セッションストアの保存が完了した後、閉じたセッションJSONLの
 * ツール出力Pruneを実施する。エラーが発生しても上流には影響させない。
 *
 * DENNOU_RULES.md Rule 1 (Encapsulation) に従い、依存は最小限に。
 * グローバルフック `setAfterSaveHook` を使って上流に1行のインターフェースを
 * 追加するだけで、DennouAibouの実装を知らせずにフックできる。
 */
import * as path from "node:path";
import { setAfterSaveHook } from "../config/sessions/store.js";
import { getDennouConfig } from "./config.js";
import { pruneAllClosedSessions } from "./prune-closed-sessions.js";
import { logDebug } from "../logger.js";

/** キャッシュ済みのワークスペースパス（初回呼び出し時に解決） */
let cachedWsProtection: import("./types.js").DennouPruneProtectionConfig | null = null;

/** ワークスペースパスを解決して保護設定を返す（失敗時は設定ファイルの値） */
async function resolveProtectionWithWorkspacePaths(): Promise<import("./types.js").DennouPruneProtectionConfig> {
  if (cachedWsProtection) return cachedWsProtection;
  const config = getDennouConfig();
  const base = config.pruneProtection;
  try {
    const { resolveAgentWorkspaceDir, listAgentIds } = await import("../agents/agent-scope.js");
    const { getRuntimeConfig } = await import("../config/config.js");
    const cfg = getRuntimeConfig();
    const wsPaths = listAgentIds(cfg).map(id => resolveAgentWorkspaceDir(cfg, id));
    if (wsPaths.length > 0) {
      cachedWsProtection = { ...base, resolvedWorkspacePaths: wsPaths };
      return cachedWsProtection;
    }
  } catch {
    // Best-effort: ワークスペースパス解決失敗は非致命
  }
  cachedWsProtection = base;
  return cachedWsProtection;
}

/**
 * saveSessionStore() 完了後のコールバック。
 *
 * @param storePath - 保存された session store のパス
 *   （例: ~/.openclaw/agents/{agentId}/store.json）
 */
async function afterSavePrune(storePath: string): Promise<void> {
  try {
    const config = getDennouConfig();
    if (!config.sessionToolsPrune.enabled) {
      return;
    }

    // storePath は ".../sessions/sessions.json" の形で渡されるため、
    // dirname が正しい sessions ディレクトリになる。
    const sessionsDir = path.dirname(storePath);

    // protection設定（ワークスペースパス自動解決込み）
    const protection = await resolveProtectionWithWorkspacePaths();

    pruneAllClosedSessions(sessionsDir, config.sessionToolsPrune, (msg) => {
      logDebug(msg);
    }, protection);
  } catch (err) {
    console.warn(
      `[DennouAibou] afterSavePrune failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * DennouAibouのセッション管理フックを上流に登録する。
 * エージェント初期化時に1回だけ呼び出せばよい。
 */
export function initSessionMaintenanceHook(): void {
  setAfterSaveHook(afterSavePrune);
}

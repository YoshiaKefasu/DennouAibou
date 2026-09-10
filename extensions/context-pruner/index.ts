/**
 * context-pruner — 統合ツール出力圧縮プラグイン（COMPACTION_FEATURE.md Phase 1）
 *
 * `tool_result_persist` フック（書き込み時介入）により、セッションJSONLへ永続化される
 * ツール結果を「書き込みの瞬間」に軽量プレースホルダー化する。これにより:
 *
 * - セッションファイル自体が軽量プレースホルダーになる（次回のプロンプト構築時に
 *   インメモリ側で再目隠しする旧 context-pruning 方式は不要）。
 * - `id` / `parentId` / `toolCallId` / `toolName` / `isError` 等のJSON構造・親子リンクは
 *   100% 保持されるため、SESSION_INTEGRITY_GUARD の検証を通過する。
 * - 既にプレースホルダー化されたエントリ（`[出力省略:` / `[Old tool output`）は
 *   二重に置換しない（冪等性）。
 *
 * 直近ターン保護はセッションごとの観測済みアシスタント発言数（in-memory）をフェンスとし、
 * トランスクリプト全体に対する末尾Nターン保護は共有エンジン
 * （src/dennou-soul/prune-engine.ts の findAssistantCutoffIndex）が担う。
 *
 * 有効化: kind: "memory" のプラグインはメモリスロットに選定されないとロードされない。
 * `plugins.slots.memory: "context-pruner"` を設定すること（コンフィグ例:
 * plugins.entries["context-pruner"].enabled + plugins.slots.memory）。
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveContextPrunerConfig,
  transformToolResultForPersistence,
  type ContextPrunerConfig,
} from "./src/pruner.js";

export { resolveContextPrunerConfig, transformToolResultForPersistence } from "./src/pruner.js";
export type { ContextPrunerConfig, PruneDecision } from "./src/pruner.js";
export { CONTEXT_PRUNER_DEFAULT_KEYWORDS, TOOL_RESULT_SAFETY_CAP_CHARS } from "./src/pruner.js";

// 裏方圧縮 ステップ 1（COMPACTION_FEATURE.md §7.1 / §7.2）: 時間認識による
// ブロック分割エンジン（純粋関数）。今後の Background Historian 統合で使用する。
export {
  detectTemporalPauses,
  partitionHistoryBlocks,
  estimateMessageChars,
  estimateMessageTokens,
  DEFAULT_MAX_BLOCK_TOKENS,
  DEFAULT_MIN_PAUSE_THRESHOLD_MS,
  DEFAULT_PAUSE_MULTIPLIER,
} from "./src/compartment.js";
export type { CompartmentMessage, HistoryBlock, PartitionOptions } from "./src/compartment.js";

// 裏方圧縮 ステップ 2（COMPACTION_FEATURE.md §7.3 / §7.4 / §7.5）: 一時退避安全弁
// （インメモリフィルター）。コンテキストが閾値（既定 950K）を超えた際、プロンプト
// 構築時に直近 250K より古い過去ブロックを一時退避する。セッションファイル
// （.jsonl）の実ログは 100% 保持され、プロンプトへの注入のみがスキップされる。
export {
  applyPromptEvictionSafetyValve,
  isEvictionSafetyValveEnabled,
  resolveEvictionOptionsFromCompaction,
  DEFAULT_EVICTION_THRESHOLD_TOKENS,
  DEFAULT_PROTECTED_RECENT_TOKENS,
  DEFAULT_EVICTION_NOTICE,
  DEFAULT_EVICTION_BASE_CONTEXT_TOKENS,
} from "./src/eviction.js";
export type { EvictionOptions, EvictionResult, CompactionConfigLike } from "./src/eviction.js";

// 裏方圧縮 ステップ 3（COMPACTION_FEATURE.md §7.2 / §7.5）: 裏方要約（Historian）と
// 章立て目次管理。950K 到達時に過去ブロック群を小分け（maxBatches）で要約生成・蓄積し、
// 一時退避されている過去領域をプロンプト上で「章立て要約目次」へ安全に差し替える。
// セッションファイル（.jsonl）の実ログは不変（インメモリ管理のみ）。
export {
  formatTableOfContents,
  reconcileBlockSummaries,
  TABLE_OF_CONTENTS_HEADER,
  TABLE_OF_CONTENTS_REVERSIBILITY_NOTE,
} from "./src/historian.js";
export type { BlockSummary, SummarizeFn, ReconcileBlockSummariesParams } from "./src/historian.js";

/** セッションキー（sessionKey 優先、無ければ agentId） */
function sessionCounterKey(ctx: { sessionKey?: string; agentId?: string }): string | undefined {
  return ctx.sessionKey ?? ctx.agentId;
}

/**
 * セッションごとの観測済みアシスタント発言数（直近Nターン保護のフェンス用）。
 * プロセス内メモリのみ。session_start でリセット、session_end で削除する。
 */
const assistantTurnCounts = new Map<string, number>();
const MAX_TRACKED_SESSIONS = 512;

function bumpSessionCounter(key: string): number {
  const next = (assistantTurnCounts.get(key) ?? 0) + 1;
  assistantTurnCounts.set(key, next);
  return next;
}

/** 追跡上限を超えたら全クリア（クリーンアップは session_end 側でも実施）。 */
function enforceSessionCounterBound(): void {
  if (assistantTurnCounts.size > MAX_TRACKED_SESSIONS) {
    assistantTurnCounts.clear();
  }
}

function readPluginConfig(
  api: Parameters<Parameters<typeof definePluginEntry>[0]["register"]>[0],
): ContextPrunerConfig {
  return resolveContextPrunerConfig(
    (api as unknown as { pluginConfig?: Record<string, unknown> }).pluginConfig,
  );
}

export default definePluginEntry({
  id: "context-pruner",
  name: "Context Pruner",
  description:
    "Write-time tool-result compaction: placeholder-izes oversized tool outputs in session JSONL while preserving JSON structure and recent-turn protection",
  kind: "memory",
  register(api) {
    const config = readPluginConfig(api);

    // セッション開始: 観測フェンスをリセット（このセッションの直近Nターンを保護する）
    api.on("session_start", (event) => {
      const key = event.sessionKey ?? event.sessionId;
      if (key) {
        assistantTurnCounts.set(key, 0);
      }
      enforceSessionCounterBound();
    });

    // セッション終了: 追跡エントリを解放（メモリリーク防止）
    api.on("session_end", (event) => {
      const key = event.sessionKey ?? event.sessionId;
      if (key) {
        assistantTurnCounts.delete(key);
      }
    });

    // 軽量な観測のみ: アシスタント発言の書き込みを数える（直近ターン保護の境界判定用）。
    // ここでは一切メッセージを変更しない。
    // 注: sessionKey/agentId は event ではなく ctx 側で運ばれる。
    api.on("before_message_write", (event, ctx) => {
      const role = (event.message as { role?: unknown }).role;
      if (role === "assistant") {
        const key = sessionCounterKey(ctx);
        if (key) {
          bumpSessionCounter(key);
        }
      }
      return undefined;
    });

    // 書き込み時介入の本体: ツール結果をプレースホルダー化する。
    // preserve: true（ツール呼び出し引数由来）は生データのまま保持する。
    api.on("tool_result_persist", (event, ctx) => {
      if (!config.enabled) {
        return undefined;
      }
      const key = sessionCounterKey(ctx);
      const assistantTurnCount = key ? (assistantTurnCounts.get(key) ?? 0) : 0;
      const preserve = event.preserve ?? ctx.preserve;
      const decision = transformToolResultForPersistence(event.message, config, {
        assistantTurnCount,
        preserve,
      });
      if (decision.message !== event.message) {
        return { message: decision.message };
      }
      return undefined;
    });
  },
});

/**
 * context-pruner — 裏方圧縮 ステップ 3: 裏方要約（Historian）・章立て目次管理
 *
 * 仕様: DENNOU_DOCS/COMPACTION_FEATURE.md §7.2 / §7.5
 *
 * 950K 到達時に、直近 250K より古い過去ブロック群を小分け（maxHistoryShare 相当の
 * 1ブロック = maxBlockTokens バジェット内）で章立て要約し、一時退避されている過去領域を
 * プロンプト上で「章立て要約目次（コンパートメント要約）」へ安全に差し替えるための
 * 純粋関数モジュール。
 *
 * - データ型: BlockSummary（1章分の要約メタデータ）/ SummarizeFn（注入可能な要約関数型）。
 *   要約関数を注入可能にすることで、単体テストではモック、実運用では裏方サブエージェント
 *   （Historian）を差し込める（§7.2「小分け要約」・§7.5「要約完成時の復帰・差し替え」）。
 * - formatTableOfContents: 完了済み要約群をモデルが把握しやすい章立て目次テキストに
 *   整形する（開始時刻順で決定的な出力）。
 * - reconcileBlockSummaries: 未要約ブロックを古い順に小分け（maxBatches）で要約生成・
 *   蓄積する。要約済みブロックは再計算せずキャッシュを維持（冪等性）。
 *
 * 設計メモ:
 * - ファイルI/O・セッション操作は一切行わない純粋関数。セッションファイル（.jsonl）の
 *   実ログは 100% 保持され、要約・目次はインメモリで管理する（§7.5 の可逆性の死守）。
 * - タイムスタンプ形式は compartment.ts と同じく epoch ミリ秒（number）と ISO 8601
 *   文字列の両方を許容する。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { toEpochMs, type HistoryBlock } from "./compartment.js";

/** 1ブロック（1章）分の要約メタデータ。 */
export type BlockSummary = {
  /** 対象ブロックID（compartment.ts の HistoryBlock.id と対応） */
  blockId: string;
  /** 章のタイトル（例: "〇〇の設計と検討"） */
  title: string;
  /** 要約本文 */
  summary: string;
  /** ブロック開始タイムスタンプ（元ブロックの startTime を引き継ぐ） */
  startTime: number | string;
  /** ブロック終了タイムスタンプ（元ブロックの endTime を引き継ぐ） */
  endTime: number | string;
  /** 元ブロックの推定トークン数（compartment.ts の tokenCount を引き継ぐ） */
  tokenCount: number;
  /** 要約生成タイムスタンプ（epoch ミリ秒） */
  summarizedAt: number;
};

/**
 * 要約関数の型。ブロックと、そのブロックが参照する実メッセージ列を受け取り
 * BlockSummary を返す。
 *
 * テスト（モック）と実行環境（裏方 Historian サブエージェント）の両方から注入可能にし、
 * モック・拡張が容易な設計にする（§7.2 の小分け要約バジェットは呼び出し側が
 * maxBatches で制御する）。
 */
export type SummarizeFn = (block: HistoryBlock, messages: AgentMessage[]) => Promise<BlockSummary>;

/** 章立て目次の先頭見出し。 */
export const TABLE_OF_CONTENTS_HEADER = "## 過去ログの章立て目次（要約アーカイブ）";

/** 目次末尾の可逆性注記（セッションファイルに原文が完全保持されていることを明示）。 */
export const TABLE_OF_CONTENTS_REVERSIBILITY_NOTE =
  "（原文ログはセッションファイルに完全保持: いつでも復元可能）";

/** タイムスタンプを表示用文字列へ（数値は ISO 8601、文字列はそのまま）。 */
function formatDisplayTime(timestamp: number | string): string {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  return typeof timestamp === "string" ? timestamp : String(timestamp);
}

/**
 * 目次を開始時刻順で決定的に整列するための比較関数。
 * 開始時刻が解釈できない要約は末尾（安定）に置く。同一時刻は blockId で決定的に順序付ける。
 */
function compareSummariesByStart(a: BlockSummary, b: BlockSummary): number {
  const aMs = toEpochMs(a.startTime);
  const bMs = toEpochMs(b.startTime);
  if (aMs !== null && bMs !== null) {
    if (aMs !== bMs) {
      return aMs < bMs ? -1 : 1;
    }
  } else if (aMs !== bMs) {
    return aMs === null ? 1 : -1;
  }
  return a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0;
}

/**
 * 完了したブロック要約群を章立て目次テキストに整形する。
 *
 * 出力は開始時刻順に整列され、モデルが「いつ・何について・どのくらいの規模で議論されたか」
 * を把握できる軽量な形にする（§7.5 の目次差し替えに使う）。入力配列は変更しない。
 */
export function formatTableOfContents(summaries: readonly BlockSummary[]): string {
  const lines: string[] = [TABLE_OF_CONTENTS_HEADER];
  if (summaries.length === 0) {
    lines.push("", "（要約済みの章はまだありません）");
    return lines.join("\n");
  }
  const ordered = [...summaries].sort(compareSummariesByStart);
  lines.push("");
  for (let i = 0; i < ordered.length; i++) {
    const summary = ordered[i];
    const tokenCount =
      typeof summary.tokenCount === "number" && Number.isFinite(summary.tokenCount)
        ? Math.max(0, Math.floor(summary.tokenCount))
        : 0;
    lines.push(`### 第${i + 1}章: ${summary.title}（${summary.blockId}）`);
    lines.push(
      `- 期間: ${formatDisplayTime(summary.startTime)} → ${formatDisplayTime(summary.endTime)}`,
    );
    lines.push(`- 規模: 約 ${tokenCount.toLocaleString("en-US")} トークン`);
    lines.push(`- 要約: ${summary.summary}`);
    lines.push("");
  }
  lines.push(TABLE_OF_CONTENTS_REVERSIBILITY_NOTE);
  return lines.join("\n");
}

/** reconcileBlockSummaries のパラメータ。 */
export type ReconcileBlockSummariesParams = {
  /** 要約対象候補のブロック一覧（通常は partitionHistoryBlocks の出力の「過去分」） */
  blocks: HistoryBlock[];
  /** ブロックが参照する実メッセージ列（ブロックの startIndex/endIndex でスライスする） */
  messages: AgentMessage[];
  /** 既に要約済みのブロック要約キャッシュ（冪等性の担保） */
  existingSummaries: Map<string, BlockSummary>;
  /** 要約生成関数（注入可能） */
  summarizeFn: SummarizeFn;
  /** 1回の呼び出しで要約するブロック数上限（古い順。省略時は全件） */
  maxBatches?: number;
};

/** maxBatches の解決（不正値・負数はそのままクランプ、NaN 等は上限なしとして扱う）。 */
function resolveBatchLimit(value: number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  return undefined;
}

/**
 * 未要約の過去ブロックを古い順に小分け（maxBatches）で要約し、キャッシュへ蓄積する。
 *
 * - 冪等性: existingSummaries に存在するブロックは再計算せずそのまま維持する。
 * - 小分け: maxBatches を指定すると1回の呼び出しで処理するブロック数を制限でき、
 *   呼び出し側（裏方 Historian のバックグラウンドループ）が逐次・段階的に要約を進められる
 *   （§7.2「小分け要約（段階的・順次の目次化）」）。
 * - 失敗時の自己回復: 1ブロックの要約が失敗しても他のブロックの要約は継続し、失敗した
 *   ブロックは未要約のまま残す（次回の reconcile で再試行される。キャッシュは壊さない）。
 * - ブロックは messages の startIndex..endIndex でスライスした実メッセージ列とともに
 *   summarizeFn へ渡される。返り値の blockId は呼び出し元のブロックIDに正規化される。
 */
export async function reconcileBlockSummaries(
  params: ReconcileBlockSummariesParams,
): Promise<Map<string, BlockSummary>> {
  const result = new Map(params.existingSummaries);
  const pending = params.blocks
    .filter((block) => !result.has(block.id))
    .sort((a, b) => a.startIndex - b.startIndex);
  const limit = resolveBatchLimit(params.maxBatches);

  for (const block of limit === undefined ? pending : pending.slice(0, limit)) {
    const slice = params.messages.slice(block.startIndex, block.endIndex + 1);
    try {
      const summary = await params.summarizeFn(block, slice);
      result.set(block.id, { ...summary, blockId: block.id });
    } catch {
      // このブロックの要約失敗はスキップし、未要約のまま保持する。
      // 次回の reconcile で再試行される（自己回復経路。既存キャッシュは無傷）。
    }
  }
  return result;
}

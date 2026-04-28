/**
 * DennouAibou独自の型定義
 *
 * 上流OpenClawの型定義（src/config/types.ts）とは独立して管理する。
 * DENNOU_RULES.md Rule 1 (Encapsulation) に従い、コア型を汚染しない。
 */

/** Closed/Active の両方で共有するツール出力Prune設定 */
export interface DennouToolsPruneConfig {
  /** この文字数以上のツール出力のみPrune対象 */
  minPrunableToolChars: number;
  /** セッション末尾から保護するツール出力エントリ数 */
  keepLastTools: number;
  /** Prune後のプレースホルダテキスト */
  placeholder: string;
  /** Dry-runモード。trueの場合、ログ出力のみで実際の削除は行わない */
  dryRun: boolean;
}

/** セッションファイルのツール出力自動Prune設定 */
export interface DennouSessionToolsPruneConfig extends DennouToolsPruneConfig {
  /** 機能のON/OFF */
  enabled: boolean;
}

/** アクティブセッションのIdle Prune設定 */
export interface DennouActiveSessionPruneConfig extends DennouToolsPruneConfig {
  /** 機能のON/OFF */
  enabled: boolean;
  /** Idle検知後、何分間沈黙が続いたらpruneするか */
  idleDelayMinutes: number;
}

/** Prune Protection設定 — ワークスペースファイル＆キーワード保護 */
export interface DennouPruneProtectionConfig {
  /** コンテンツにこのキーワードが含まれていればpruneしない（case-insensitive） */
  protectedContentKeywords: string[];
  /**
   * ランタイムで自動注入されるワークスペースパス。
   * 設定ファイルには書かず、idle-prune-watcher等の初期化時に自動解決して注入する。
   */
  resolvedWorkspacePaths: string[];
}

/** openclaw.json `dennou` セクションのルート型 */
export interface DennouConfig {
  /** Closed/Active共通のPrune設定。各モード側で必要なキーだけ上書きできる。 */
  toolsPrune: DennouToolsPruneConfig;
  sessionToolsPrune: DennouSessionToolsPruneConfig;
  activeSessionToolsPrune: DennouActiveSessionPruneConfig;
  pruneProtection: DennouPruneProtectionConfig;
}

/** Closed/Active共通のデフォルト設定 */
export const DENNOU_TOOLS_PRUNE_DEFAULTS: DennouToolsPruneConfig = {
  minPrunableToolChars: 1200,
  keepLastTools: 5,
  placeholder: "[tool output pruned by DennouAibou]",
  dryRun: true,
};

/** デフォルト設定値 */
export const DENNOU_CONFIG_DEFAULTS: DennouConfig = {
  toolsPrune: DENNOU_TOOLS_PRUNE_DEFAULTS,
  sessionToolsPrune: {
    ...DENNOU_TOOLS_PRUNE_DEFAULTS,
    enabled: false,
  },
  activeSessionToolsPrune: {
    ...DENNOU_TOOLS_PRUNE_DEFAULTS,
    enabled: true,
    idleDelayMinutes: 30,
    keepLastTools: 10,
    placeholder: "[tool output pruned by DennouAibou — idle prune]",
  },
  pruneProtection: {
    protectedContentKeywords: ["AGENTS.md", "SOUL.md", "DENNOU_RULES"],
    resolvedWorkspacePaths: [],
  },
};

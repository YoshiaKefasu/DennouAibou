/**
 * DennouAibou設定の読み込み
 *
 * `openclaw.json` の `dennou` 名前空間から設定を読み込み、デフォルト値とマージする。
 * 上流OpenClawの型を変更せず、`getRuntimeConfig()` の戻り値から型アサーションで取得する。
 *
 * DENNOU_RULES.md Rule 1 (Encapsulation) に従い、上流型は一切変更しない。
 *
 * キャッシュは不要: 呼び出し元（session-maintenance-hook, idle-prune-watcher）が
 * 都度 `getDennouConfig()` を呼ぶ設計。config-reloadによるhot-reloadが自動で効く。
 */
import { getRuntimeConfig } from "../config/config.js";
import {
  type DennouConfig,
  type DennouToolsPruneConfig,
  DENNOU_CONFIG_DEFAULTS,
} from "./types.js";

/** 型ガード: raw値が部分的なDennouConfigかどうかを判定 */
function isDennouConfigObject(raw: unknown): raw is Partial<DennouConfig> {
  return typeof raw === "object" && raw !== null;
}

function mergeToolsPruneConfig(
  override: Partial<DennouToolsPruneConfig> | undefined,
): DennouToolsPruneConfig {
  return {
    ...DENNOU_CONFIG_DEFAULTS.toolsPrune,
    ...(override ?? {}),
  };
}

/**
 * openclaw.json の `dennou` セクションを読み込んでDennouConfigを返す。
 *
 * セクションが存在しない、パースできない、またはエラーが発生した場合は
 * デフォルト値を返す（クラッシュしない）。
 *
 * キャッシュは行わないため、config-reload hot-reloadが自動で機能する。
 */
export function getDennouConfig(): DennouConfig {
  try {
    const cfg = getRuntimeConfig();
    const dennouRaw = (cfg as Record<string, unknown>)["dennou"];
    if (!isDennouConfigObject(dennouRaw)) {
      return DENNOU_CONFIG_DEFAULTS;
    }

    const toolsPruneOverride = dennouRaw.toolsPrune;
    const toolsPrune = mergeToolsPruneConfig(toolsPruneOverride);
    const sessionToolsPrune = {
      enabled: DENNOU_CONFIG_DEFAULTS.sessionToolsPrune.enabled,
      ...toolsPrune,
      ...(dennouRaw.sessionToolsPrune ?? {}),
    };
    const activeSessionToolsPrune = {
      ...DENNOU_CONFIG_DEFAULTS.toolsPrune,
      enabled: DENNOU_CONFIG_DEFAULTS.activeSessionToolsPrune.enabled,
      idleDelayMinutes: DENNOU_CONFIG_DEFAULTS.activeSessionToolsPrune.idleDelayMinutes,
      keepLastTools: DENNOU_CONFIG_DEFAULTS.activeSessionToolsPrune.keepLastTools,
      placeholder: DENNOU_CONFIG_DEFAULTS.activeSessionToolsPrune.placeholder,
      // Apply shared user settings after mode defaults so toolsPrune really works
      // as the common override. Mode-specific values still win below.
      ...(toolsPruneOverride ?? {}),
      ...(dennouRaw.activeSessionToolsPrune ?? {}),
    };

    return {
      toolsPrune,
      sessionToolsPrune,
      activeSessionToolsPrune,
      pruneProtection: {
        ...DENNOU_CONFIG_DEFAULTS.pruneProtection,
        ...(dennouRaw.pruneProtection ?? {}),
        // resolvedWorkspacePaths は設定ファイルに書かせない（ランタイム自動解決）
        resolvedWorkspacePaths: DENNOU_CONFIG_DEFAULTS.pruneProtection.resolvedWorkspacePaths,
      },
    };
  } catch {
    return DENNOU_CONFIG_DEFAULTS;
  }
}

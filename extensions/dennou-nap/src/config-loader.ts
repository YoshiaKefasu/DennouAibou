/**
 * 設定ローダー。
 *
 * - DennouAibou 環境: `dennou-aibou.json` の `plugins.entries.dennou-nap.config`
 * - 上記が無い / 読めない場合は既定値（Jev クラウド）にフォールバック。
 * - 環境変数 `NAP_SYSTEMONE_ENDPOINT` / `NAP_SYSTEMONE_MODEL` /
 *   `NAP_SYSTEMONE_API_KEY` はファイル設定より優先される。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SystemOneEndpointConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
}

export interface SystemOneConfig extends SystemOneEndpointConfig {
  /** プライマリ障害時に自動転送するフォールバック先（クラウド Jev 等）。 */
  fallback?: SystemOneEndpointConfig;
}

export interface DennouNapConfig {
  enabled: boolean;
  systemOne: SystemOneConfig;
  timeoutMs: number;
  concurrency: number;
  failureThreshold: number;
  cooldownMs: number;
  /** 「間」とみなす無音時間ms。既定5分。 */
  maGapMs: number;
  /** この確信度未満の判定は鵜呑みにしない判断材料。 */
  confidenceThreshold: number;
  /** context 使用率がこの割合を超えたら自動圧縮を発火。既定0.85。 */
  thresholdRatio: number;
  /** 圧縮後に落とす目標使用率。既定0.60。 */
  targetRatio: number;
  /**
   * 生データ維持ブロックのトークン上限比率（contextWindow連動）。既定0.25。
   * 例: 1M窓なら250,000トークンが維持上限。範囲0.05〜0.5。
   */
  maxKeptRatio: number;
  /**
   * 末尾からこの章数は仕分け・要約の対象外として100%生保持するガード。既定250。
   * note #146: 直近章保持ガード。
   */
  protectRecentChapters: number;
  /** Historian 要約に使うモデル名（将来の実LLM経路用。自動圧縮は再帰呼び出し回避のため決定論的要約を使う）。 */
  historianModel?: string;
  /** 設定をどこから読んだか。 */
  source: "dennou" | "env" | "default";
}

export const DEFAULT_SYSTEM_ONE_ENDPOINT = "https://api.experientiallabs.ai/v1/systemone";
export const DEFAULT_SYSTEM_ONE_MODEL = "jev-latest";

export const DEFAULT_CONFIG: DennouNapConfig = {
  enabled: true,
  systemOne: {
    endpoint: DEFAULT_SYSTEM_ONE_ENDPOINT,
    model: DEFAULT_SYSTEM_ONE_MODEL,
  },
  timeoutMs: 2000,
  concurrency: 8,
  failureThreshold: 3,
  cooldownMs: 60_000,
  maGapMs: 5 * 60_000,
  confidenceThreshold: 0.6,
  thresholdRatio: 0.85,
  targetRatio: 0.6,
  maxKeptRatio: 0.25,
  protectRecentChapters: 250,
  source: "default",
};

export interface LoadOptions {
  /** テスト・明示指定用。既定は cwd → ~/.openclaw → ~/.dennou-aibou の順に探索。 */
  dennouConfigPath?: string;
  /** テスト用 env 差し替え。既定は `process.env`。 */
  env?: Record<string, string | undefined>;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickString(section: Record<string, unknown>, key: string): string | undefined {
  const value = section[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pickNumber(section: Record<string, unknown>, key: string): number | undefined {
  const value = section[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickRatio(section: Record<string, unknown>, key: string): number | undefined {
  const value = section[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value <= 0 || value >= 1) return undefined;
  return value;
}

/** maxKeptRatio専用: 0.05〜0.5の範囲内のみ採用。範囲外は既定に倒す。 */
function pickKeptRatio(section: Record<string, unknown>, key: string): number | undefined {
  const value = section[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0.05 || value > 0.5) return undefined;
  return value;
}

/** protectRecentChapters専用: 非負整数のみ採用。 */
function pickChapterCount(section: Record<string, unknown>, key: string): number | undefined {
  const value = section[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return Math.floor(value);
}

function pickBoolean(section: Record<string, unknown>, key: string): boolean | undefined {
  const value = section[key];
  return typeof value === "boolean" ? value : undefined;
}

/** ファイル由来セクションを既定へマージ（systemOne は Jev/Laya 両対応）。 */
function applySection(base: DennouNapConfig, section: unknown): void {
  if (!isRecord(section)) return;
  const enabled = pickBoolean(section, "enabled");
  if (enabled !== undefined) base.enabled = enabled;
  const timeoutMs = pickNumber(section, "timeoutMs");
  if (timeoutMs !== undefined) base.timeoutMs = timeoutMs;
  const concurrency = pickNumber(section, "concurrency");
  if (concurrency !== undefined) base.concurrency = Math.max(1, Math.floor(concurrency));
  const failureThreshold = pickNumber(section, "failureThreshold");
  if (failureThreshold !== undefined) base.failureThreshold = failureThreshold;
  const cooldownMs = pickNumber(section, "cooldownMs");
  if (cooldownMs !== undefined) base.cooldownMs = cooldownMs;
  const maGapMs = pickNumber(section, "maGapMs");
  if (maGapMs !== undefined) base.maGapMs = maGapMs;
  const confidenceThreshold = pickNumber(section, "confidenceThreshold");
  if (confidenceThreshold !== undefined) base.confidenceThreshold = confidenceThreshold;
  const thresholdRatio = pickRatio(section, "thresholdRatio");
  if (thresholdRatio !== undefined) base.thresholdRatio = thresholdRatio;
  const targetRatio = pickRatio(section, "targetRatio");
  if (targetRatio !== undefined) base.targetRatio = targetRatio;
  const maxKeptRatio = pickKeptRatio(section, "maxKeptRatio");
  if (maxKeptRatio !== undefined) base.maxKeptRatio = maxKeptRatio;
  const protectRecentChapters = pickChapterCount(section, "protectRecentChapters");
  if (protectRecentChapters !== undefined) base.protectRecentChapters = protectRecentChapters;
  const historianModel = pickString(section, "historianModel");
  if (historianModel !== undefined) base.historianModel = historianModel;
  const rawHistorian = section["historian"];
  if (isRecord(rawHistorian)) {
    const nestedModel = pickString(rawHistorian, "model");
    if (nestedModel !== undefined) base.historianModel = nestedModel;
  }
  const rawSystemOne = section["systemOne"];
  if (isRecord(rawSystemOne)) {
    const endpoint = pickString(rawSystemOne, "endpoint");
    if (endpoint !== undefined) base.systemOne.endpoint = endpoint;
    const model = pickString(rawSystemOne, "model");
    if (model !== undefined) base.systemOne.model = model;
    const apiKey = pickString(rawSystemOne, "apiKey");
    if (apiKey !== undefined) base.systemOne.apiKey = apiKey;
    const rawFallback = rawSystemOne["fallback"];
    if (isRecord(rawFallback)) {
      const fbEndpoint = pickString(rawFallback, "endpoint");
      const fbModel = pickString(rawFallback, "model");
      const fbApiKey = pickString(rawFallback, "apiKey");
      if (fbEndpoint !== undefined || fbModel !== undefined || fbApiKey !== undefined) {
        const prev = base.systemOne.fallback;
        base.systemOne.fallback = {
          endpoint: fbEndpoint ?? prev?.endpoint ?? DEFAULT_SYSTEM_ONE_ENDPOINT,
          model: fbModel ?? prev?.model ?? DEFAULT_SYSTEM_ONE_MODEL,
        };
        const mergedApiKey = fbApiKey ?? prev?.apiKey;
        if (mergedApiKey !== undefined) base.systemOne.fallback.apiKey = mergedApiKey;
      }
    }
  }
}

function readDennouSection(doc: unknown): unknown {
  if (!isRecord(doc)) return undefined;
  const plugins = doc["plugins"];
  if (!isRecord(plugins)) return undefined;
  const entries = plugins["entries"];
  if (!isRecord(entries)) return undefined;
  const entry = entries["dennou-nap"];
  if (!isRecord(entry)) return undefined;
  return entry["config"];
}

/**
 * 設定をロードする。優先順位:
 * dennou-aibou.json > 既定値。
 * env 変数は見つかった設定に上書き適用される。
 */
export function loadDennouNapConfig(options: LoadOptions = {}): DennouNapConfig {
  const env = options.env ?? process.env;
  const cfg: DennouNapConfig = {
    ...DEFAULT_CONFIG,
    systemOne: { ...DEFAULT_CONFIG.systemOne },
  };

  const candidates = options.dennouConfigPath
    ? [options.dennouConfigPath]
    : [
        path.join(process.cwd(), "dennou-aibou.json"),
        path.join(os.homedir(), ".openclaw", "dennou-aibou.json"),
        path.join(os.homedir(), ".dennou-aibou", "dennou-aibou.json"),
      ];
  for (const dennouPath of candidates) {
    const dennouSection = readDennouSection(readJsonFile(dennouPath));
    if (dennouSection !== undefined) {
      applySection(cfg, dennouSection);
      cfg.source = "dennou";
      break;
    }
  }

  const envEndpoint = env["NAP_SYSTEMONE_ENDPOINT"];
  const envModel = env["NAP_SYSTEMONE_MODEL"];
  const envApiKey = env["NAP_SYSTEMONE_API_KEY"];
  if (envEndpoint) cfg.systemOne.endpoint = envEndpoint;
  if (envModel) cfg.systemOne.model = envModel;
  if (envApiKey) cfg.systemOne.apiKey = envApiKey;
  const envThreshold = env["NAP_THRESHOLD_RATIO"];
  const envTarget = env["NAP_TARGET_RATIO"];
  const envMaxKeptRatio = env["NAP_MAX_KEPT_RATIO"];
  const envProtectChapters = env["NAP_PROTECT_RECENT_CHAPTERS"];
  const envHistorianModel = env["NAP_HISTORIAN_MODEL"];
  let envRatioTouched = false;
  const applyEnvRatio = (raw: string | undefined, set: (v: number) => void): void => {
    if (!raw) return;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0 || v >= 1) return;
    set(v);
    envRatioTouched = true;
  };
  applyEnvRatio(envThreshold, (v) => {
    cfg.thresholdRatio = v;
  });
  applyEnvRatio(envTarget, (v) => {
    cfg.targetRatio = v;
  });
  // maxKeptRatioは0.05〜0.5の範囲内のみ採用（範囲外は既定のまま）。
  if (envMaxKeptRatio) {
    const v = Number(envMaxKeptRatio);
    if (Number.isFinite(v) && v >= 0.05 && v <= 0.5) {
      cfg.maxKeptRatio = v;
      envRatioTouched = true;
    }
  }
  // protectRecentChaptersは非負整数のみ採用。
  if (envProtectChapters) {
    const v = Number(envProtectChapters);
    if (Number.isFinite(v) && v >= 0) {
      cfg.protectRecentChapters = Math.floor(v);
      envRatioTouched = true;
    }
  }
  if (envHistorianModel) {
    cfg.historianModel = envHistorianModel;
    envRatioTouched = true;
  }
  const envFbEndpoint = env["NAP_SYSTEMONE_FALLBACK_ENDPOINT"];
  const envFbModel = env["NAP_SYSTEMONE_FALLBACK_MODEL"];
  const envFbApiKey = env["NAP_SYSTEMONE_FALLBACK_API_KEY"];
  if (envFbEndpoint || envFbModel || envFbApiKey) {
    const prev = cfg.systemOne.fallback;
    cfg.systemOne.fallback = {
      endpoint: envFbEndpoint || prev?.endpoint || DEFAULT_SYSTEM_ONE_ENDPOINT,
      model: envFbModel || prev?.model || DEFAULT_SYSTEM_ONE_MODEL,
    };
    const mergedApiKey = envFbApiKey || prev?.apiKey;
    if (mergedApiKey) cfg.systemOne.fallback.apiKey = mergedApiKey;
  }
  if (
    (envEndpoint ?? envModel ?? envApiKey) ||
    envFbEndpoint ||
    envFbModel ||
    envFbApiKey ||
    envRatioTouched
  ) {
    if (cfg.source === "default") cfg.source = "env";
  }
  return cfg;
}

/**
 * Gateway のインメモリ設定（`plugins.entries["dennou-nap"].config`）から設定を解決する。
 *
 * `loadDennouNapConfig` はファイル探索＋env 上書きを行うが、本体（Kasou）から配線される
 * 経路では Gateway が保持する `OpenClawConfig` が唯一の設定ソースであるため、ここでは
 * 既定値に対するセクション・マージのみを行う（I/O なし・決定論的）。
 * セクションが無い・不正なときは既定値をそのまま返す。
 */
export function resolveDennouNapConfigFromSection(section: unknown): DennouNapConfig {
  const cfg: DennouNapConfig = {
    ...DEFAULT_CONFIG,
    systemOne: { ...DEFAULT_CONFIG.systemOne },
  };
  if (isRecord(section)) {
    applySection(cfg, section);
    cfg.source = "dennou";
  }
  return cfg;
}

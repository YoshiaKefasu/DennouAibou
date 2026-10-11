/**
 * System 1 クライアント（Jev / Laya 共通）。
 *
 * - `POST {endpoint}` に `{ model, query: "choice", choices, input }` を送り、
 *   3択（維持・要約・落とす）の判定を受け取る。
 * - タイムアウト 2,000ms / concurrency cap 8。
 * - サーキットブレーカー: 401・429・5xx・通信/タイムアウト失敗を数え、
 *   連続3回で開放 → 60秒後に半開（次の1発を通し、成功で閉・失敗で再開放）。
 * - 自動フォールバック: `fallback` 設定時はプライマリ失敗（通信エラー・
 *   非OK応答・タイムアウト・回路OPEN等）で即フォールバック先へ転送し、
 *   成功すれば `fallbackEndpoint` 付きの判定を返す。両方失敗時のみ
 *   フェイルオープンする。
 * - フェイルオープン: 故障時も `{ choice: "維持", confidence: 0, fallback: true }`
 *   を返し、呼び出し側（プロンプト合成）を絶対に壊さない。
 */

import type { SystemOneEndpointConfig } from "./config-loader.js";

/** Laya へ送る1テキストの上限（超過時は head + 中略 + tail に切る）。約5,000トークン相当。 */
export const SYSTEM_ONE_MAX_CHARS = 15_000;
/** Truncate 時に残す先頭文字数。 */
export const SYSTEM_ONE_HEAD_CHARS = 1_000;
/** Truncate 時に残す末尾文字数。 */
export const SYSTEM_ONE_TAIL_CHARS = 2_000;
/** Truncate の中略マーカー。 */
export const TRUNCATION_MARKER = "\n... [中略: 巨大ログをカット] ...\n";

/**
 * 長大テキストを System 1 送信用に安全に切る。15,000文字以下はそのまま返す。
 * 先頭1,000文字（指示文脈）＋ 末尾2,000文字（直近の重要部分）を残す。
 */
export function truncateForSystemOne(text: string): string {
  if (text.length <= SYSTEM_ONE_MAX_CHARS) return text;
  return (
    text.slice(0, SYSTEM_ONE_HEAD_CHARS) +
    TRUNCATION_MARKER +
    text.slice(text.length - SYSTEM_ONE_TAIL_CHARS)
  );
}
import {
  isTriageChoice,
  type TriageChoice,
  type TriageProbabilities,
  type TriageResult,
} from "./types.js";

export interface SystemOneClientOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  /** プライマリ失敗時に自動転送するフォールバック先。未設定なら即フェイルオープン。 */
  fallback?: SystemOneEndpointConfig;
  timeoutMs?: number;
  concurrency?: number;
  failureThreshold?: number;
  cooldownMs?: number;
  /** テスト用 fetch 差し替え。既定はグローバル fetch。 */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
}

function isCountedFailure(status: number): boolean {
  return status === 401 || status === 429 || status >= 500;
}

function fallbackResult(reason: string): TriageResult {
  return {
    choice: "維持",
    confidence: 0,
    probabilities: { 維持: 1, 要約: 0, 落とす: 0 },
    reason,
    fallback: true,
  };
}

/** `confidence >= threshold` なら System 1 の判定をそのまま信じてよい。 */
export function isConfident(result: TriageResult, threshold = 0.6): boolean {
  return result.confidence >= threshold;
}

function clamp01(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeProbabilities(raw: unknown, choice: TriageChoice): TriageProbabilities {
  const base: TriageProbabilities = { 維持: 0, 要約: 0, 落とす: 0 };
  if (typeof raw !== "object" || raw === null) {
    base[choice] = 1;
    return base;
  }
  const record = raw as Record<string, unknown>;
  let sum = 0;
  for (const key of ["維持", "要約", "落とす"] as const) {
    base[key] = clamp01(record[key], 0);
    sum += base[key];
  }
  if (sum <= 0) {
    base[choice] = 1;
    return base;
  }
  // 正規化して合計1に揃える。
  for (const key of ["維持", "要約", "落とす"] as const) {
    base[key] = base[key] / sum;
  }
  return base;
}

function normalizeResponse(data: unknown): TriageResult | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;

  // 公式 /v1/systemone (Jev/Laya) 形式: { answers: { action: { choice, confidence, probabilities } } }
  let choice = record["choice"];
  let probabilitiesRaw = record["probabilities"];
  let confidenceRaw = record["confidence"];
  let reason = typeof record["reason"] === "string" ? record["reason"] : undefined;

  if (
    record["answers"] &&
    typeof record["answers"] === "object" &&
    !Array.isArray(record["answers"])
  ) {
    const answers = record["answers"] as Record<string, unknown>;
    const action = answers["action"];
    if (action && typeof action === "object" && !Array.isArray(action)) {
      const act = action as Record<string, unknown>;
      if (act["choice"]) choice = act["choice"];
      if (act["probabilities"]) probabilitiesRaw = act["probabilities"];
      if (act["confidence"] !== undefined) confidenceRaw = act["confidence"];
      if (typeof act["reason"] === "string") reason = act["reason"];
    }
  }

  if (!isTriageChoice(choice)) return undefined;
  const probabilities = normalizeProbabilities(probabilitiesRaw, choice);
  const confidence = clamp01(
    confidenceRaw,
    Math.max(probabilities["維持"], probabilities["要約"], probabilities["落とす"]),
  );
  return { choice, confidence, probabilities, reason };
}

function buildSystemOnePayload(model: string, text: string): string {
  return JSON.stringify({
    model,
    state: text,
    questions: {
      action: {
        type: "choice",
        instructions:
          "常時稼働エージェントのコンテキストの一部です。このブロックの扱いを判定してください",
        criteria: {
          維持: "今後大事な決断で正確に覚えるべき重要な決定や設定情報",
          要約: "細部は不要だが念のため流れとして残す情報",
          落とす: "不要なノイズでパフォーマンスを低下させる情報",
        },
      },
    },
  });
}

export class SystemOneClient {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly fallback?: SystemOneEndpointConfig;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly fetchFn: (url: string, init: RequestInit) => Promise<Response>;

  private failures = 0;
  private openedAt: number | undefined;
  private active = 0;
  private readonly queue: Array<() => void> = [];
  /** テスト用: 観測された最大同時実行数。 */
  maxObservedConcurrency = 0;

  constructor(options: SystemOneClientOptions) {
    this.endpoint = options.endpoint;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.fallback = options.fallback;
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 8));
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  }

  getState(): { failures: number; circuitOpen: boolean; active: number } {
    return {
      failures: this.failures,
      // Note: 読み取り専用。冷却時間経過によるリセットはしない（副作用分離）。
      circuitOpen: this.isCircuitOpen(),
      active: this.active,
    };
  }

  /** 副作用なしの純粋な開放判定。getState() 等の読み取り専用経路用。 */
  private isCircuitOpen(): boolean {
    if (this.openedAt === undefined) return false;
    return Date.now() - this.openedAt < this.cooldownMs;
  }

  /** 冷却期間が過ぎていれば半開へ（リセット）。リクエスト経路でのみ呼ぶ。 */
  private refreshCircuit(): void {
    if (this.openedAt !== undefined && Date.now() - this.openedAt >= this.cooldownMs) {
      this.openedAt = undefined;
      this.failures = 0;
    }
  }

  /** 開放中なら true。冷却期間が過ぎていれば半開へ（閉じて false）。 */
  private isOpen(): boolean {
    this.refreshCircuit();
    return this.isCircuitOpen();
  }

  private recordSuccess(): void {
    this.failures = 0;
    this.openedAt = undefined;
  }

  private recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openedAt = Date.now();
    }
  }

  async judge(text: string, options?: { signal?: AbortSignal }): Promise<TriageResult> {
    // 413防止: 長大なBashログ等は head＋中略＋tail に切ってから送る（短文は不変）。
    const safe = truncateForSystemOne(text);
    if (this.isOpen()) {
      return this.tryFallback(safe, options?.signal, fallbackResult("fail-open: circuit open"));
    }
    return this.withSlot(async () => {
      // キュー待ち中に他リクエストの失敗で回路が開いた場合は叩かずフォールバックへ。
      // バッチ全体が無駄に 401/429/5xx を叩き続けるのを防止する。
      if (this.isOpen()) {
        return this.tryFallback(safe, options?.signal, fallbackResult("fail-open: circuit open"));
      }
      const primary = await this.request(safe, options?.signal);
      // プライマリ成功はそのまま。fail-open 時のみフォールバックへ転送。
      if (!primary.fallback) return primary;
      return this.tryFallback(safe, options?.signal, primary);
    });
  }

  async judgeMany(texts: string[]): Promise<TriageResult[]> {
    return Promise.all(texts.map((text) => this.judge(text)));
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
    this.active += 1;
    if (this.active > this.maxObservedConcurrency) {
      this.maxObservedConcurrency = this.active;
    }
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /** タイムアウト付き・外部 signal 連動の AbortSignal を作る。使い終わったら dispose する。 */
  private createLinkedSignal(outerSignal?: AbortSignal): {
    signal: AbortSignal;
    dispose: () => void;
  } {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`systemone timeout after ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    if (outerSignal) {
      if (outerSignal.aborted) {
        controller.abort(outerSignal.reason);
      } else {
        outerSignal.addEventListener(
          "abort",
          () => {
            controller.abort(outerSignal.reason);
          },
          { once: true },
        );
      }
    }
    return { signal: controller.signal, dispose: () => clearTimeout(timer) };
  }

  /**
   * プライマリ失敗時のフォールバック転送。fallback 未設定なら primaryFail を返す。
   * Note: フォールバックの成否はプライマリのサーキットカウンタに触らない
   * （プライマリの故障状態を保持し、次の判定もフォールバックへ流すため）。
   */
  private async tryFallback(
    text: string,
    outerSignal: AbortSignal | undefined,
    primaryFail: TriageResult,
  ): Promise<TriageResult> {
    const fb = this.fallback;
    if (!fb) return primaryFail;
    const primaryReason = primaryFail.reason ?? "unknown";
    const { signal, dispose } = this.createLinkedSignal(outerSignal);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (fb.apiKey) headers["authorization"] = `Bearer ${fb.apiKey}`;
      const response = await this.fetchFn(fb.endpoint, {
        method: "POST",
        headers,
        body: buildSystemOnePayload(fb.model, text),
        signal,
      });
      if (!response.ok) {
        return fallbackResult(
          `fail-open: primary (${primaryReason}) + fallback http ${response.status}`,
        );
      }
      let data: unknown;
      try {
        data = (await response.json()) as unknown;
      } catch {
        return fallbackResult(`fail-open: primary (${primaryReason}) + fallback invalid json`);
      }
      const parsed = normalizeResponse(data);
      if (!parsed) {
        return fallbackResult(
          `fail-open: primary (${primaryReason}) + fallback bad response shape`,
        );
      }
      return { ...parsed, fallbackEndpoint: fb.endpoint };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return fallbackResult(`fail-open: primary (${primaryReason}) + fallback ${detail}`);
    } finally {
      dispose();
    }
  }

  private async request(text: string, outerSignal?: AbortSignal): Promise<TriageResult> {
    const { signal, dispose } = this.createLinkedSignal(outerSignal);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
      const response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers,
        body: buildSystemOnePayload(this.model, text),
        signal,
      });
      if (!response.ok) {
        if (isCountedFailure(response.status)) this.recordFailure();
        return fallbackResult(`fail-open: http ${response.status}`);
      }
      let data: unknown;
      try {
        data = (await response.json()) as unknown;
      } catch {
        this.recordFailure();
        return fallbackResult("fail-open: invalid json");
      }
      const parsed = normalizeResponse(data);
      if (!parsed) {
        this.recordFailure();
        return fallbackResult("fail-open: bad response shape");
      }
      this.recordSuccess();
      return parsed;
    } catch (error) {
      this.recordFailure();
      const detail = error instanceof Error ? error.message : String(error);
      return fallbackResult(`fail-open: ${detail}`);
    } finally {
      dispose();
    }
  }
}

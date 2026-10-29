/**
 * System 1 クライアント（Jev / Laya 共通）。
 *
 * - `POST {endpoint}` に `{ model, query: "choice", choices, input }` を送り、
 *   3択（維持・要約・落とす）の判定を受け取る。
 * - タイムアウト 10,000ms / concurrency cap 2（複数プロジェクト共有の Laya で
 *   キュー待ちが他セッションを潰さないための既定値）。
 * - 503/429 は「混雑」として即失敗にせず、Retry-After（または 300〜600ms の
 *   バックオフ）を待って最大 2 回リトライする。予算はタイムアウト内に収める。
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

/** Respan（scores API）の既定 URL。 */
export const RESPAN_SCORES_URL = "https://api.respan.ai/api/v1/scores";
/** Respan モデル ID の接頭辞。 */
export const RESPAN_MODEL_PREFIX = "span-";
/** Respan の `span.input` に載せる評価指示文。 */
export const RESPAN_EVAL_INSTRUCTION = "コンテキストの一部を評価してください";

/**
 * Respan の behaviors 定義（`drop` / `summarize` / `keep`）。
 * 内部の 3 択ラベルとの対応は `RESPAN_BEHAVIOR_CHOICES` で表す。
 */
export const RESPAN_BEHAVIORS: readonly { id: string; definition: string }[] = [
  {
    id: "drop",
    definition:
      "一時的なツール実行ログや中間データで、今後の会話や意思決定に不要なため落とせる情報",
  },
  {
    id: "summarize",
    definition: "細部は不要だが全体の作業の流れや文脈として要約して残すべき情報",
  },
  {
    id: "keep",
    definition: "今後大事な決断や設定情報として正確に記憶しておくべき重要な情報",
  },
];

/** Respan の behavior id → 内部の 3 択ラベル。 */
export const RESPAN_BEHAVIOR_CHOICES: Readonly<Record<string, TriageChoice>> = {
  drop: "落とす",
  summarize: "要約",
  keep: "維持",
};

/** エンドポイントが Respan（`api.respan.ai`）か。 */
export function isRespanEndpoint(endpoint: string): boolean {
  return typeof endpoint === "string" && endpoint.toLowerCase().includes("api.respan.ai");
}

/** モデル ID が Respan の `span-` 接頭辞か。 */
export function isRespanModel(model: string): boolean {
  return typeof model === "string" && model.trim().toLowerCase().startsWith(RESPAN_MODEL_PREFIX);
}

/** Respan の scores プロトコルで送るべきか（エンドポイントまたはモデルで判別）。 */
export function usesRespanProtocol(params: { endpoint: string; model: string }): boolean {
  return isRespanEndpoint(params.endpoint) || isRespanModel(params.model);
}

/**
 * Respan の送信 URL を決める。パスが空（ホストのみ）の場合は公式の
 * `/api/v1/scores` を補う。明示的なパスはそのまま尊重する。
 */
export function resolveRespanUrl(endpoint: string): string {
  const trimmed = endpoint.trim();
  const withoutTrailing = trimmed.replace(/\/+$/, "");
  try {
    const url = new URL(withoutTrailing);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = new URL(RESPAN_SCORES_URL).pathname;
      return url.toString();
    }
  } catch {
    return trimmed;
  }
  return withoutTrailing;
}

/** Respan の scores ペイロードを組み立てる。 */
export function buildRespanPayload(model: string, text: string): string {
  return JSON.stringify({
    model,
    span: {
      input: [{ role: "user", content: RESPAN_EVAL_INSTRUCTION }],
      output: { role: "assistant", content: text },
    },
    behaviors: RESPAN_BEHAVIORS.map((behavior) => ({
      id: behavior.id,
      definition: behavior.definition,
    })),
  });
}

function isCountedFailure(status: number): boolean {
  return status === 401 || status === 429 || status >= 500;
}

/**
 * 「混んでいて壊れていない」ステータス。GPU に到達する前に門前払いされたので
 * 判定は未知だが、サーバー自体は生きている。即フェイルオープンせずに
 * Retry-After / バックオフを待ってリトライする。
 * 503 = Laya の LAYA_MAX_CONCURRENT 受付拒否、429 = 共有割り当ての拒否。
 */
const RETRYABLE_STATUS = new Set([429, 503]);
/** 503/429 の最大リトライ回数。 */
export const SYSTEM_ONE_MAX_RETRIES = 2;
/** Retry-After が無い/使えない時のバックオフ下限。 */
export const SYSTEM_ONE_RETRY_BACKOFF_MIN_MS = 300;
/** Retry-After が無い/使えない時のバックオフ上限。 */
export const SYSTEM_ONE_RETRY_BACKOFF_MAX_MS = 600;

/** `ms` スリープ。abort された場合は false を返す。 */
function sleepOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry-After ヘッダ（delta-seconds または HTTP-date）を ms に変換する。 */
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (typeof header !== "string") return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/** リトライ `attempt`（0 起点）のバックオフ: 300ms → 600ms。 */
export function retryBackoffMs(attempt: number): number {
  const step = Math.max(0, Math.floor(attempt)) + 1;
  return Math.min(SYSTEM_ONE_RETRY_BACKOFF_MAX_MS, SYSTEM_ONE_RETRY_BACKOFF_MIN_MS * step);
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

/**
 * Respan（scores API）のレスポンスを `TriageResult` に変換する。
 *
 * `{ results: [{ id: "drop" | "summarize" | "keep", p_present, p_absent }] }` を
 * `{ 落とす | 要約 | 維持 }` の確率へ写像し、合計 1.0 に正規化する。
 * `confidence` は生の `p_present` の最大値。Respan 形式でなければ `undefined`。
 */
export function normalizeRespanResponse(data: unknown): TriageResult | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const results = record["results"];
  if (!Array.isArray(results)) return undefined;

  const present: Partial<Record<TriageChoice, number>> = {};
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row["id"] === "string" ? row["id"].trim().toLowerCase() : "";
    const choice = RESPAN_BEHAVIOR_CHOICES[id];
    if (!choice) continue;
    present[choice] = clamp01(row["p_present"], 0);
  }
  if (Object.keys(present).length === 0) return undefined;

  // 最大の p_present をそのまま確信度にする（正規化前の公式スコア）。
  const confidence = Math.max(...Object.values(present).map((value) => value ?? 0));
  // 全確率の合計が 1.0 になるよう正規化し、最大のものを choice にする。
  const probabilities = normalizeProbabilities(present, "維持");
  let choice: TriageChoice = "維持";
  for (const candidate of ["維持", "要約", "落とす"] as const) {
    if (probabilities[candidate] > probabilities[choice]) {
      choice = candidate;
    }
  }
  return { choice, confidence, probabilities };
}

function normalizeResponse(data: unknown): TriageResult | undefined {
  // Respan 形式は形状（results 配列）で判別して先に変換する。
  // エンドポイント判別が外れてもレスポンス側で正しく解釈できる。
  const respan = normalizeRespanResponse(data);
  if (respan) return respan;

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

/**
 * 送信先のプロトコルに応じたペイロードを組み立てる。
 * Respan（`api.respan.ai` / `span-*`）なら scores 形式、それ以外は従来の
 * `/v1/systemone` 形式（Jev / Laya）。
 */
export function buildRequestPayload(
  params: { endpoint: string; model: string },
  text: string,
): string {
  return usesRespanProtocol(params)
    ? buildRespanPayload(params.model, text)
    : buildSystemOnePayload(params.model, text);
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
    // 既定 10 秒: Laya は GPU 上で 1 件ずつ（約 80ms/件）処理するため、他プロジェクトの
    // バッチの後ろに並ぶと 2 秒では待ちきれずタイムアウトしていた。10 秒あれば
    // 相手のバッチが流れきるまでのキュー待ちを吸収できる。
    this.timeoutMs = options.timeoutMs ?? 10_000;
    // 既定 2: Laya の受付枠は全プロジェクトで共有で、処理は 1 件ずつ。1 セッションが
    // 8 並列で投げると他プロジェクトの前に割り込んでキュー待ちが膨らむため、
    // 複数プロジェクトが同時に動いても行儀よく順番に流れる値まで下げる。
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
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

  /** Respan のホストのみ指定（パスなし）を公式 scores エンドポイントに補正する。 */
  private resolveUrl(endpoint: string): string {
    return isRespanEndpoint(endpoint) ? resolveRespanUrl(endpoint) : endpoint;
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
      const response = await this.fetchFn(this.resolveUrl(fb.endpoint), {
        method: "POST",
        headers,
        body: buildRequestPayload({ endpoint: fb.endpoint, model: fb.model }, text),
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
    // `timeoutMs` はリトライを含めた 1 リクエスト全体の予算。混雑時の 503 は
    // ミリ秒で返るのでバックオフ分は常に収まるし、本当に詰まっている時は
    // 予定通り打ち切られる（リトライ × タイムアウト で伸びない）。
    const deadline = Date.now() + this.timeoutMs;
    try {
      for (let attempt = 0; ; attempt += 1) {
        const outcome = await this.attemptRequest(text, signal);
        if ("verdict" in outcome) return outcome.verdict;
        const remainingMs = deadline - Date.now();
        if (attempt >= SYSTEM_ONE_MAX_RETRIES || remainingMs <= 0 || signal.aborted) {
          // 混雑ではなく「もう予算が無い」ので、他の失敗と同じく breaker に数える。
          this.recordFailure();
          return fallbackResult(`fail-open: http ${outcome.status}`);
        }
        // `Retry-After: 0` は「今すぐリトライ」の正当な値。ヒントが無い時だけ
        // バックオフ段階を使う。
        const hintMs = parseRetryAfterMs(outcome.retryAfter);
        const waitMs = Math.max(0, Math.min(hintMs ?? retryBackoffMs(attempt), remainingMs));
        if (!(await sleepOrAbort(waitMs, signal))) {
          this.recordFailure();
          return fallbackResult(`fail-open: http ${outcome.status}`);
        }
      }
    } catch (error) {
      this.recordFailure();
      const detail = error instanceof Error ? error.message : String(error);
      return fallbackResult(`fail-open: ${detail}`);
    } finally {
      dispose();
    }
  }

  /** 1 回分の fetch + 解釈。`busy` はリトライ可能な 429/503。 */
  private async attemptRequest(
    text: string,
    signal: AbortSignal,
  ): Promise<{ verdict: TriageResult } | { status: number; retryAfter: string | null }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    const response = await this.fetchFn(this.resolveUrl(this.endpoint), {
      method: "POST",
      headers,
      body: buildRequestPayload({ endpoint: this.endpoint, model: this.model }, text),
      signal,
    });
    if (!response.ok) {
      if (RETRYABLE_STATUS.has(response.status)) {
        return { status: response.status, retryAfter: response.headers.get("retry-after") };
      }
      if (isCountedFailure(response.status)) this.recordFailure();
      return { verdict: fallbackResult(`fail-open: http ${response.status}`) };
    }
    let data: unknown;
    try {
      data = (await response.json()) as unknown;
    } catch {
      this.recordFailure();
      return { verdict: fallbackResult("fail-open: invalid json") };
    }
    const parsed = normalizeResponse(data);
    if (!parsed) {
      this.recordFailure();
      return { verdict: fallbackResult("fail-open: bad response shape") };
    }
    this.recordSuccess();
    return { verdict: parsed };
  }
}

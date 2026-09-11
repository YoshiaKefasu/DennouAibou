/**
 * Google Gemini Embedding 2 REST client for RAW_CHAT_SEARCH (design doc §2, §6).
 *
 * Direct `fetch` to Google AI Studio keeps the call path short (no proxy hop)
 * and the strict 400ms timeout keeps the recall path fail-open: a slow or
 * failing embedding API must never block a reply.
 */
import { blobToVector, EMBEDDING_DIMENSIONS, normalizeL2, vectorToBlob } from "./vector-math.js";

export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
export const GEMINI_EMBEDDING_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent";
export const GEMINI_EMBEDDING_TIMEOUT_MS = 400;

export type GeminiEmbeddingFailureCode =
  | "missing-api-key"
  | "timeout"
  | "http-error"
  | "invalid-response"
  /** Bad arguments (empty text, non-positive timeout/dimensions): a caller bug. */
  | "invalid-request";

export class GeminiEmbeddingError extends Error {
  readonly code: GeminiEmbeddingFailureCode;

  constructor(code: GeminiEmbeddingFailureCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GeminiEmbeddingError";
    this.code = code;
  }
}

type GeminiEmbedRequest = {
  model: string;
  content: { parts: Array<{ text: string }> };
  outputDimensionality: number;
};

type GeminiEmbedResponse = {
  embedding?: { values?: unknown };
};

export type GeminiEmbedOptions = {
  /** Explicit API key; falls back to `env.GEMINI_API_KEY`. */
  apiKey?: string;
  /** Environment used to resolve the fallback API key. */
  env?: NodeJS.ProcessEnv;
  /** Request timeout in milliseconds. Defaults to 400ms. */
  timeoutMs?: number;
  /** Expected vector length. Defaults to 1280. */
  dimensions?: number;
  /** Overrides the REST endpoint (tests / regional base URLs). */
  endpoint?: string;
  /** Injected fetch implementation for tests. */
  fetchImpl?: typeof fetch;
};

export function resolveGeminiApiKey(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const trimmedExplicit = explicit?.trim();
  if (trimmedExplicit) {
    return trimmedExplicit;
  }
  const fromEnv = env.GEMINI_API_KEY?.trim();
  return fromEnv ? fromEnv : undefined;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

/** Builds the `gemini-embedding-2:embedContent` request body. */
export function buildGeminiEmbedRequest(params: {
  text: string;
  dimensions?: number;
}): GeminiEmbedRequest {
  return {
    model: `models/${GEMINI_EMBEDDING_MODEL}`,
    content: { parts: [{ text: params.text }] },
    // Matryoshka truncation: ask the API for 1280 dimensions instead of 3072.
    outputDimensionality: params.dimensions ?? EMBEDDING_DIMENSIONS,
  };
}

/**
 * Embeds `text` with Gemini Embedding 2 and returns an L2-normalized
 * `Float32Array` of `dimensions` (default 1280) entries.
 *
 * Throws {@link GeminiEmbeddingError} on a missing key, timeout, HTTP error, or
 * malformed response. Use {@link embedTextWithGeminiOrNull} for fail-open call
 * sites.
 */
export async function embedTextWithGemini(
  text: string,
  options: GeminiEmbedOptions = {},
): Promise<Float32Array> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new GeminiEmbeddingError("invalid-response", "raw-chat-search: empty embedding input");
  }

  const apiKey = resolveGeminiApiKey(options.apiKey, options.env ?? process.env);
  if (!apiKey) {
    throw new GeminiEmbeddingError(
      "missing-api-key",
      "raw-chat-search: GEMINI_API_KEY is not configured",
    );
  }

  const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new GeminiEmbeddingError(
      "invalid-request",
      `raw-chat-search: invalid embedding dimensions (${dimensions})`,
    );
  }

  const timeoutMs = options.timeoutMs ?? GEMINI_EMBEDDING_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    // Validated up front so the RangeError from `AbortSignal.timeout` is never
    // misreported as a network failure further down.
    throw new GeminiEmbeddingError(
      "invalid-request",
      `raw-chat-search: invalid embedding timeout (${timeoutMs}ms)`,
    );
  }

  const endpoint = options.endpoint ?? GEMINI_EMBEDDING_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(buildGeminiEmbedRequest({ text: trimmed, dimensions })),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new GeminiEmbeddingError(
        "timeout",
        `raw-chat-search: Gemini embedding timed out after ${timeoutMs}ms`,
        error,
      );
    }
    throw new GeminiEmbeddingError(
      "http-error",
      `raw-chat-search: Gemini embedding request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GeminiEmbeddingError(
      "http-error",
      `raw-chat-search: Gemini embedding failed with ${response.status}${
        detail ? ` ${detail.slice(0, 300)}` : ""
      }`,
    );
  }

  let payload: GeminiEmbedResponse;
  try {
    payload = (await response.json()) as GeminiEmbedResponse;
  } catch (error) {
    throw new GeminiEmbeddingError(
      "invalid-response",
      "raw-chat-search: Gemini embedding response was not valid JSON",
      error,
    );
  }

  const values = payload.embedding?.values;
  if (!Array.isArray(values) || values.length !== dimensions) {
    throw new GeminiEmbeddingError(
      "invalid-response",
      `raw-chat-search: expected ${dimensions} embedding values, received ${
        Array.isArray(values) ? values.length : "none"
      }`,
    );
  }

  const embedding = Float32Array.from(values, (value) =>
    typeof value === "number" ? value : Number.NaN,
  );
  return normalizeL2(embedding);
}

/**
 * Failure codes that mean "the outside world failed", not "the caller is wrong".
 *
 * These are expected in normal operation (design doc §6: a slow or failing
 * embedding API must never block a reply; §3: no key means FTS5-only), so the
 * fail-open wrapper swallows them without noise.
 */
const EXPECTED_EXTERNAL_FAILURE_CODES = new Set<GeminiEmbeddingFailureCode>([
  "missing-api-key",
  "timeout",
  "http-error",
]);

/**
 * Fail-open variant of {@link embedTextWithGemini}: returns `null` instead of
 * throwing so recall can be skipped silently (design doc §6).
 *
 * Expected external failures (timeout, HTTP/network error, missing API key) are
 * swallowed silently. Anything else is a caller bug or a broken contract — a
 * `TypeError` from bad arguments, an invalid timeout, or a response whose vector
 * length no longer matches the request — so it is logged and still returns
 * `null`: the reply path must never break, but the problem has to stay
 * detectable. (A network outage also surfaces as `TypeError` from `fetch`, which
 * is why the classification keys off `GeminiEmbeddingError.code` rather than the
 * error type alone.)
 */
export async function embedTextWithGeminiOrNull(
  text: string,
  options: GeminiEmbedOptions = {},
): Promise<Float32Array | null> {
  if (typeof text !== "string" || !text.trim()) {
    warnEmbeddingAnomaly("refusing to embed empty or non-string input", typeof text);
    return null;
  }

  try {
    return await embedTextWithGemini(text, options);
  } catch (error) {
    if (error instanceof GeminiEmbeddingError && EXPECTED_EXTERNAL_FAILURE_CODES.has(error.code)) {
      return null;
    }
    warnEmbeddingAnomaly(
      "embedding call failed unexpectedly",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/** Logs a non-expected embedding failure so it is visible in gateway logs. */
function warnEmbeddingAnomaly(reason: string, detail: unknown): void {
  console.warn(`raw-chat-search: ${reason}`, detail);
}

/** Converts a normalized embedding to the BLOB representation stored in SQLite. */
export function embeddingToBlob(embedding: Float32Array): Buffer {
  return vectorToBlob(embedding);
}

/** Converts a stored BLOB back into an embedding vector. */
export function blobToEmbedding(blob: Buffer | Uint8Array, dim?: number): Float32Array {
  return blobToVector(blob, dim);
}

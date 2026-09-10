/**
 * Round-trip pair embedding (RAW_CHAT_SEARCH §4, §7 Phase 2).
 *
 * Two entry points share one definition of "a pair that still needs a vector":
 *
 * - {@link embedPendingPairs} — one bounded sweep, used by the background indexer
 *   hook after FTS5 indexing completes (newest turns first).
 * - {@link backfillEmbeddings} — the bulk initial index for existing history,
 *   walking base ids ascending with a cursor so it always terminates, even when
 *   turns are dropped as noise or the embedding API is failing.
 *
 * Both are fully asynchronous and fail-open: a timeout, HTTP error, or missing
 * API key never throws into the chat loop, and one bad pair never stops the rest
 * (§6). Nothing here is awaited by a caller on the reply path.
 */
import { getRawChatDatabase, type RawChatDatabase } from "./database.js";
import {
  embedTextWithGeminiOrNull,
  resolveGeminiApiKey,
  type GeminiEmbedOptions,
} from "./embedding-client.js";
import { extractConversationPairs, type ExtractedPair } from "./pair-extractor.js";
import { EMBEDDING_DIMENSIONS } from "./vector-math.js";

/** Pairs embedded by one background sweep (kept small so a sweep stays cheap). */
export const DEFAULT_EMBED_BATCH_LIMIT = 20;

/** In-flight Gemini requests during a background sweep. */
export const DEFAULT_EMBED_CONCURRENCY = 2;

/** Spacing between sweep chunks; a soft throttle, not a hard rate limiter. */
export const DEFAULT_EMBED_DELAY_MS = 150;

/** Pairs examined per bulk batch. */
export const DEFAULT_BACKFILL_BATCH_LIMIT = 50;

/**
 * In-flight Gemini requests during bulk backfill.
 *
 * Google does not publish a single fixed embedding quota (it varies per project
 * and tier), so the defaults stay deliberately conservative: 3 in flight with a
 * 200ms gap tops out around 5 requests/second, and both knobs are caller-tunable.
 */
export const DEFAULT_BACKFILL_CONCURRENCY = 3;

/** Spacing between bulk backfill chunks. */
export const DEFAULT_BACKFILL_DELAY_MS = 200;

/** Safety valve so a single bulk call can never run unbounded. */
export const DEFAULT_BACKFILL_MAX_BATCHES = 200;

export type EmbedPendingOptions = {
  /** Target database; defaults to the agent's cached `raw-chat.sqlite`. */
  db?: RawChatDatabase;
  /** Agent whose database to open when `db` is omitted. */
  agentId?: string;
  /** Environment used for `GEMINI_API_KEY` and the state dir. */
  env?: NodeJS.ProcessEnv;
  /** Explicit API key; falls back to `GEMINI_API_KEY`. */
  apiKey?: string;
  /** Max pairs considered in this sweep. */
  limit?: number;
  /** Traversal order: `"desc"` (newest first, default) or `"asc"` for backfill. */
  order?: "asc" | "desc";
  /** Cursor: only base ids greater than this (`"asc"`). */
  afterId?: number;
  /** Cursor: only base ids lower than this (`"desc"`). */
  beforeId?: number;
  /** Max simultaneous Gemini requests. */
  concurrency?: number;
  /** Milliseconds between chunks. */
  delayMs?: number;
  /** Expected embedding dimensions (defaults to 1280). */
  dimensions?: number;
  /** Per-request timeout in milliseconds (defaults to the client's 400ms). */
  timeoutMs?: number;
  /** Injected fetch implementation for tests. */
  fetchImpl?: typeof fetch;
  /** Aborting stops the sweep between chunks; in-flight request timeouts still bound latency. */
  signal?: AbortSignal;
  /** Injected sleep for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
};

export type EmbedPendingResult = {
  /** False when no `GEMINI_API_KEY` is configured, so vector work was skipped (§3). */
  hasApiKey: boolean;
  /** Pair bases examined in this sweep (after the cursor). */
  scanned: number;
  /** Rows written to `chat_embeddings`. */
  embedded: number;
  /** Pairs whose embedding request failed or returned nothing. */
  failed: number;
  /** Pairs dropped as noise (bare greetings, or a turn the extractor excludes). */
  noise: number;
  aborted: boolean;
  /**
   * Resume cursor for the next sweep: the last base id examined, or the incoming
   * cursor when nothing was examined. Pass it back as `afterId` for `"asc"` walks
   * and as `beforeId` for `"desc"` walks.
   *
   * Descending sweeps always advance past noise, so a session full of greetings
   * cannot pin the candidate window forever (noise pairs never get a row and would
   * otherwise be re-selected indefinitely).
   */
  cursorId: number;
};

export type BackfillEmbeddingsOptions = EmbedPendingOptions & {
  /** Pairs embedded per batch. */
  batchLimit?: number;
  /** Upper bound on batches for one call. */
  maxBatches?: number;
};

export type BackfillEmbeddingsResult = Omit<EmbedPendingResult, "cursorId"> & {
  batches: number;
  /** True when the ascending walk reached the end of the pending candidates. */
  drained: boolean;
  cursorId: number;
};

function emptyResult(hasApiKey: boolean, cursorId: number): EmbedPendingResult {
  return {
    hasApiKey,
    scanned: 0,
    embedded: 0,
    failed: 0,
    noise: 0,
    aborted: false,
    cursorId,
  };
}

/**
 * Sleep that never keeps the process alive on its own.
 *
 * Background work (sweeps, backoff waits, rate-limit spacing) must not pin the
 * event loop, so the timer is always `unref`ed.
 */
export function sleepWithUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  });
}

function toPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function toNonNegativeInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

/** Unexpected (non-API) failures are logged so they stay detectable (§7 Phase 2 review). */
function warnUnexpected(message: string, error: unknown): void {
  console.warn(`raw-chat-search: ${message}`, error instanceof Error ? error.message : error);
}

type BaseOutcome = "embedded" | "failed" | "noise";

/**
 * Resolves one pending base id into a pair.
 *
 * The window is `baseId .. first assistant reply after it`, filtered to
 * user/assistant rows by the extractor; tool results never become a pair.
 */
function resolvePairForBase(
  db: RawChatDatabase,
  base: { baseId: number; sessionId: string; closingAssistantId: number },
): ExtractedPair | null {
  const rows = db.selectPairWindow({
    sessionId: base.sessionId,
    fromId: base.baseId,
    toId: base.closingAssistantId,
  });
  return extractConversationPairs(rows).find((pair) => pair.baseId === base.baseId) ?? null;
}

async function processPendingBase(params: {
  db: RawChatDatabase;
  base: { baseId: number; sessionId: string; closingAssistantId: number };
  embedOptions: GeminiEmbedOptions;
}): Promise<BaseOutcome> {
  const { db, base, embedOptions } = params;

  let pair: ExtractedPair | null;
  try {
    pair = resolvePairForBase(db, base);
  } catch (error) {
    warnUnexpected(`failed to read pair window for message ${base.baseId}`, error);
    return "failed";
  }
  if (!pair) {
    // Bare greeting exchange, or a turn the extractor excludes by design.
    return "noise";
  }

  const vector = await embedTextWithGeminiOrNull(pair.textSnippet, embedOptions);
  if (!vector) {
    // Expected external failure (timeout / HTTP / quota): leave the pair pending
    // so the next sweep retries it.
    return "failed";
  }

  try {
    db.insertEmbedding({
      messageId: pair.baseId,
      sessionId: pair.sessionId,
      dimensions: vector.length,
      embedding: vector,
      textSnippet: pair.textSnippet,
    });
  } catch (error) {
    warnUnexpected(`failed to store embedding for message ${pair.baseId}`, error);
    return "failed";
  }

  return "embedded";
}

/**
 * Embeds up to `limit` pending round-trip pairs, skipping any pair that already
 * has a `chat_embeddings` row for its base message id.
 *
 * Returns immediately with `hasApiKey: false` when no key is configured, so an
 * FTS5-only deployment never opens the database or touches the network (§3).
 */
export async function embedPendingPairs(
  options: EmbedPendingOptions = {},
): Promise<EmbedPendingResult> {
  const env = options.env ?? process.env;
  const apiKey = resolveGeminiApiKey(options.apiKey, env);
  const order = options.order === "asc" ? "asc" : "desc";
  const afterId = toNonNegativeInt(options.afterId, 0);
  const beforeId = toNonNegativeInt(options.beforeId, Number.MAX_SAFE_INTEGER);
  if (!apiKey) {
    return emptyResult(false, order === "asc" ? afterId : beforeId);
  }

  const db = options.db ?? getRawChatDatabase(options.agentId, env);
  const limit = toPositiveInt(options.limit, DEFAULT_EMBED_BATCH_LIMIT);
  const concurrency = toPositiveInt(options.concurrency, DEFAULT_EMBED_CONCURRENCY);
  const delayMs = toNonNegativeInt(options.delayMs, DEFAULT_EMBED_DELAY_MS);
  const sleep = options.sleepImpl ?? sleepWithUnref;

  const bases = db.selectPendingPairBases({ limit, order, afterId, beforeId });
  const result = emptyResult(true, order === "asc" ? afterId : beforeId);
  if (bases.length === 0) {
    return result;
  }

  const embedOptions: GeminiEmbedOptions = {
    apiKey,
    dimensions: options.dimensions ?? EMBEDDING_DIMENSIONS,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  };

  for (let offset = 0; offset < bases.length; offset += concurrency) {
    if (options.signal?.aborted) {
      result.aborted = true;
      break;
    }

    const chunk = bases.slice(offset, offset + concurrency);
    const outcomes = await Promise.all(
      chunk.map((base) => processPendingBase({ db, base, embedOptions })),
    );

    for (const outcome of outcomes) {
      result.scanned += 1;
      if (outcome === "embedded") {
        result.embedded += 1;
      } else if (outcome === "failed") {
        result.failed += 1;
      } else {
        result.noise += 1;
      }
    }

    // Chunks walk in `order`, so the last base of the chunk is also the furthest
    // cursor position reached: the highest id for "asc", the lowest for "desc".
    const lastInChunk = chunk[chunk.length - 1];
    if (lastInChunk) {
      result.cursorId = lastInChunk.baseId;
    }

    if (offset + concurrency < bases.length) {
      await sleep(delayMs);
    }
  }

  return result;
}

/**
 * Bulk-vectorizes existing history (§7 Phase 2 backfill).
 *
 * Walks ascending from `afterId` in batches and stops as soon as a batch finds
 * nothing left, so the call always terminates — failures and noise still advance
 * the cursor and are simply retried by the *next* call instead of blocking the
 * rest of this one.
 *
 * Pacing defaults to {@link DEFAULT_BACKFILL_CONCURRENCY} in flight with a
 * {@link DEFAULT_BACKFILL_DELAY_MS} gap, which is more conservative than the
 * interactive sweep: this walk runs over the whole history in the background and
 * shares one API quota with the real-time recall path (§4).
 *
 * Re-running is safe and idempotent: a pair that already has an embedding is
 * never selected again, so a second pass over fully embedded history reports
 * `embedded: 0`.
 */
export async function backfillEmbeddings(
  options: BackfillEmbeddingsOptions = {},
): Promise<BackfillEmbeddingsResult> {
  const batchLimit = toPositiveInt(options.batchLimit, DEFAULT_BACKFILL_BATCH_LIMIT);
  const maxBatches = toPositiveInt(options.maxBatches, DEFAULT_BACKFILL_MAX_BATCHES);
  const startCursor = toNonNegativeInt(options.afterId, 0);

  if (!resolveGeminiApiKey(options.apiKey, options.env ?? process.env)) {
    // Checked before any database access: without a key there is no vector work
    // to do, so the backfill must not create or open `raw-chat.sqlite` (§3).
    return { ...emptyResult(false, startCursor), batches: 0, drained: true };
  }

  let cursorId = startCursor;
  const totals = { scanned: 0, embedded: 0, failed: 0, noise: 0 };
  let batches = 0;
  let aborted = false;

  for (let batch = 0; batch < maxBatches; batch++) {
    const sweep = await embedPendingPairs({
      // Explicit options win over the bulk defaults, but `limit`/`order`/cursors
      // are controlled by this walk and applied last.
      ...options,
      concurrency: options.concurrency ?? DEFAULT_BACKFILL_CONCURRENCY,
      delayMs: options.delayMs ?? DEFAULT_BACKFILL_DELAY_MS,
      limit: batchLimit,
      order: "asc",
      afterId: cursorId,
      beforeId: undefined,
    });
    batches += 1;
    totals.scanned += sweep.scanned;
    totals.embedded += sweep.embedded;
    totals.failed += sweep.failed;
    totals.noise += sweep.noise;
    cursorId = Math.max(cursorId, sweep.cursorId);

    if (sweep.aborted) {
      aborted = true;
      break;
    }
    if (sweep.scanned === 0) {
      break;
    }
  }

  return {
    hasApiKey: true,
    batches,
    scanned: totals.scanned,
    embedded: totals.embedded,
    failed: totals.failed,
    noise: totals.noise,
    aborted,
    drained: !aborted && batches < maxBatches,
    cursorId,
  };
}

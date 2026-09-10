import type { OpenClawConfig } from "../../../src/config/config.js";
import { DEFAULT_AGENT_ID } from "../../../src/routing/session-key.js";
import { onSessionTranscriptUpdate } from "../../../src/sessions/transcript-events.js";
import {
  backfillEmbeddings,
  embedPendingPairs,
  sleepWithUnref,
  type BackfillEmbeddingsOptions,
  type EmbedPendingOptions,
} from "./backfill.js";
import { getRawChatDatabase } from "./database.js";
import { resolveGeminiApiKey } from "./embedding-client.js";
import { indexSessionFile } from "./indexer.js";

const DEBOUNCE_MS = 2_000;

/** Pairs embedded per post-index sweep (RAW_CHAT_SEARCH §7 Phase 2). */
const SWEEP_LIMIT = 20;

/** Delay before the next sweep while candidates remain (more work is waiting). */
const SWEEP_CONTINUE_MS = 250;

/**
 * Delay before retrying after a failed embedding request. Doubles per consecutive
 * failing sweep up to {@link SWEEP_RETRY_MAX_MS} and resets on the first success,
 * so a quota exhaustion backs off instead of hammering the API (§6).
 */
const SWEEP_RETRY_BASE_MS = 15_000;
const SWEEP_RETRY_MAX_MS = 300_000;
const pendingIndexing = new Map<string, ReturnType<typeof setTimeout>>();

let started = false;
let unsubscribe: (() => void) | null = null;
let indexingEnabled = true;

/**
 * Per-agent sweep state: at most one in-flight sweep, plus a coalescing flag so a
 * burst of transcript updates collapses into a single follow-up sweep.
 */
type SweepState = {
  running: boolean;
  queued: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Descending cursor so already-examined pairs are not re-scanned forever. */
  cursorId: number | null;
  retryDelayMs: number;
};

const sweepStates = new Map<string, SweepState>();
let sweepOptions: EmbedPendingOptions = {};
let sweepEnabled = false;
let backfillController: AbortController | null = null;

export function resolveSessionAgentIdFromKey(sessionKey?: string): string {
  if (!sessionKey) {
    return DEFAULT_AGENT_ID;
  }
  const parts = sessionKey.split(":");
  if (parts.length >= 2 && parts[0] === "agent" && parts[1]) {
    return parts[1];
  }
  return DEFAULT_AGENT_ID;
}

export function isRawChatIndexingEnabled(config?: OpenClawConfig): boolean {
  const rawChat = (
    config as
      | {
          dennou?: {
            rawChat?: {
              indexing?: {
                enabled?: boolean;
              };
            };
          };
        }
      | undefined
  )?.dennou?.rawChat;

  return rawChat?.indexing?.enabled !== false;
}

function getSweepState(agentId: string): SweepState {
  let state = sweepStates.get(agentId);
  if (!state) {
    state = {
      running: false,
      queued: false,
      timer: null,
      cursorId: null,
      retryDelayMs: SWEEP_RETRY_BASE_MS,
    };
    sweepStates.set(agentId, state);
  }
  return state;
}

/** Arms `delayMs`, never letting the timer hold the process open. */
function armTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
  return timer;
}

/**
 * Runs one bounded embedding sweep for `agentId` and schedules the next one.
 *
 * Never throws: it runs off the transcript hook, where a rejection would be an
 * unhandled one, and the whole point is that vector work cannot affect chat (§6).
 *
 * The walk goes newest-to-oldest with a descending cursor, so fresh turns are
 * vectorized first and older pending pairs follow on subsequent sweeps. Noise
 * pairs always advance the cursor (they never get a row), and a drained walk
 * resets the cursor to pick up newly indexed turns again.
 */
async function runSweep(agentId: string): Promise<void> {
  const state = getSweepState(agentId);
  if (state.running) {
    state.queued = true;
    return;
  }

  state.running = true;
  try {
    // Hook-controlled fields (`limit`, `order`, `beforeId`) are applied last so an
    // injected option bag can never desync the descending cursor walk.
    const result = await embedPendingPairs({
      ...sweepOptions,
      agentId,
      limit: SWEEP_LIMIT,
      order: "desc",
      ...(state.cursorId !== null ? { beforeId: state.cursorId } : {}),
    });

    if (!result.hasApiKey) {
      // FTS5-only deployment (§3): nothing to embed and nothing to retry.
      return;
    }

    if (result.scanned === 0) {
      // Walked back past everything pending: restart from the newest pair.
      state.cursorId = null;
      state.retryDelayMs = SWEEP_RETRY_BASE_MS;
      return;
    }

    // Step strictly past the last examined base so a noise pair cannot be
    // re-selected on every sweep and pin the window forever.
    state.cursorId = Math.max(1, result.cursorId);

    if (result.failed > 0) {
      // Back off on embedding failures (timeout / quota) instead of hammering.
      scheduleSweep(agentId, state.retryDelayMs);
      state.retryDelayMs = Math.min(state.retryDelayMs * 2, SWEEP_RETRY_MAX_MS);
      return;
    }

    state.retryDelayMs = SWEEP_RETRY_BASE_MS;
    if (result.scanned >= SWEEP_LIMIT) {
      // More candidates are likely waiting; keep draining without waiting for a
      // new transcript update.
      scheduleSweep(agentId, SWEEP_CONTINUE_MS);
    }
  } catch (error) {
    // Unexpected: the sweep is written to contain expected failures.
    console.warn(
      "raw-chat-search: background embedding sweep failed",
      error instanceof Error ? error.message : error,
    );
    scheduleSweep(agentId, state.retryDelayMs);
  } finally {
    state.running = false;
    if (state.queued) {
      state.queued = false;
      void runSweep(agentId);
    }
  }
}

/** Arms one delayed sweep, replacing any timer already pending for this agent. */
function scheduleSweep(agentId: string, delayMs: number): void {
  const state = getSweepState(agentId);
  if (!sweepEnabled) {
    return;
  }
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = armTimer(() => {
    state.timer = null;
    if (!sweepEnabled) {
      return;
    }
    void runSweep(agentId);
  }, delayMs);
}

/**
 * Requests a background embedding sweep for `agentId` without awaiting it.
 *
 * Safe to call from any hook: it is a no-op without an API key or after
 * {@link stopRawChatIndexer}. Never blocks or throws into the caller.
 */
export function scheduleEmbeddingSweep(agentId: string): void {
  if (!sweepEnabled) {
    return;
  }
  void runSweep(agentId);
}

/**
 * Wait before re-checking `chat_messages` when the backfill starts before the
 * FTS5 indexer has populated the ledger.
 *
 * The gateway kicks off `backfillSessionFiles` and this plugin's service around
 * the same time, so the first vector pass can legitimately see an empty table.
 * Re-checking inside the extension keeps the ordering fix in the owning package
 * instead of teaching core about this plugin's two-phase startup.
 */
const BACKFILL_COLD_START_DELAY_MS = 5_000;
const BACKFILL_COLD_START_MAX_WAITS = 12;

/**
 * Starts the one-shot bulk backfill for existing history (§7 Phase 2) in the
 * background.
 *
 * Fire-and-forget by contract: returns immediately and never rejects, so gateway
 * startup and chat delivery are never blocked or failed by embedding work.
 * Re-running is harmless — already embedded pairs are skipped, so this stays
 * idempotent even if the transcript hook sweeps the same pairs concurrently.
 *
 * Note: when `chat_messages` is still empty the pass waits and retries (up to
 * {@link BACKFILL_COLD_START_MAX_WAITS}) so a cold start that races the FTS5
 * backfill still vectorizes history once the ledger is populated.
 */
export function startEmbeddingBackfill(options: BackfillEmbeddingsOptions = {}): void {
  if (!sweepEnabled || backfillController) {
    return;
  }

  const controller = new AbortController();
  backfillController = controller;
  const sleep = options.sleepImpl ?? sleepWithUnref;

  void (async () => {
    try {
      for (let attempt = 0; attempt < BACKFILL_COLD_START_MAX_WAITS; attempt++) {
        const db = options.db ?? getRawChatDatabase(options.agentId, options.env);
        const messageCount = db.countChatMessages();
        if (messageCount > 0 || controller.signal.aborted) {
          break;
        }
        await sleep(BACKFILL_COLD_START_DELAY_MS);
        if (controller.signal.aborted) {
          return;
        }
      }

      const result = await backfillEmbeddings({ signal: controller.signal, ...options });
      if (result.failed > 0) {
        // Leave the retry loop armed: the next sweep/backfill picks up the pairs
        // that the API refused, instead of silently reporting success.
        console.warn(
          `raw-chat-search: embedding backfill left ${result.failed} pair(s) pending (will retry)`,
        );
      }
    } catch (error) {
      console.warn(
        "raw-chat-search: embedding backfill failed",
        error instanceof Error ? error.message : error,
      );
    } finally {
      if (backfillController === controller) {
        backfillController = null;
      }
    }
  })();
}

export type RawChatIndexerOptions = {
  /**
   * Embedding sweep overrides (tests inject `fetchImpl` here). Merged over the
   * sweep defaults; a later `start` call replaces them.
   */
  embedOptions?: EmbedPendingOptions;
  /** Skip the automatic bulk backfill (tests that drive it explicitly). */
  skipBackfill?: boolean;
  /** Backfill overrides (batch size, concurrency, injected fetch, ...). */
  backfillOptions?: BackfillEmbeddingsOptions;
};

export function startRawChatIndexer(
  config?: OpenClawConfig,
  options: RawChatIndexerOptions = {},
): () => void {
  if (started) {
    return () => {
      // Already started; no-op cleanup
    };
  }
  started = true;
  indexingEnabled = isRawChatIndexingEnabled(config);
  sweepOptions = options.embedOptions ?? {};
  // Vector work needs an API key; without one the indexer stays FTS5-only (§3).
  sweepEnabled = indexingEnabled && Boolean(resolveGeminiApiKey(options.embedOptions?.apiKey));

  unsubscribe = onSessionTranscriptUpdate((update) => {
    if (!indexingEnabled) {
      return;
    }

    const sessionFile = update.sessionFile;
    if (!sessionFile) {
      return;
    }

    const existing = pendingIndexing.get(sessionFile);
    if (existing) {
      clearTimeout(existing);
    }

    pendingIndexing.set(
      sessionFile,
      armTimer(() => {
        pendingIndexing.delete(sessionFile);
        const agentId = resolveSessionAgentIdFromKey(update.sessionKey);
        try {
          indexSessionFile({
            sessionFile,
            agentId,
            sessionKey: update.sessionKey,
          });
        } catch {
          // Best-effort: indexing failure never affects chat delivery
        }
        // Fire-and-forget: the embedding sweep never blocks transcript handling.
        scheduleEmbeddingSweep(agentId);
      }, DEBOUNCE_MS),
    );
  });

  if (!options.skipBackfill) {
    startEmbeddingBackfill(options.backfillOptions);
  }

  return stopRawChatIndexer;
}

export function stopRawChatIndexer(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  for (const timer of pendingIndexing.values()) {
    clearTimeout(timer);
  }
  pendingIndexing.clear();
  for (const state of sweepStates.values()) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.queued = false;
  }
  sweepStates.clear();
  backfillController?.abort();
  backfillController = null;
  sweepOptions = {};
  sweepEnabled = false;
  started = false;
}

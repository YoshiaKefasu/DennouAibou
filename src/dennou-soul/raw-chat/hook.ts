import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveSessionAgentIdFromKey } from "./resolve-agent.js";
import { getRawChatClient } from "./client-ref.js";

/**
 * Hook into session transcript updates to incrementally index raw chat messages.
 *
 * ponytail: Phase 1 — thin TS boundary only. Indexing logic lives in Go.
 * This hook debounces transcript updates and sends index requests to the Go sidecar.
 * Indexing failures never affect chat delivery.
 */

const DEBOUNCE_MS = 2_000;
const pendingIndexing = new Map<string, ReturnType<typeof setTimeout>>();

let started = false;
let unsubscribe: (() => void) | null = null;

/**
 * Start the raw chat indexer hook.
 * Reads the global client reference set by the gateway.
 * Returns a cleanup function that removes the listener and clears pending timers.
 */
export function startRawChatIndexer(): () => void {
  if (started) {
    return () => {
      // Already started; no-op cleanup.
    };
  }
  started = true;

  unsubscribe = onSessionTranscriptUpdate((update) => {
    const sessionFile = update.sessionFile;
    if (!sessionFile) {
      return;
    }

    // Debounce: wait for rapid updates to settle.
    const existing = pendingIndexing.get(sessionFile);
    if (existing) {
      clearTimeout(existing);
    }

    pendingIndexing.set(
      sessionFile,
      setTimeout(() => {
        pendingIndexing.delete(sessionFile);

        const client = getRawChatClient();
        if (!client) {
          return; // Sidecar not available; skip indexing.
        }

        const agentId = resolveSessionAgentIdFromKey(update.sessionKey);

        // Non-blocking: fire and forget. Indexing failure never affects chat delivery.
        client.indexSession({
          session_file: sessionFile,
          agent_id: agentId,
          session_key: update.sessionKey ?? "",
        }).catch(() => {
          // Best-effort: ignore errors.
        });
      }, DEBOUNCE_MS),
    );
  });

  return stopRawChatIndexer;
}

/**
 * Stop the raw chat indexer hook.
 * Removes the listener and clears all pending debounce timers.
 */
export function stopRawChatIndexer(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  for (const timer of pendingIndexing.values()) {
    clearTimeout(timer);
  }
  pendingIndexing.clear();
  started = false;
}

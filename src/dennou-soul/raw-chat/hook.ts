import type { OpenClawConfig } from "../../config/config.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { getRawChatClient } from "./client-ref.js";
import { resolveSessionAgentIdFromKey } from "./resolve-agent.js";

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
let indexingEnabled = true;

/**
 * Check if raw chat indexing is enabled in config.
 * Defaults to true (enabled) when config is missing or flag is unset.
 */
export function isRawChatIndexingEnabled(config?: OpenClawConfig): boolean {
  // dennou is a DennouAibou-specific config namespace not on the OpenClawConfig type.
  const rawChat = (config as any)?.dennou?.rawChat;
  return rawChat?.indexing?.enabled !== false;
}

/**
 * Start the raw chat indexer hook.
 * Reads the global client reference set by the gateway.
 * Returns a cleanup function that removes the listener and clears pending timers.
 */
export function startRawChatIndexer(config?: OpenClawConfig): () => void {
  if (started) {
    return () => {
      // Already started; no-op cleanup.
    };
  }
  started = true;

  // Apply kill switch from config.
  indexingEnabled = isRawChatIndexingEnabled(config);

  unsubscribe = onSessionTranscriptUpdate((update) => {
    // Kill switch: skip indexing when disabled.
    if (!indexingEnabled) {
      return;
    }

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
        client
          .indexSession({
            session_file: sessionFile,
            agent_id: agentId,
            session_key: update.sessionKey ?? "",
          })
          .catch(() => {
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
  indexingEnabled = true;
}

/**
 * Backfill existing session JSONL files into the raw chat DB.
 * This is idempotent and safe to run multiple times.
 * Must be called after the sidecar is connected.
 */
export async function backfillSessionFiles(agentId: string, sessionDir?: string): Promise<void> {
  const client = getRawChatClient();
  if (!client) {
    return; // Sidecar not available; skip backfill.
  }

  try {
    const result = await client.backfill({
      agent_id: agentId,
      session_dir: sessionDir,
    });
    if (result.total_files > 0) {
      console.log(
        `[raw-chat] Backfill completed: ${result.indexed_files}/${result.total_files} files indexed, ${result.total_messages} messages`,
      );
    }
  } catch (err) {
    console.warn("[raw-chat] Backfill failed:", err instanceof Error ? err.message : String(err));
  }
}

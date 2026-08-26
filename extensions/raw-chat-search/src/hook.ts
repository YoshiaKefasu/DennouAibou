import type { OpenClawConfig } from "../../../src/config/config.js";
import { DEFAULT_AGENT_ID } from "../../../src/routing/session-key.js";
import { onSessionTranscriptUpdate } from "../../../src/sessions/transcript-events.js";
import { indexSessionFile } from "./indexer.js";

const DEBOUNCE_MS = 2_000;
const pendingIndexing = new Map<string, ReturnType<typeof setTimeout>>();

let started = false;
let unsubscribe: (() => void) | null = null;
let indexingEnabled = true;

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

export function startRawChatIndexer(config?: OpenClawConfig): () => void {
  if (started) {
    return () => {
      // Already started; no-op cleanup
    };
  }
  started = true;
  indexingEnabled = isRawChatIndexingEnabled(config);

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
      setTimeout(() => {
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
      }, DEBOUNCE_MS),
    );
  });

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
  started = false;
}

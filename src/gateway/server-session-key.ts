import { loadConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { getAgentRunContext, registerAgentRunContext } from "../infra/agent-events.js";
import { toAgentRequestSessionKey } from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import { loadCombinedSessionStoreForGateway } from "./session-utils.js";

const RUN_LOOKUP_CACHE_LIMIT = 256;
const RUN_LOOKUP_MISS_TTL_MS = 1_000;

type RunLookupCacheEntry = {
  sessionKey: string | null;
  expiresAt: number | null;
};

const resolvedSessionKeyByRunId = new Map<string, RunLookupCacheEntry>();

function setResolvedSessionKeyCache(runId: string, sessionKey: string | null): void {
  if (!runId) {
    return;
  }
  if (
    !resolvedSessionKeyByRunId.has(runId) &&
    resolvedSessionKeyByRunId.size >= RUN_LOOKUP_CACHE_LIMIT
  ) {
    const oldest = resolvedSessionKeyByRunId.keys().next().value;
    if (oldest) {
      resolvedSessionKeyByRunId.delete(oldest);
    }
  }
  resolvedSessionKeyByRunId.set(runId, {
    sessionKey,
    expiresAt: sessionKey === null ? Date.now() + RUN_LOOKUP_MISS_TTL_MS : null,
  });
}

export type ResolveSessionKeyForRunDeps = {
  /** Injectable config loader so tests do not mock `../config/config.js`. */
  loadConfig?: typeof loadConfig;
  /** Injectable gateway session store loader so tests do not mock `./session-utils.js`. */
  loadCombinedSessionStoreForGateway?: typeof loadCombinedSessionStoreForGateway;
};

export function resolveSessionKeyForRun(runId: string, deps: ResolveSessionKeyForRunDeps = {}) {
  const cached = getAgentRunContext(runId)?.sessionKey;
  if (cached) {
    return cached;
  }
  const cachedLookup = resolvedSessionKeyByRunId.get(runId);
  if (cachedLookup !== undefined) {
    if (cachedLookup.sessionKey !== null) {
      return cachedLookup.sessionKey;
    }
    if ((cachedLookup.expiresAt ?? 0) > Date.now()) {
      return undefined;
    }
    resolvedSessionKeyByRunId.delete(runId);
  }
  const loadConfigImpl = deps.loadConfig ?? loadConfig;
  const loadCombinedSessionStoreImpl =
    deps.loadCombinedSessionStoreForGateway ?? loadCombinedSessionStoreForGateway;
  const cfg = loadConfigImpl();
  const { store } = loadCombinedSessionStoreImpl(cfg);
  const matches = Object.entries(store).filter(
    (entry): entry is [string, SessionEntry] => entry[1]?.sessionId === runId,
  );
  const storeKey = resolvePreferredSessionKeyForSessionIdMatches(matches, runId);
  if (storeKey) {
    const sessionKey = toAgentRequestSessionKey(storeKey) ?? storeKey;
    registerAgentRunContext(runId, { sessionKey });
    setResolvedSessionKeyCache(runId, sessionKey);
    return sessionKey;
  }
  setResolvedSessionKeyCache(runId, null);
  return undefined;
}

export function resetResolvedSessionKeyForRunCacheForTest(): void {
  resolvedSessionKeyByRunId.clear();
}

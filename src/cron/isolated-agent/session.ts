import crypto from "node:crypto";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";

export function resolveCronSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  nowMs: number;
  agentId: string;
  forceNew?: boolean;
}) {
  const sessionCfg = params.cfg.session;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];

  // Kasou's master session is permanent: no automatic idle/daily reset ever
  // rotates a session. Existing entries are always reused; only `forceNew` or
  // a missing entry can produce a fresh sessionId.
  let sessionId: string;
  let isNewSession: boolean;
  let systemSent: boolean;

  if (!params.forceNew && entry?.sessionId) {
    sessionId = entry.sessionId;
    isNewSession = false;
    systemSent = entry.systemSent ?? false;
  } else {
    // No existing session, no sessionId, or forced new
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
  }

  clearBootstrapSnapshotOnSessionRollover({
    sessionKey: params.sessionKey,
    previousSessionId: isNewSession ? entry?.sessionId : undefined,
  });

  const sessionEntry: SessionEntry = {
    // Preserve existing per-session overrides even when rolling to a new sessionId.
    ...entry,
    // Always update these core fields
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
    // When starting a fresh session (forceNew / isolated), clear delivery routing
    // state inherited from prior sessions. Without this, lastThreadId leaks into
    // the new session and causes announce-mode cron deliveries to post as thread
    // replies instead of channel top-level messages.
    // deliveryContext must also be cleared because normalizeSessionEntryDelivery
    // repopulates lastThreadId from deliveryContext.threadId on store writes.
    ...(isNewSession && {
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
      lastThreadId: undefined,
      deliveryContext: undefined,
    }),
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession };
}

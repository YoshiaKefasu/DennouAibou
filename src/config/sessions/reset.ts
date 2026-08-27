import { resolveSessionThreadInfo } from "../../channels/plugins/session-conversation.js";

/**
 * Session thread detection helpers.
 *
 * Note: This module previously also implemented the automatic session reset
 * policy (idle / daily / resetByType / resetByChannel) via
 * `resolveSessionResetPolicy` / `evaluateSessionFreshness` /
 * `resolveProtectedSessionResetPolicy` / `resolveChannelResetConfig`. Those
 * functions have been removed; Kasou's master session is permanent and
 * sessions are NEVER rotated automatically based on inactivity or a daily
 * boundary. The legacy `session.reset`, `session.resetByType`,
 * `session.resetByChannel`, `session.resetTriggers`, and `session.idleMinutes`
 * config keys remain accepted by the zod schema for backward compatibility
 * with existing KASOU config files, but they have no effect at runtime.
 *
 * Manual reset commands (`/new`, `/reset`) remain in effect; their master
 * session protection guard is enforced directly in
 * `auto-reply/reply/session.ts` via `isProtectedSessionKey`.
 */

export type SessionResetType = "direct" | "group" | "thread";

const GROUP_SESSION_MARKERS = [":group:", ":channel:"];

export function isThreadSessionKey(sessionKey?: string | null): boolean {
  return Boolean(resolveSessionThreadInfo(sessionKey).threadId);
}

export function resolveSessionResetType(params: {
  sessionKey?: string | null;
  isGroup?: boolean;
  isThread?: boolean;
}): SessionResetType {
  if (params.isThread || isThreadSessionKey(params.sessionKey)) {
    return "thread";
  }
  if (params.isGroup) {
    return "group";
  }
  const normalized = (params.sessionKey ?? "").toLowerCase();
  if (GROUP_SESSION_MARKERS.some((marker) => normalized.includes(marker))) {
    return "group";
  }
  return "direct";
}

export function resolveThreadFlag(params: {
  sessionKey?: string | null;
  messageThreadId?: string | number | null;
  threadLabel?: string | null;
  threadStarterBody?: string | null;
  parentSessionKey?: string | null;
}): boolean {
  if (params.messageThreadId != null) {
    return true;
  }
  if (params.threadLabel?.trim()) {
    return true;
  }
  if (params.threadStarterBody?.trim()) {
    return true;
  }
  if (params.parentSessionKey?.trim()) {
    return true;
  }
  return isThreadSessionKey(params.sessionKey);
}

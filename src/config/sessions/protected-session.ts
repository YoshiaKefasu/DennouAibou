import {
  canonicalizeMainSessionAlias,
  resolveDefaultAgentId,
  resolveMainSessionKey,
} from "./main-session.js";
import type { SessionScope } from "./types.js";

export type ProtectedSessionConfig = {
  session?: {
    scope?: SessionScope;
    mainKey?: string;
    protectedKeys?: string[];
  };
  agents?: { list?: Array<{ id?: string; default?: boolean }> };
};

/**
 * Normalize a session key for protected-session comparison.
 *
 * Reuses canonicalizeMainSessionAlias semantics so "main", "agent:main:main",
 * and legacy "agent:main:<mainKey>" keys are treated as the main session.
 * The key is lowercased before canonicalization to match resolveSessionStoreKey /
 * normalizeExplicitSessionKey semantics (store keys are lowercase by construction),
 * so case variants of protected aliases (e.g. "MAIN", "AGENT:MAIN:MAIN") cannot
 * slip past the sessions.reset / sessions.delete / reset-trigger guards.
 * Canonicalization runs with the configured default agent id so bare "main"
 * and legacy agent:main:* aliases collapse onto the real main session key
 * (matching initSessionState's canonicalization, see #29683). Keys that are
 * not main aliases (for example channel/DM/group keys) pass through lowercased.
 */
export function normalizeProtectedSessionKey(key: string, cfg?: ProtectedSessionConfig): string {
  const raw = key.trim().toLowerCase();
  if (!raw) {
    return raw;
  }
  return canonicalizeMainSessionAlias({
    cfg,
    agentId: resolveDefaultAgentId(cfg),
    sessionKey: raw,
  });
}

/**
 * Returns true when a session key must never be reset or deleted.
 *
 * The main session (resolveMainSessionKey) is always protected, even when the
 * configured session.protectedKeys list omits it. Explicit entries are matched
 * after canonical main-alias normalization, so raw or alias forms compare
 * equal. Note: under session.scope "global", resolveMainSessionKey returns
 * "global", which is therefore always protected.
 */
export function isProtectedSessionKey(key: string, cfg?: ProtectedSessionConfig): boolean {
  const normalized = normalizeProtectedSessionKey(key, cfg);
  if (!normalized) {
    return false;
  }
  if (normalized === resolveMainSessionKey(cfg)) {
    return true;
  }
  return (cfg?.session?.protectedKeys ?? []).some(
    (protectedKey) => normalizeProtectedSessionKey(protectedKey, cfg) === normalized,
  );
}

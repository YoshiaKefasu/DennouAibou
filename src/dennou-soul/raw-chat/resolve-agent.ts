import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";

/**
 * Resolve agent ID from a session key.
 *
 * Session keys typically follow: agent:<agentId>:<channel>:<type>:<id>
 * Falls back to the default agent ID if parsing fails.
 */
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

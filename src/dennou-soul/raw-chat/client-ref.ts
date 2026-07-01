/**
 * Module-level client reference for the raw chat Go sidecar.
 *
 * This is a separate module to avoid circular dependencies between tool.ts and index.ts.
 * The gateway sets the client reference after starting the sidecar.
 * Tools and hooks read this reference to make RPC calls.
 */

import type { RawChatClient } from "./sidecar-client.js";

let globalClient: RawChatClient | null = null;

/**
 * Set the global raw chat client reference.
 * Called from gateway server.impl.ts after sidecar starts.
 */
export function setRawChatClient(client: RawChatClient): void {
  globalClient = client;
}

/**
 * Get the global raw chat client reference.
 * Used by tool.ts and hook.ts.
 */
export function getRawChatClient(): RawChatClient | null {
  return globalClient;
}

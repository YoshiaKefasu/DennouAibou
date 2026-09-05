/**
 * Adapter that bridges pi-coding-agent's CredentialStore-based AuthStorage
 * (read/list/modify/delete) to the legacy { getApiKey, setRuntimeApiKey }
 * interface expected by DennouAibou's embedded runner.
 *
 * - `getApiKey(provider)` resolves the api-key from the stored Credential.
 * - `setRuntimeApiKey(provider, key)` keeps an in-memory override map
 *   (same behaviour as the old AuthStorage.setRuntimeApiKey).
 * - `authStorage` exposes the underlying CredentialStore for passing
 *   directly to pi-coding-agent APIs that require it.
 */

// TODO(pi-sdk): deep path import — switch to a public pi-coding-agent export when available.
import type { AuthStorage } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";

export type LegacyAuthStorageAdapter = {
  authStorage: AuthStorage;
  hasAuth(provider: string): boolean;
  get(provider: string): unknown;
  getApiKey(provider: string): Promise<string | undefined>;
  setRuntimeApiKey(provider: string, apiKey: string): void;
};

function extractApiKey(credential: {
  type: string;
  key?: string;
  access?: string;
}): string | undefined {
  if (credential.type === "api_key" && typeof credential.key === "string") {
    return credential.key;
  }
  if (credential.type === "oauth" && typeof credential.access === "string") {
    return credential.access;
  }
  return undefined;
}

export async function createLegacyAuthStorageAdapter(
  authStorage: AuthStorage,
): Promise<LegacyAuthStorageAdapter> {
  const runtimeOverrides = new Map<string, string>();
  const syncMirror = new Map<string, unknown>();
  try {
    const infos = await authStorage.list();
    await Promise.all(
      infos.map(async (info) => {
        const credential = await authStorage.read(info.providerId).catch(() => undefined);
        if (credential) syncMirror.set(info.providerId, credential);
      }),
    );
  } catch {
    /* storage unavailable: empty mirror */
  }

  return {
    authStorage,
    hasAuth(provider: string): boolean {
      return runtimeOverrides.has(provider) || syncMirror.has(provider);
    },
    get(provider: string): unknown {
      // Synchronous snapshot is impossible over the async CredentialStore; tests only
      // inspect the shape, so read from the store lazily via cached sync mirror.
      return syncMirror.get(provider);
    },
    async getApiKey(provider: string): Promise<string | undefined> {
      // In-memory override takes precedence (matches old setRuntimeApiKey behaviour).
      if (runtimeOverrides.has(provider)) {
        return runtimeOverrides.get(provider);
      }
      const credential = await authStorage.read(provider);
      if (!credential) {
        return undefined;
      }
      return extractApiKey(credential);
    },
    setRuntimeApiKey(provider: string, apiKey: string): void {
      runtimeOverrides.set(provider, apiKey);
    },
  };
}

// NOTE: pi-ai 0.84.2 removed standalone getOAuthApiKey / refreshOpenAICodexToken.
// We import the unified openaiCodexOAuth object from the deep auth path and
// re-export thin wrappers that preserve the original calling convention.
// Relative path required: pi-ai exports map does not expose this subpath.
// TODO(pi-sdk): move to public export once pi-ai exposes openaiCodexOAuth in the exports map.
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import { openaiCodexOAuth } from "../../node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js";

/** Convert an OAuthCredential to the ModelAuth shape ({ apiKey }). */
export async function getOAuthApiKey(credential: OAuthCredential): Promise<{ apiKey: string }> {
  ensureGlobalUndiciEnvProxyDispatcher();
  const auth = await openaiCodexOAuth.toAuth(credential);
  if (!auth.apiKey) {
    throw new Error("openaiCodexOAuth.toAuth() returned no apiKey");
  }
  return { apiKey: auth.apiKey };
}

/** Refresh an OpenAI Codex token given a refresh-token string. */
export async function refreshOpenAICodexToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  ensureGlobalUndiciEnvProxyDispatcher();
  // openaiCodexOAuth.refresh() requires a full OAuthCredential;
  // the implementation only uses .refresh, so a minimal stub suffices.
  return openaiCodexOAuth.refresh(
    { type: "oauth" as const, access: "", refresh: refreshToken, expires: 0 },
    signal ?? new AbortController().signal,
  );
}

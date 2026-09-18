import { withStrictWebToolsEndpoint } from "./web-guarded-fetch.js";

const REDIRECT_TIMEOUT_MS = 5000;

/**
 * Injectable seams for tests. Defaults mirror production so callers keep the
 * existing behaviour.
 */
export type CitationRedirectDeps = {
  withStrictWebToolsEndpoint?: typeof withStrictWebToolsEndpoint;
};

/**
 * Resolve a citation redirect URL to its final destination using a HEAD request.
 * Returns the original URL if resolution fails or times out.
 */
export async function resolveCitationRedirectUrl(
  url: string,
  deps: CitationRedirectDeps = {},
): Promise<string> {
  try {
    return await (deps.withStrictWebToolsEndpoint ?? withStrictWebToolsEndpoint)(
      {
        url,
        init: { method: "HEAD" },
        timeoutMs: REDIRECT_TIMEOUT_MS,
      },
      async ({ finalUrl }) => finalUrl || url,
    );
  } catch {
    return url;
  }
}

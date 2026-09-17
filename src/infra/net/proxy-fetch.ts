import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import { logWarn } from "../../logger.js";
import { hasEnvHttpProxyConfigured } from "./proxy-env.js";

export const PROXY_FETCH_PROXY_URL = Symbol.for("dennou.proxyFetch.proxyUrl");
type ProxyFetchWithMetadata = typeof fetch & {
  [PROXY_FETCH_PROXY_URL]?: string;
};

/**
 * Injectable seams for tests. Every entry defaults to the real undici / proxy-env
 * implementation so production callers keep the existing behaviour.
 */
export type ProxyFetchDeps = {
  EnvHttpProxyAgent?: typeof EnvHttpProxyAgent;
  ProxyAgent?: typeof ProxyAgent;
  fetch?: typeof undiciFetch;
  hasEnvHttpProxyConfigured?: (protocol?: "http" | "https", env?: NodeJS.ProcessEnv) => boolean;
};

/**
 * Create a fetch function that routes requests through the given HTTP proxy.
 * Uses undici's ProxyAgent under the hood.
 */
export function makeProxyFetch(proxyUrl: string, deps: ProxyFetchDeps = {}): typeof fetch {
  const ProxyAgentCtor = deps.ProxyAgent ?? ProxyAgent;
  const fetchImpl = deps.fetch ?? undiciFetch;
  let agent: ProxyAgent | null = null;
  const resolveAgent = (): ProxyAgent => {
    if (!agent) {
      agent = new ProxyAgentCtor(proxyUrl);
    }
    return agent;
  };
  // undici's fetch is runtime-compatible with global fetch but the types diverge
  // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchImpl(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: resolveAgent(),
    }) as unknown as Promise<Response>) as ProxyFetchWithMetadata;
  Object.defineProperty(proxyFetch, PROXY_FETCH_PROXY_URL, {
    value: proxyUrl,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return proxyFetch;
}

export function getProxyUrlFromFetch(fetchImpl?: typeof fetch): string | undefined {
  const proxyUrl = (fetchImpl as ProxyFetchWithMetadata | undefined)?.[PROXY_FETCH_PROXY_URL];
  if (typeof proxyUrl !== "string") {
    return undefined;
  }
  const trimmed = proxyUrl.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve a proxy-aware fetch from standard environment variables
 * (HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy).
 * Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
 * Returns undefined when no proxy is configured.
 * Gracefully returns undefined if the proxy URL is malformed.
 */
export function resolveProxyFetchFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: ProxyFetchDeps = {},
): typeof fetch | undefined {
  const hasProxyConfigured = deps.hasEnvHttpProxyConfigured ?? hasEnvHttpProxyConfigured;
  if (!hasProxyConfigured("https", env)) {
    return undefined;
  }
  const EnvHttpProxyAgentCtor = deps.EnvHttpProxyAgent ?? EnvHttpProxyAgent;
  const fetchImpl = deps.fetch ?? undiciFetch;
  try {
    const agent = new EnvHttpProxyAgentCtor();
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      fetchImpl(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
  } catch (err) {
    logWarn(
      `Proxy env var set but agent creation failed — falling back to direct fetch: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

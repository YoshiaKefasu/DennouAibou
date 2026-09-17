import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProxyUrlFromFetch,
  makeProxyFetch,
  PROXY_FETCH_PROXY_URL,
  resolveProxyFetchFromEnv,
  type ProxyFetchDeps,
} from "./proxy-fetch.js";

type DepsProxyAgent = NonNullable<ProxyFetchDeps["ProxyAgent"]>;
type DepsEnvHttpProxyAgent = NonNullable<ProxyFetchDeps["EnvHttpProxyAgent"]>;
type DepsFetch = NonNullable<ProxyFetchDeps["fetch"]>;

function createUndiciMocks() {
  const undiciFetch = vi.fn();
  const proxyAgentSpy = vi.fn();
  const envAgentSpy = vi.fn();

  class ProxyAgent {
    static lastCreated: ProxyAgent | undefined;
    proxyUrl: string;
    constructor(proxyUrl: string) {
      this.proxyUrl = proxyUrl;
      ProxyAgent.lastCreated = this;
      proxyAgentSpy(proxyUrl);
    }
  }

  class EnvHttpProxyAgent {
    static lastCreated: EnvHttpProxyAgent | undefined;
    constructor() {
      EnvHttpProxyAgent.lastCreated = this;
      envAgentSpy();
    }
  }

  return {
    EnvHttpProxyAgent,
    ProxyAgent,
    undiciFetch,
    proxyAgentSpy,
    envAgentSpy,
    getLastAgent: () => ProxyAgent.lastCreated,
  };
}

const undiciMocks = createUndiciMocks();

const proxyFetchDeps: ProxyFetchDeps = {
  ProxyAgent: undiciMocks.ProxyAgent as unknown as DepsProxyAgent,
  EnvHttpProxyAgent: undiciMocks.EnvHttpProxyAgent as unknown as DepsEnvHttpProxyAgent,
  fetch: undiciMocks.undiciFetch as unknown as DepsFetch,
};

const { EnvHttpProxyAgent, undiciFetch, proxyAgentSpy, envAgentSpy, getLastAgent } = undiciMocks;

describe("makeProxyFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses undici fetch with ProxyAgent dispatcher", async () => {
    const proxyUrl = "http://proxy.test:8080";
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch(proxyUrl, proxyFetchDeps);
    expect(proxyAgentSpy).not.toHaveBeenCalled();
    await proxyFetch("https://api.example.com/v1/audio");

    expect(proxyAgentSpy).toHaveBeenCalledWith(proxyUrl);
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/audio",
      expect.objectContaining({ dispatcher: getLastAgent() }),
    );
  });

  it("reuses the same ProxyAgent across calls", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch("http://proxy.test:8080", proxyFetchDeps);

    await proxyFetch("https://api.example.com/one");
    const firstDispatcher = undiciFetch.mock.calls[0]?.[1]?.dispatcher;
    await proxyFetch("https://api.example.com/two");
    const secondDispatcher = undiciFetch.mock.calls[1]?.[1]?.dispatcher;

    expect(proxyAgentSpy).toHaveBeenCalledOnce();
    expect(secondDispatcher).toBe(firstDispatcher);
  });
});

describe("getProxyUrlFromFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the trimmed proxy url from proxy fetch wrappers", () => {
    expect(getProxyUrlFromFetch(makeProxyFetch("  http://proxy.test:8080  ", proxyFetchDeps))).toBe(
      "http://proxy.test:8080",
    );
  });

  it("returns undefined for plain fetch functions or blank metadata", () => {
    const plainFetch = vi.fn() as unknown as typeof fetch;
    const blankMetadataFetch = vi.fn() as unknown as typeof fetch;
    Object.defineProperty(blankMetadataFetch, PROXY_FETCH_PROXY_URL, {
      value: "   ",
      enumerable: false,
      configurable: true,
      writable: true,
    });

    expect(getProxyUrlFromFetch(plainFetch)).toBeUndefined();
    expect(getProxyUrlFromFetch(blankMetadataFetch)).toBeUndefined();
  });
});

describe("resolveProxyFetchFromEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined when no proxy env vars are set", () => {
    expect(resolveProxyFetchFromEnv({}, proxyFetchDeps)).toBeUndefined();
  });

  it("returns proxy fetch using EnvHttpProxyAgent when HTTPS_PROXY is set", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const fetchFn = resolveProxyFetchFromEnv(
      {
        HTTP_PROXY: "",
        HTTPS_PROXY: "http://proxy.test:8080",
      },
      proxyFetchDeps,
    );
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();

    await fetchFn!("https://api.example.com");
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://api.example.com",
      expect.objectContaining({ dispatcher: EnvHttpProxyAgent.lastCreated }),
    );
  });

  it("returns proxy fetch when HTTP_PROXY is set", () => {
    const fetchFn = resolveProxyFetchFromEnv(
      {
        HTTPS_PROXY: "",
        HTTP_PROXY: "http://fallback.test:3128",
      },
      proxyFetchDeps,
    );
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns proxy fetch when lowercase https_proxy is set", () => {
    const fetchFn = resolveProxyFetchFromEnv(
      {
        HTTPS_PROXY: "",
        HTTP_PROXY: "",
        http_proxy: "",
        https_proxy: "http://lower.test:1080",
      },
      proxyFetchDeps,
    );
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns proxy fetch when lowercase http_proxy is set", () => {
    const fetchFn = resolveProxyFetchFromEnv(
      {
        HTTPS_PROXY: "",
        HTTP_PROXY: "",
        https_proxy: "",
        http_proxy: "http://lower-http.test:1080",
      },
      proxyFetchDeps,
    );
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns undefined when EnvHttpProxyAgent constructor throws", () => {
    envAgentSpy.mockImplementationOnce(() => {
      throw new Error("Invalid URL");
    });

    const fetchFn = resolveProxyFetchFromEnv(
      {
        HTTP_PROXY: "",
        https_proxy: "",
        http_proxy: "",
        HTTPS_PROXY: "not-a-valid-url",
      },
      proxyFetchDeps,
    );
    expect(fetchFn).toBeUndefined();
  });
});

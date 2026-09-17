import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinnedDispatcher, type PinnedHostname } from "./ssrf.js";
import type { UndiciRuntimeDeps } from "./undici-runtime.js";

/**
 * Records constructor invocations without relying on `vi.fn()` being usable
 * as a constructor, which differs between test runtimes.
 */
function createRecordingCtor() {
  const calls: unknown[][] = [];
  class RecordingCtor {
    constructor(...args: unknown[]) {
      calls.push(args);
    }
  }
  return {
    ctor: RecordingCtor as unknown as new (...args: never[]) => unknown,
    calls,
  };
}

const agent = createRecordingCtor();
const envHttpProxyAgent = createRecordingCtor();
const proxyAgent = createRecordingCtor();

const undiciDeps: UndiciRuntimeDeps = {
  Agent: agent.ctor as unknown as UndiciRuntimeDeps["Agent"],
  EnvHttpProxyAgent: envHttpProxyAgent.ctor as unknown as UndiciRuntimeDeps["EnvHttpProxyAgent"],
  ProxyAgent: proxyAgent.ctor as unknown as UndiciRuntimeDeps["ProxyAgent"],
  fetch: (() => Promise.reject(new Error("unused in this test"))) as UndiciRuntimeDeps["fetch"],
};

beforeEach(() => {
  agent.calls.length = 0;
  envHttpProxyAgent.calls.length = 0;
  proxyAgent.calls.length = 0;
});

function createPinnedTelegramHost(lookup: PinnedHostname["lookup"]): PinnedHostname {
  return {
    hostname: "api.telegram.org",
    addresses: ["149.154.167.221"],
    lookup,
  };
}

function createDispatcherWithPinnedOverride(lookup: PinnedHostname["lookup"]) {
  createPinnedDispatcher(
    createPinnedTelegramHost(lookup),
    {
      mode: "direct",
      pinnedHostname: {
        hostname: "api.telegram.org",
        addresses: ["149.154.167.220"],
      },
    },
    undefined,
    undiciDeps,
  );

  return (agent.calls.at(-1)?.[0] as { connect?: { lookup?: PinnedHostname["lookup"] } })?.connect
    ?.lookup;
}

describe("createPinnedDispatcher", () => {
  it("uses pinned lookup without overriding global family policy", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    const dispatcher = createPinnedDispatcher(pinned, undefined, undefined, undiciDeps);

    expect(dispatcher).toBeDefined();
    expect(agent.calls).toContainEqual([
      {
        connect: {
          lookup,
        },
      },
    ]);
    const firstCallArg = agent.calls[0]?.[0] as { connect?: Record<string, unknown> } | undefined;
    expect(firstCallArg?.connect?.autoSelectFamily).toBeUndefined();
  });

  it("preserves caller transport hints while overriding lookup", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const previousLookup = vi.fn();
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(
      pinned,
      {
        mode: "direct",
        connect: {
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: 300,
          lookup: previousLookup,
        },
      },
      undefined,
      undiciDeps,
    );

    expect(agent.calls).toContainEqual([
      {
        connect: {
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: 300,
          lookup,
        },
      },
    ]);
  });

  it("replaces the pinned lookup when a dispatcher override hostname is provided", () => {
    const originalLookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const lookup = createDispatcherWithPinnedOverride(originalLookup);

    expect(lookup).toBeTypeOf("function");
    const callback = vi.fn();
    lookup?.("api.telegram.org", callback);

    expect(callback).toHaveBeenCalledWith(null, "149.154.167.220", 4);
    expect(originalLookup).not.toHaveBeenCalled();
  });

  it("keeps the override bound to the matching hostname only", () => {
    const originalLookup = vi.fn(
      (_hostname: string, callback: (err: null, address: string, family: number) => void) => {
        callback(null, "93.184.216.34", 4);
      },
    ) as unknown as PinnedHostname["lookup"];
    const lookup = createDispatcherWithPinnedOverride(originalLookup);
    const callback = vi.fn();
    lookup?.("example.com", callback);

    expect(originalLookup).toHaveBeenCalledWith("example.com", expect.any(Function));
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("rejects pinned override addresses that violate SSRF policy", () => {
    const originalLookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.221"],
      lookup: originalLookup,
    };

    expect(() =>
      createPinnedDispatcher(
        pinned,
        {
          mode: "direct",
          pinnedHostname: {
            hostname: "api.telegram.org",
            addresses: ["127.0.0.1"],
          },
        },
        undefined,
        undiciDeps,
      ),
    ).toThrow(/private|internal|blocked/i);
  });

  it("keeps env proxy route while pinning the direct no-proxy path", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(
      pinned,
      {
        mode: "env-proxy",
        connect: {
          autoSelectFamily: true,
        },
        proxyTls: {
          autoSelectFamily: true,
        },
      },
      undefined,
      undiciDeps,
    );

    expect(envHttpProxyAgent.calls).toContainEqual([
      {
        connect: {
          autoSelectFamily: true,
          lookup,
        },
        proxyTls: {
          autoSelectFamily: true,
        },
      },
    ]);
  });

  it("keeps explicit proxy routing intact", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(
      pinned,
      {
        mode: "explicit-proxy",
        proxyUrl: "http://127.0.0.1:7890",
        proxyTls: {
          autoSelectFamily: false,
        },
      },
      undefined,
      undiciDeps,
    );

    expect(proxyAgent.calls).toContainEqual([
      {
        uri: "http://127.0.0.1:7890",
        requestTls: {
          autoSelectFamily: false,
          lookup,
        },
      },
    ]);
  });
});

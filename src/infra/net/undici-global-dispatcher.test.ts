import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
  ensureGlobalUndiciEnvProxyDispatcher,
  ensureGlobalUndiciStreamTimeouts,
  resetGlobalUndiciStreamTimeoutsForTests,
  type UndiciDispatcherDeps,
} from "./undici-global-dispatcher.js";

type DepsAgentCtor = NonNullable<UndiciDispatcherDeps["Agent"]>;
type DepsEnvHttpProxyAgentCtor = NonNullable<UndiciDispatcherDeps["EnvHttpProxyAgent"]>;
type DepsGetGlobalDispatcher = NonNullable<UndiciDispatcherDeps["getGlobalDispatcher"]>;
type DepsSetGlobalDispatcher = NonNullable<UndiciDispatcherDeps["setGlobalDispatcher"]>;

class Agent {
  constructor(public readonly options?: Record<string, unknown>) {}
}

class EnvHttpProxyAgent {
  constructor(public readonly options?: Record<string, unknown>) {}
}

class ProxyAgent {
  constructor(public readonly url: string) {}
}

function createHarness() {
  let currentDispatcher: unknown = new Agent();

  const getGlobalDispatcher = vi.fn(() => currentDispatcher);
  const setGlobalDispatcher = vi.fn((next: unknown) => {
    currentDispatcher = next;
  });
  const getDefaultAutoSelectFamily = vi.fn<() => boolean | undefined>(() => undefined);
  const hasEnvHttpProxyConfigured = vi.fn<(protocol?: "http" | "https") => boolean>(() => false);
  const isWSL2Sync = vi.fn(() => false);

  const deps: UndiciDispatcherDeps = {
    Agent: Agent as unknown as DepsAgentCtor,
    EnvHttpProxyAgent: EnvHttpProxyAgent as unknown as DepsEnvHttpProxyAgentCtor,
    getGlobalDispatcher: getGlobalDispatcher as unknown as DepsGetGlobalDispatcher,
    setGlobalDispatcher: setGlobalDispatcher as unknown as DepsSetGlobalDispatcher,
    getDefaultAutoSelectFamily,
    hasEnvHttpProxyConfigured,
    isWSL2Sync,
  };

  return {
    deps,
    getGlobalDispatcher,
    setGlobalDispatcher,
    getDefaultAutoSelectFamily,
    hasEnvHttpProxyConfigured,
    isWSL2Sync,
    setCurrentDispatcher: (next: unknown) => {
      currentDispatcher = next;
    },
    getCurrentDispatcher: () => currentDispatcher,
  };
}

describe("ensureGlobalUndiciStreamTimeouts", () => {
  beforeEach(() => {
    resetGlobalUndiciStreamTimeoutsForTests();
  });

  it("replaces default Agent dispatcher with extended stream timeouts", () => {
    const harness = createHarness();
    harness.getDefaultAutoSelectFamily.mockReturnValue(true);

    ensureGlobalUndiciStreamTimeouts(undefined, harness.deps);

    expect(harness.setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = harness.getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(Agent);
    expect(next.options?.bodyTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.headersTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.connect).toEqual({
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 300,
    });
  });

  it("replaces EnvHttpProxyAgent dispatcher while preserving env-proxy mode", () => {
    const harness = createHarness();
    harness.getDefaultAutoSelectFamily.mockReturnValue(false);
    harness.setCurrentDispatcher(new EnvHttpProxyAgent());

    ensureGlobalUndiciStreamTimeouts(undefined, harness.deps);

    expect(harness.setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = harness.getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(EnvHttpProxyAgent);
    expect(next.options?.bodyTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.headersTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.connect).toEqual({
      autoSelectFamily: false,
      autoSelectFamilyAttemptTimeout: 300,
    });
  });

  it("does not override unsupported custom proxy dispatcher types", () => {
    const harness = createHarness();
    harness.setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciStreamTimeouts(undefined, harness.deps);

    expect(harness.setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("is idempotent for unchanged dispatcher kind and network policy", () => {
    const harness = createHarness();
    harness.getDefaultAutoSelectFamily.mockReturnValue(true);

    ensureGlobalUndiciStreamTimeouts(undefined, harness.deps);
    ensureGlobalUndiciStreamTimeouts(undefined, harness.deps);

    expect(harness.setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("re-applies when autoSelectFamily decision changes", () => {
    const harness = createHarness();
    harness.getDefaultAutoSelectFamily.mockReturnValue(true);
    ensureGlobalUndiciStreamTimeouts(undefined, harness.deps);

    harness.getDefaultAutoSelectFamily.mockReturnValue(false);
    ensureGlobalUndiciStreamTimeouts(undefined, harness.deps);

    expect(harness.setGlobalDispatcher).toHaveBeenCalledTimes(2);
    const next = harness.getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next.options?.connect).toEqual({
      autoSelectFamily: false,
      autoSelectFamilyAttemptTimeout: 300,
    });
  });

  it("disables autoSelectFamily on WSL2 to avoid IPv6 connectivity issues", () => {
    const harness = createHarness();
    harness.getDefaultAutoSelectFamily.mockReturnValue(true);
    harness.isWSL2Sync.mockReturnValue(true);

    ensureGlobalUndiciStreamTimeouts(undefined, harness.deps);

    expect(harness.setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = harness.getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(Agent);
    expect(next.options?.connect).toEqual({
      autoSelectFamily: false,
      autoSelectFamilyAttemptTimeout: 300,
    });
  });
});

describe("ensureGlobalUndiciEnvProxyDispatcher", () => {
  beforeEach(() => {
    resetGlobalUndiciStreamTimeoutsForTests();
  });

  it("installs EnvHttpProxyAgent when env HTTP proxy is configured on a default Agent", () => {
    const harness = createHarness();
    harness.hasEnvHttpProxyConfigured.mockReturnValue(true);

    ensureGlobalUndiciEnvProxyDispatcher(harness.deps);

    expect(harness.setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(harness.getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("does not override unsupported custom proxy dispatcher types", () => {
    const harness = createHarness();
    harness.hasEnvHttpProxyConfigured.mockReturnValue(true);
    harness.setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciEnvProxyDispatcher(harness.deps);

    expect(harness.setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("retries proxy bootstrap after an unsupported dispatcher later becomes a default Agent", () => {
    const harness = createHarness();
    harness.hasEnvHttpProxyConfigured.mockReturnValue(true);
    harness.setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciEnvProxyDispatcher(harness.deps);
    expect(harness.setGlobalDispatcher).not.toHaveBeenCalled();

    harness.setCurrentDispatcher(new Agent());
    ensureGlobalUndiciEnvProxyDispatcher(harness.deps);

    expect(harness.setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(harness.getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("is idempotent after proxy bootstrap succeeds", () => {
    const harness = createHarness();
    harness.hasEnvHttpProxyConfigured.mockReturnValue(true);

    ensureGlobalUndiciEnvProxyDispatcher(harness.deps);
    ensureGlobalUndiciEnvProxyDispatcher(harness.deps);

    expect(harness.setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("reinstalls env proxy if an external change later reverts the dispatcher to Agent", () => {
    const harness = createHarness();
    harness.hasEnvHttpProxyConfigured.mockReturnValue(true);

    ensureGlobalUndiciEnvProxyDispatcher(harness.deps);
    expect(harness.setGlobalDispatcher).toHaveBeenCalledTimes(1);

    harness.setCurrentDispatcher(new Agent());
    ensureGlobalUndiciEnvProxyDispatcher(harness.deps);

    expect(harness.setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(harness.getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });
});

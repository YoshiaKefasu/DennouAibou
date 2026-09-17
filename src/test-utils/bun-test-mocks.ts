import { vi } from "vitest";

// Bun 1.4 exposes the Vitest-compatible `vi` object but not `vi.hoisted`.
// Bun evaluates test files normally, so running the factory immediately
// preserves the value-initialization role used by static `vi.mock` factories.
if (typeof vi.hoisted !== "function") {
  vi.hoisted = <T>(factory: () => T): T => factory();
}

const envSnapshots = new Map<string, string | undefined>();
const globalSnapshots = new Map<PropertyKey, PropertyDescriptor | undefined>();

export type BunTestMockApi = {
  stubEnv: (key: string, value: string | undefined) => void;
  stubGlobal: (key: PropertyKey, value: unknown) => void;
  setTime: (at: string | number | Date) => void;
  restoreEnvs: () => void;
  restoreGlobals: () => void;
};

type TestAfterEach = (callback: () => void) => void;

declare global {
  var __bunTestMocks: BunTestMockApi;
  var setTestEnv: (key: string, value: string | undefined) => void;
  var setTestGlobal: (key: PropertyKey, value: unknown) => void;
  var restoreTestEnvs: () => void;
  var restoreTestGlobals: () => void;
  var setTestTime: (at: string | number | Date) => void;
}

export function setTestEnv(key: string, value: string | undefined): void {
  if (!envSnapshots.has(key)) {
    envSnapshots.set(key, process.env[key]);
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

export function setTestGlobal(key: PropertyKey, value: unknown): void {
  if (!globalSnapshots.has(key)) {
    globalSnapshots.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

export function restoreTestEnvs(): void {
  for (const [key, value] of envSnapshots) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  envSnapshots.clear();
}

export function restoreTestGlobals(): void {
  for (const [key, descriptor] of globalSnapshots) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
  globalSnapshots.clear();
}

export function setTestTime(at: string | number | Date): void {
  const target = typeof at === "number" ? at : new Date(at).getTime();
  const delta = target - Date.now();
  if (vi.isFakeTimers() && delta >= 0) {
    vi.advanceTimersByTime(delta);
  } else {
    vi.useFakeTimers({ now: target });
  }
}

const api: BunTestMockApi = {
  stubEnv: setTestEnv,
  stubGlobal: setTestGlobal,
  setTime: setTestTime,
  restoreEnvs: restoreTestEnvs,
  restoreGlobals: restoreTestGlobals,
};

globalThis.__bunTestMocks = api;
globalThis.setTestEnv = setTestEnv;
globalThis.setTestGlobal = setTestGlobal;
globalThis.restoreTestEnvs = restoreTestEnvs;
globalThis.restoreTestGlobals = restoreTestGlobals;
globalThis.setTestTime = setTestTime;

export function installTestMockCleanup(registerAfterEach: TestAfterEach): void {
  registerAfterEach(() => {
    api.restoreGlobals();
    api.restoreEnvs();
  });
}

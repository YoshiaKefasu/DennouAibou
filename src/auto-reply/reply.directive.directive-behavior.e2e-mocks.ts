import { vi, type Mock } from "vitest";

// Vitest hoists `vi.mock` to the top of the file, but the harness uses
// `vi.doMock` (not hoisted) to re-register the same module mocks with the
// additional fields surfaced by the thinkingLevelMap migration
// (`resolveActiveEmbeddedRunSessionId`, `waitForEmbeddedPiRunEnd`,
// `getCachedModelCatalogSync`). The harness's `vi.doMock` takes effect at
// runtime and supersedes any `vi.mock` declared here. We still keep static
// `vi.mock` registrations below so that tests which do not call
// `installFreshDirectiveBehaviorReplyMocks()` (e.g. `shows-current-verbose`,
// `prefers-alias`) do not load the real `pi-embedded` / `model-catalog`
// modules and trigger a real embedded pi-agent run (120s timeout
// regression).

// Hoisted mock state: vitest hoists `vi.mock`/`vi.doMock` before any
// imports, so we declare the shared state via `vi.hoisted` and let both the
// hoisted mocks and the harness reference it. The shared `latestCatalog`
// lets the `getCachedModelCatalogSync` mock mirror whatever the latest
// `loadModelCatalog` call resolved with, so consumers like
// `src/auto-reply/thinking.ts` can read per-model `compat.reasoningEffortMap`
// the same way production does (through the resolved catalog).
const harnessCatalogState = vi.hoisted(() => {
  const state: { latestCatalog: unknown[] | undefined } = { latestCatalog: undefined };
  return state;
});

const runEmbeddedPiAgentMockInternal = vi.hoisted(() => vi.fn());
const loadModelCatalogMockInternal = vi.hoisted(() => {
  const mock = vi.fn((..._args: unknown[]) =>
    Promise.resolve(harnessCatalogState.latestCatalog ?? []),
  );
  const originalResolvedValue = mock.mockResolvedValue.bind(mock);
  const originalResolvedValueOnce = mock.mockResolvedValueOnce.bind(mock);
  const originalReset = mock.mockReset.bind(mock);
  mock.mockResolvedValue = ((value: unknown[]) => {
    harnessCatalogState.latestCatalog = value;
    return originalResolvedValue(value);
  }) as typeof mock.mockResolvedValue;
  mock.mockResolvedValueOnce = ((value: unknown[]) => {
    harnessCatalogState.latestCatalog = value;
    return originalResolvedValueOnce(value);
  }) as typeof mock.mockResolvedValueOnce;
  mock.mockReset = (() => {
    harnessCatalogState.latestCatalog = undefined;
    return originalReset();
  }) as typeof mock.mockReset;
  return mock;
});
const getCachedModelCatalogSyncMockInternal = vi.hoisted(() =>
  vi.fn(() => harnessCatalogState.latestCatalog),
);

export const runEmbeddedPiAgentMock: Mock = runEmbeddedPiAgentMockInternal;
export const loadModelCatalogMock: Mock = loadModelCatalogMockInternal;
export const getCachedModelCatalogSyncMock: Mock = getCachedModelCatalogSyncMockInternal;

// Restored after c0565e96e92 removed them: tests that do not call
// `installFreshDirectiveBehaviorReplyMocks()` (shows-current-verbose,
// prefers-alias) would otherwise load the real pi-embedded / model-catalog
// modules and start a real embedded pi-agent run (120s timeout regression).
// The harness's runtime `vi.doMock` in `installFreshDirectiveBehaviorReplyMocks`
// supersedes these static registrations for tests that need the extended
// surface (`resolveActiveEmbeddedRunSessionId`, `waitForEmbeddedPiRunEnd`,
// `getCachedModelCatalogSync`).
vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (...args: unknown[]) =>
    (runEmbeddedPiAgentMockInternal as unknown as Mock)(...args),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  resolveActiveEmbeddedRunSessionId: vi.fn().mockReturnValue(undefined),
  waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: loadModelCatalogMockInternal,
  getCachedModelCatalogSync: (...args: unknown[]) =>
    (getCachedModelCatalogSyncMockInternal as unknown as Mock)(...args),
  resetModelCatalogCacheForTest: vi.fn(),
}));

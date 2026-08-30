import { vi, type Mock } from "vitest";

// Vitest hoists `vi.mock` to the top of the file, but the harness uses
// `vi.doMock` (not hoisted) to re-register the same module mocks with the
// additional fields surfaced by the thinkingLevelMap migration
// (`resolveActiveEmbeddedRunSessionId`, `waitForEmbeddedPiRunEnd`,
// `getCachedModelCatalogSync`). The harness's `vi.doMock` takes effect at
// runtime and supersedes any `vi.mock` declared here, so this file's only
// job is to expose the underlying mock functions (and a shared catalog
// cache) so the harness can wire them into its `vi.doMock` factory.

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

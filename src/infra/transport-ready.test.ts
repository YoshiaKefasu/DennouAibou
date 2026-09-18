import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForTransportReady, type TransportReadyDeps } from "./transport-ready.js";

let nowMs = 0;
let injectedSleepError: Error | null = null;
const sleepWithAbort = vi.fn(async (ms: number, signal?: AbortSignal) => {
  if (injectedSleepError) {
    throw injectedSleepError;
  }
  if (signal?.aborted) {
    throw new Error("aborted");
  }
  nowMs += ms;
});

function createDeps(overrides: Partial<TransportReadyDeps> = {}): TransportReadyDeps {
  return {
    now: () => nowMs,
    sleepWithAbort: sleepWithAbort as unknown as NonNullable<TransportReadyDeps["sleepWithAbort"]>,
    ...overrides,
  };
}

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

beforeEach(() => {
  nowMs = 0;
  injectedSleepError = null;
  sleepWithAbort.mockClear();
});

afterEach(() => {
  injectedSleepError = null;
});

describe("waitForTransportReady", () => {
  it("returns when the check succeeds and logs after the delay", async () => {
    const runtime = createRuntime();
    let attempts = 0;
    const readyPromise = waitForTransportReady(
      {
        label: "test transport",
        timeoutMs: 220,
        // Deterministic: first attempt at t=0 won't log; second attempt at t=50 will.
        logAfterMs: 1,
        logIntervalMs: 1_000,
        pollIntervalMs: 50,
        runtime,
        check: async () => {
          attempts += 1;
          if (attempts > 2) {
            return { ok: true };
          }
          return { ok: false, error: "not ready" };
        },
      },
      createDeps(),
    );

    await readyPromise;
    expect(runtime.error).toHaveBeenCalled();
  });

  it("throws after the timeout", async () => {
    const runtime = createRuntime();
    const waitPromise = waitForTransportReady(
      {
        label: "test transport",
        timeoutMs: 110,
        logAfterMs: 0,
        logIntervalMs: 1_000,
        pollIntervalMs: 50,
        runtime,
        check: async () => ({ ok: false, error: "still down" }),
      },
      createDeps(),
    );

    await expect(waitPromise).rejects.toThrow("test transport not ready");
    expect(runtime.error).toHaveBeenCalled();
  });

  it("returns early when aborted", async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    controller.abort();
    await waitForTransportReady(
      {
        label: "test transport",
        timeoutMs: 200,
        runtime,
        abortSignal: controller.signal,
        check: async () => ({ ok: false, error: "still down" }),
      },
      createDeps(),
    );
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("stops polling when aborted during the sleep interval", async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    let attempts = 0;

    const waitPromise = waitForTransportReady(
      {
        label: "test transport",
        timeoutMs: 500,
        pollIntervalMs: 50,
        runtime,
        abortSignal: controller.signal,
        check: async () => {
          attempts += 1;
          return { ok: false, error: "still down" };
        },
      },
      createDeps({
        sleepWithAbort: (async (ms: number, signal?: AbortSignal) => {
          nowMs += ms;
          // Emulates the original "abort fires 10ms into the poll interval" timer.
          if (nowMs >= 10) {
            controller.abort();
          }
          if (signal?.aborted) {
            throw new Error("aborted");
          }
        }) as unknown as NonNullable<TransportReadyDeps["sleepWithAbort"]>,
      }),
    );

    await waitPromise;

    expect(attempts).toBe(1);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("logs repeated unknown-error retries and the final timeout message", async () => {
    const runtime = createRuntime();
    const waitPromise = waitForTransportReady(
      {
        label: "test transport",
        timeoutMs: 120,
        logAfterMs: 0,
        logIntervalMs: 50,
        pollIntervalMs: 50,
        runtime,
        check: async () => ({ ok: false, error: null }),
      },
      createDeps(),
    );

    await expect(waitPromise).rejects.toThrow("test transport not ready (unknown error)");
    expect(runtime.error).toHaveBeenCalledTimes(2);
    expect(runtime.error.mock.calls.at(0)?.[0]).toContain("unknown error");
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("not ready after 120ms");
  });

  it("rethrows non-abort sleep failures", async () => {
    const runtime = createRuntime();
    injectedSleepError = new Error("sleep exploded");

    await expect(
      waitForTransportReady(
        {
          label: "test transport",
          timeoutMs: 500,
          pollIntervalMs: 50,
          runtime,
          check: async () => ({ ok: false, error: "still down" }),
        },
        createDeps(),
      ),
    ).rejects.toThrow("sleep exploded");

    expect(runtime.error).not.toHaveBeenCalled();
  });
});

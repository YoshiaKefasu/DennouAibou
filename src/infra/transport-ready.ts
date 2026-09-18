import { danger } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { sleepWithAbort } from "./backoff.js";

export type TransportReadyResult = {
  ok: boolean;
  error?: string | null;
};

export type WaitForTransportReadyParams = {
  label: string;
  timeoutMs: number;
  logAfterMs?: number;
  logIntervalMs?: number;
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  check: () => Promise<TransportReadyResult>;
};

/**
 * Injectable seams for the timer boundary. Tests supply a virtual clock instead
 * of mocking `./backoff.js` and driving vitest fake timers (Bun does not expose
 * `vi.advanceTimersByTimeAsync`).
 */
export type TransportReadyDeps = {
  sleepWithAbort?: typeof sleepWithAbort;
  now?: () => number;
};

export async function waitForTransportReady(
  params: WaitForTransportReadyParams,
  deps: TransportReadyDeps = {},
): Promise<void> {
  const sleep = deps.sleepWithAbort ?? sleepWithAbort;
  const clock = deps.now ?? Date.now;
  const started = clock();
  const timeoutMs = Math.max(0, params.timeoutMs);
  const deadline = started + timeoutMs;
  const logAfterMs = Math.max(0, params.logAfterMs ?? timeoutMs);
  const logIntervalMs = Math.max(1_000, params.logIntervalMs ?? 30_000);
  const pollIntervalMs = Math.max(50, params.pollIntervalMs ?? 150);
  let nextLogAt = started + logAfterMs;
  let lastError: string | null = null;

  while (true) {
    if (params.abortSignal?.aborted) {
      return;
    }
    const res = await params.check();
    if (res.ok) {
      return;
    }
    lastError = res.error ?? null;

    const now = clock();
    if (now >= deadline) {
      break;
    }
    if (now >= nextLogAt) {
      const elapsedMs = now - started;
      params.runtime.error?.(
        danger(`${params.label} not ready after ${elapsedMs}ms (${lastError ?? "unknown error"})`),
      );
      nextLogAt = now + logIntervalMs;
    }

    try {
      await sleep(pollIntervalMs, params.abortSignal);
    } catch (err) {
      if (params.abortSignal?.aborted) {
        return;
      }
      throw err;
    }
  }

  params.runtime.error?.(
    danger(`${params.label} not ready after ${timeoutMs}ms (${lastError ?? "unknown error"})`),
  );
  throw new Error(`${params.label} not ready (${lastError ?? "unknown error"})`);
}

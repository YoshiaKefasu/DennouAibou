import { setTimeout as sleepReal } from "node:timers/promises";
import { sleep } from "../../src/utils.js";

export type PollOptions = {
  timeoutMs?: number;
  intervalMs?: number;
};

export async function pollUntil<T>(
  fn: () => Promise<T | null | undefined>,
  opts: PollOptions = {},
): Promise<T | undefined> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 25;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value !== null && value !== undefined) {
      return value;
    }
    await sleep(intervalMs);
  }

  return undefined;
}

export async function pollUntilAssert(
  assertion: () => void | Promise<void>,
  opts: PollOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 25;
  const start = process.hrtime.bigint();
  let lastError: unknown;

  while (Number(process.hrtime.bigint() - start) / 1_000_000 < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await sleepReal(intervalMs);
  }

  if (lastError !== undefined) {
    throw lastError;
  }
  throw new Error(`Assertion did not pass within ${timeoutMs}ms`);
}

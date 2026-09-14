import { vi } from "vitest";
import { setTestTime } from "./bun-test-mocks.js";

export function useFrozenTime(at: string | number | Date): void {
  vi.useFakeTimers();
  setTestTime(at);
}

export function useRealTime(): void {
  vi.useRealTimers();
}

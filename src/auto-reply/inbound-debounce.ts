import type { OpenClawConfig } from "../config/config.js";
import type { InboundDebounceByProvider } from "../config/types.messages.js";

const resolveMs = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
};

const resolveChannelOverride = (params: {
  byChannel?: InboundDebounceByProvider;
  channel: string;
}): number | undefined => {
  if (!params.byChannel) {
    return undefined;
  }
  return resolveMs(params.byChannel[params.channel]);
};

export function resolveInboundDebounceMs(params: {
  cfg: OpenClawConfig;
  channel: string;
  overrideMs?: number;
}): number {
  const inbound = params.cfg.messages?.inbound;
  const override = resolveMs(params.overrideMs);
  const byChannel = resolveChannelOverride({
    byChannel: inbound?.byChannel,
    channel: params.channel,
  });
  const base = resolveMs(inbound?.debounceMs);
  return override ?? byChannel ?? base ?? 0;
}

type DebounceBuffer<T> = {
  items: T[];
  timeout: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
  releaseReady: () => void;
  readyReleased: boolean;
  task: Promise<void>;
};

const DEFAULT_MAX_TRACKED_KEYS = 2048;

export type InboundDebouncePriority = "immediate" | "normal";

export type InboundDebounceEnqueueOptions = {
  bypassChain?: boolean;
  priority?: InboundDebouncePriority;
};

export type InboundDebounceCreateParams<T> = {
  debounceMs: number;
  maxTrackedKeys?: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  resolveDebounceMs?: (item: T) => number | undefined;
  onFlush: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
};

export function createInboundDebouncer<T>(params: InboundDebounceCreateParams<T>) {
  const buffers = new Map<string, DebounceBuffer<T>>();
  const keyChains = new Map<string, Promise<void>>();
  const defaultDebounceMs = Math.max(0, Math.trunc(params.debounceMs));
  const maxTrackedKeys = Math.max(1, Math.trunc(params.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS));

  const resolveDebounceMs = (item: T) => {
    const resolved = params.resolveDebounceMs?.(item);
    if (typeof resolved !== "number" || !Number.isFinite(resolved)) {
      return defaultDebounceMs;
    }
    return Math.max(0, Math.trunc(resolved));
  };

  const runFlush = async (items: T[]) => {
    try {
      await params.onFlush(items);
    } catch (err) {
      try {
        params.onError?.(err, items);
      } catch {
        // Flush failures are reported via onError, but this helper stays
        // non-throwing so keyed chains can continue processing later items.
      }
    }
  };

  // Tracks keyed flushes that are actively executing onFlush (not merely
  // buffered or queued behind a chain). Callers use isFlushing() to detect a
  // working session that a Steer/interrupt message must overtake instead of
  // joining the serial chain.
  const activeFlushCounts = new Map<string, number>();

  const trackFlush = async (key: string | null | undefined, fn: () => Promise<void>) => {
    if (!key) {
      await fn();
      return;
    }
    activeFlushCounts.set(key, (activeFlushCounts.get(key) ?? 0) + 1);
    try {
      await fn();
    } finally {
      const next = (activeFlushCounts.get(key) ?? 1) - 1;
      if (next <= 0) {
        activeFlushCounts.delete(key);
      } else {
        activeFlushCounts.set(key, next);
      }
    }
  };

  const isFlushing = (key: string) => (activeFlushCounts.get(key) ?? 0) > 0;

  // Bypass is explicit-only: callers pass opts (e.g. { bypassChain: true } for
  // /stop or Steer-to-working-session). Item shape is never sniffed, so a user
  // message that merely mentions "bypass" can never hijack the control lane.
  const isBypassEnqueue = (opts?: InboundDebounceEnqueueOptions): boolean => {
    return opts?.bypassChain === true || opts?.priority === "immediate";
  };

  const enqueueKeyTask = (key: string, task: () => Promise<void>) => {
    const previous = keyChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const settled = next.catch(() => undefined);
    keyChains.set(key, settled);
    void settled.finally(() => {
      if (keyChains.get(key) === settled) {
        keyChains.delete(key);
      }
    });
    return next;
  };

  const enqueueReservedKeyTask = (key: string, task: () => Promise<void>) => {
    let readyReleased = false;
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    return {
      task: enqueueKeyTask(key, async () => {
        await ready;
        await task();
      }),
      release: () => {
        if (readyReleased) {
          return;
        }
        readyReleased = true;
        releaseReady();
      },
    };
  };

  const releaseBuffer = (buffer: DebounceBuffer<T>) => {
    if (buffer.readyReleased) {
      return;
    }
    buffer.readyReleased = true;
    buffer.releaseReady();
  };

  const flushBuffer = async (key: string, buffer: DebounceBuffer<T>) => {
    if (buffers.get(key) === buffer) {
      buffers.delete(key);
    }
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
    // Reserve each key's execution slot as soon as the first buffered item
    // arrives, so later same-key work cannot overtake a timer-backed flush.
    releaseBuffer(buffer);
    await buffer.task;
  };

  const flushKey = async (key: string) => {
    const buffer = buffers.get(key);
    if (!buffer) {
      return;
    }
    await flushBuffer(key, buffer);
  };

  const scheduleFlush = (key: string, buffer: DebounceBuffer<T>) => {
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
    }
    buffer.timeout = setTimeout(async () => {
      await flushBuffer(key, buffer);
    }, buffer.debounceMs);
    buffer.timeout.unref?.();
  };

  const canTrackKey = (key: string) => {
    if (buffers.has(key) || keyChains.has(key)) {
      return true;
    }
    return new Set([...buffers.keys(), ...keyChains.keys()]).size < maxTrackedKeys;
  };

  const enqueue = async (item: T, opts?: InboundDebounceEnqueueOptions) => {
    const key = params.buildKey(item);
    if (isBypassEnqueue(opts)) {
      // Direct bypass: never join keyChains, never touch pending buffers.
      // Dispatches immediately as an independent task so /stop and Steer
      // messages overtake a running agent instead of queueing behind it.
      await trackFlush(key, () => runFlush([item]));
      return;
    }
    const debounceMs = resolveDebounceMs(item);
    const canDebounce = debounceMs > 0 && (params.shouldDebounce?.(item) ?? true);

    if (!canDebounce || !key) {
      if (key) {
        if (buffers.has(key)) {
          // Reserve the keyed immediate slot before forcing the pending buffer
          // to flush so fire-and-forget callers cannot be overtaken.
          const reservedTask = enqueueReservedKeyTask(key, async () => {
            await trackFlush(key, () => runFlush([item]));
          });
          try {
            await flushKey(key);
          } finally {
            reservedTask.release();
          }
          await reservedTask.task;
          return;
        }
        if (keyChains.has(key)) {
          await enqueueKeyTask(key, async () => {
            await trackFlush(key, () => runFlush([item]));
          });
          return;
        }
        await trackFlush(key, () => runFlush([item]));
      } else {
        await runFlush([item]);
      }
      return;
    }

    const existing = buffers.get(key);
    if (existing) {
      existing.items.push(item);
      existing.debounceMs = debounceMs;
      scheduleFlush(key, existing);
      return;
    }
    if (!canTrackKey(key)) {
      // When the debounce map is saturated, fall back to immediate keyed work
      // instead of buffering, but still preserve same-key ordering.
      await enqueueKeyTask(key, async () => {
        await trackFlush(key, () => runFlush([item]));
      });
      return;
    }

    let buffer!: DebounceBuffer<T>;
    const reservedTask = enqueueReservedKeyTask(key, async () => {
      if (buffer.items.length === 0) {
        return;
      }
      await trackFlush(key, () => runFlush(buffer.items));
    });
    buffer = {
      items: [item],
      timeout: null,
      debounceMs,
      releaseReady: reservedTask.release,
      readyReleased: false,
      task: reservedTask.task,
    };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
  };

  return { enqueue, flushKey, isFlushing };
}

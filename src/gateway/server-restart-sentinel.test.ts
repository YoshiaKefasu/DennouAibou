import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { parseSessionThreadInfo } from "../config/sessions/thread-info.js";
import { consumeRestartSentinel } from "../infra/restart-sentinel.js";
import {
  scheduleRestartSentinelWake,
  type RestartSentinelDeps,
} from "./server-restart-sentinel.js";
import { loadSessionEntry } from "./session-utils.js";

const mocks = {
  resolveSessionAgentId: vi.fn(() => "agent-from-key"),
  consumeRestartSentinel: vi.fn<typeof consumeRestartSentinel>(async () => ({
    version: 1,
    payload: {
      kind: "restart",
      status: "ok",
      ts: 0,
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
      },
    },
  })),
  formatRestartSentinelMessage: vi.fn(() => "restart message"),
  summarizeRestartSentinel: vi.fn(() => "restart summary"),
  resolveMainSessionKeyFromConfig: vi.fn(() => "agent:main:main"),
  parseSessionThreadInfo: vi.fn<typeof parseSessionThreadInfo>(() => ({
    baseSessionKey: undefined,
    threadId: undefined,
  })),
  loadSessionEntry: vi.fn<typeof loadSessionEntry>(() => ({
    cfg: {},
    storePath: "/tmp/sessions.json",
    store: {},
    entry: { sessionId: "sentinel-session", updatedAt: 0 },
    canonicalKey: "agent:main:main",
    legacyKey: undefined,
  })),
  resolveAnnounceTargetFromKey: vi.fn(() => null),
  deliveryContextFromSession: vi.fn(() => undefined),
  mergeDeliveryContext: vi.fn((a?: Record<string, unknown>, b?: Record<string, unknown>) => ({
    ...b,
    ...a,
  })),
  getChannelPlugin: vi.fn(() => undefined),
  normalizeChannelId: vi.fn<typeof normalizeChannelId>((channel) => channel ?? null),
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "+15550002" })),
  deliverOutboundPayloads: vi.fn(async () => [{ channel: "whatsapp", messageId: "msg-1" }]),
  enqueueDelivery: vi.fn(async () => "queue-1"),
  ackDelivery: vi.fn(async () => {}),
  failDelivery: vi.fn(async () => {}),
  enqueueSystemEvent: vi.fn(),
  requestWakeNow: vi.fn(),
  logWarn: vi.fn(),
};

async function advanceRetryTimerForBun(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await Promise.resolve();
  }
  vi.advanceTimersByTime(750);
  for (let round = 0; round < 8; round += 1) {
    await Promise.resolve();
  }
}

const restartDeps: RestartSentinelDeps = {
  resolveMainSessionKeyFromConfig: mocks.resolveMainSessionKeyFromConfig,
  consumeRestartSentinel: mocks.consumeRestartSentinel,
  formatRestartSentinelMessage: mocks.formatRestartSentinelMessage,
  summarizeRestartSentinel: mocks.summarizeRestartSentinel,
  parseSessionThreadInfo: mocks.parseSessionThreadInfo,
  loadSessionEntry: mocks.loadSessionEntry,
  resolveAnnounceTargetFromKey: mocks.resolveAnnounceTargetFromKey,
  deliveryContextFromSession: mocks.deliveryContextFromSession,
  mergeDeliveryContext: mocks.mergeDeliveryContext,
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: mocks.normalizeChannelId,
  resolveOutboundTarget: mocks.resolveOutboundTarget,
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  enqueueDelivery: mocks.enqueueDelivery,
  ackDelivery: mocks.ackDelivery,
  failDelivery: mocks.failDelivery,
  enqueueSystemEvent: mocks.enqueueSystemEvent,
  requestWakeNow: mocks.requestWakeNow,
  buildOutboundSessionContext: () => ({ key: "agent:main:main", agentId: "agent-from-key" }),
  log: { warn: mocks.logWarn },
};

describe("scheduleRestartSentinelWake", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.consumeRestartSentinel.mockResolvedValue({
      version: 1,
      payload: {
        kind: "restart",
        status: "ok",
        ts: 0,
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
        },
      },
    });
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "whatsapp", messageId: "msg-1" }]);
    mocks.enqueueDelivery.mockReset();
    mocks.enqueueDelivery.mockResolvedValue("queue-1");
    mocks.ackDelivery.mockClear();
    mocks.failDelivery.mockClear();
    mocks.enqueueSystemEvent.mockClear();
    mocks.requestWakeNow.mockClear();
    mocks.logWarn.mockClear();
  });

  it("enqueues the sentinel note and wakes the session even when outbound delivery succeeds", async () => {
    const deps = {} as never;

    await scheduleRestartSentinelWake({ deps }, restartDeps);

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        to: "+15550002",
        session: { key: "agent:main:main", agentId: "agent-from-key" },
        deps,
        bestEffort: false,
        skipQueue: true,
      }),
    );
    expect(mocks.enqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        to: "+15550002",
        payloads: [{ text: "restart message" }],
        bestEffort: false,
      }),
    );
    expect(mocks.ackDelivery).toHaveBeenCalledWith("queue-1");
    expect(mocks.failDelivery).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "restart message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
      }),
    );
    expect(mocks.requestWakeNow).toHaveBeenCalledWith({
      reason: "wake",
      sessionKey: "agent:main:main",
    });
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("retries outbound delivery once and logs a warning without dropping the agent wake", async () => {
    vi.useFakeTimers();
    mocks.deliverOutboundPayloads
      .mockRejectedValueOnce(new Error("transport not ready"))
      .mockResolvedValueOnce([{ channel: "whatsapp", messageId: "msg-2" }]);

    const wakePromise = scheduleRestartSentinelWake({ deps: {} as never }, restartDeps);
    if (typeof vi.runAllTimersAsync === "function") {
      await vi.runAllTimersAsync();
    } else {
      await advanceRetryTimerForBun();
    }
    await wakePromise;

    expect(mocks.enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    expect(mocks.deliverOutboundPayloads).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        skipQueue: true,
      }),
    );
    expect(mocks.deliverOutboundPayloads).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        skipQueue: true,
      }),
    );
    expect(mocks.ackDelivery).toHaveBeenCalledWith("queue-1");
    expect(mocks.failDelivery).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.requestWakeNow).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("retrying in 750ms"),
      expect.objectContaining({
        channel: "whatsapp",
        to: "+15550002",
        sessionKey: "agent:main:main",
        attempt: 1,
        maxAttempts: 2,
      }),
    );
  });

  it("keeps one queued restart notice when outbound retries are exhausted", async () => {
    vi.useFakeTimers();
    mocks.deliverOutboundPayloads
      .mockRejectedValueOnce(new Error("transport not ready"))
      .mockRejectedValueOnce(new Error("transport still not ready"));

    const wakePromise = scheduleRestartSentinelWake({ deps: {} as never }, restartDeps);
    if (typeof vi.runAllTimersAsync === "function") {
      await vi.runAllTimersAsync();
    } else {
      await advanceRetryTimerForBun();
    }
    await wakePromise;

    expect(mocks.enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    expect(mocks.ackDelivery).not.toHaveBeenCalled();
    expect(mocks.failDelivery).toHaveBeenCalledWith("queue-1", "transport still not ready");
  });

  it("prefers top-level sentinel threadId for wake routing context", async () => {
    // Legacy or malformed sentinel JSON can still carry a nested threadId.
    mocks.consumeRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
          threadId: "stale-thread",
        } as never,
        threadId: "fresh-thread",
      },
    } as unknown as Awaited<ReturnType<typeof mocks.consumeRestartSentinel>>);

    await scheduleRestartSentinelWake({ deps: {} as never }, restartDeps);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "restart message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        deliveryContext: expect.objectContaining({
          threadId: "fresh-thread",
        }),
      }),
    );
  });

  it("does not wake the main session when the sentinel has no sessionKey", async () => {
    mocks.consumeRestartSentinel.mockResolvedValue({
      payload: {
        message: "restart message",
      },
    } as unknown as Awaited<ReturnType<typeof mocks.consumeRestartSentinel>>);

    await scheduleRestartSentinelWake({ deps: {} as never }, restartDeps);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("restart message", {
      sessionKey: "agent:main:main",
    });
    expect(mocks.requestWakeNow).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });
});

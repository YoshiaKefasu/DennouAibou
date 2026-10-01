import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { releasePinnedPluginChannelRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  hasPendingWake,
  hasWakeHandler,
  isCronSystemEvent,
  requestWakeNow,
  resetWakeStateForTests,
  runEventPumpOnce,
  setWakeHandler,
} from "./event-pump.js";
import { setDeliverDepsForTest } from "./outbound/deliver.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

const testConfig = {} as OpenClawConfig;

describe("event-pump", () => {
  function setRetryOnceWakeHandler() {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: "requests-in-flight" })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setWakeHandler(handler);
    return handler;
  }

  async function expectRetryAfterDefaultDelay(params: {
    handler: ReturnType<typeof vi.fn>;
    initialReason: string;
    expectedRetryReason: string;
  }) {
    setWakeHandler(params.handler as unknown as Parameters<typeof setWakeHandler>[0]);
    requestWakeNow({ reason: params.initialReason, coalesceMs: 0 });

    await vi.advanceTimersByTimeAsync(1);
    expect(params.handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(params.handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(params.handler).toHaveBeenCalledTimes(2);
    expect(params.handler.mock.calls[1]?.[0]).toEqual({ reason: params.expectedRetryReason });
  }

  beforeEach(() => {
    resetWakeStateForTests();
    resetSystemEventsForTest();
  });

  afterEach(() => {
    resetWakeStateForTests();
    resetSystemEventsForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("coalesces multiple wake requests into one run", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "skipped", reason: "disabled" });
    setWakeHandler(handler);

    requestWakeNow({ reason: "normal", coalesceMs: 200 });
    requestWakeNow({ reason: "exec-event", coalesceMs: 200 });
    requestWakeNow({ reason: "retry", coalesceMs: 200 });

    expect(hasPendingWake()).toBe(true);

    await vi.advanceTimersByTimeAsync(199);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ reason: "exec-event" });
    expect(hasPendingWake()).toBe(false);
  });

  it("retries requests-in-flight after the default retry delay", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: "requests-in-flight" })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    await expectRetryAfterDefaultDelay({
      handler,
      initialReason: "normal",
      expectedRetryReason: "normal",
    });
  });

  it("keeps retry cooldown even when a sooner request arrives", async () => {
    vi.useFakeTimers();
    const handler = setRetryOnceWakeHandler();

    requestWakeNow({ reason: "normal", coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);

    requestWakeNow({ reason: "hook:wake", coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(998);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toEqual({ reason: "hook:wake" });
  });

  it("retries thrown handler errors after the default retry delay", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "skipped", reason: "disabled" });
    await expectRetryAfterDefaultDelay({
      handler,
      initialReason: "exec-event",
      expectedRetryReason: "exec-event",
    });
  });

  it("stale disposer does not clear a newer handler", async () => {
    vi.useFakeTimers();
    const handlerA = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const disposeA = setWakeHandler(handlerA);
    expect(hasWakeHandler()).toBe(true);

    const disposeB = setWakeHandler(handlerB);
    expect(hasWakeHandler()).toBe(true);

    disposeA();
    expect(hasWakeHandler()).toBe(true);

    requestWakeNow({ reason: "manual", coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledTimes(1);

    disposeB();
    expect(hasWakeHandler()).toBe(false);
  });

  describe("noise filter", () => {
    it("filters heartbeat noise and allows real events", () => {
      expect(isCronSystemEvent("heartbeat poll: pending")).toBe(false);
      expect(isCronSystemEvent("heartbeat wake complete")).toBe(false);
      expect(isCronSystemEvent("HEARTBEAT_OK")).toBe(false);
      expect(isCronSystemEvent("heartbeat_oklahoma")).toBe(true);
      expect(isCronSystemEvent("Reminder: check status")).toBe(true);
    });
  });

  describe("runEventPumpOnce", () => {
    it("skips when no system events are pending", async () => {
      const res = await runEventPumpOnce({
        cfg: testConfig,
        sessionKey: "agent:main:default",
      });
      expect(res).toEqual({ status: "skipped", reason: "no-events" });
    });

    it("processes pending system events and returns ran", async () => {
      enqueueSystemEvent("Cron reminder: check server", {
        sessionKey: "agent:main:default",
        contextKey: "cron:job-1",
      });

      const getReplyFromConfig = vi.fn().mockResolvedValue({
        text: "I checked the server.",
      });

      const res = await runEventPumpOnce({
        cfg: testConfig,
        sessionKey: "agent:main:default",
        reason: "cron:job-1",
        deps: {
          getReplyFromConfig,
          nowMs: () => 1000,
        },
      });

      expect(res.status).toBe("ran");
      expect(getReplyFromConfig).toHaveBeenCalled();
    });

    it("relays reminder to user when heartbeat.target=last is passed even if config heartbeat.target is unset", async () => {
      const cfgWithoutHeartbeatTarget: OpenClawConfig = {
        agents: {
          defaults: {},
        },
      };

      enqueueSystemEvent("Check server status", {
        sessionKey: "agent:main:default",
        contextKey: "cron:job-relay",
        deliveryContext: {
          channel: "telegram",
          to: "chat-123",
        },
      });

      const getReplyFromConfig = vi.fn().mockResolvedValue({
        text: "Relaying update",
      });

      const res = await runEventPumpOnce({
        cfg: cfgWithoutHeartbeatTarget,
        sessionKey: "agent:main:default",
        reason: "cron:job-relay",
        heartbeat: { target: "last" },
        deps: {
          getReplyFromConfig,
          nowMs: () => 1000,
        },
      });

      expect(res.status).toBe("ran");
      expect(getReplyFromConfig).toHaveBeenCalled();
      const callCtx = getReplyFromConfig.mock.calls[0]?.[0];
      expect(callCtx.Body).toContain("Please relay this reminder to the user");
      expect(callCtx.Body).not.toContain("Handle this reminder internally");
    });

    it("falls back to main session when subagent session key is passed", async () => {
      enqueueSystemEvent("Main session reminder", {
        sessionKey: "agent:main:main",
        contextKey: "cron:job-2",
      });

      const getReplyFromConfig = vi.fn().mockResolvedValue({
        text: "Done",
      });

      const res = await runEventPumpOnce({
        cfg: testConfig,
        sessionKey: "agent:main:subagent:child",
        reason: "cron:job-2",
        deps: {
          getReplyFromConfig,
          nowMs: () => 1000,
        },
      });

      expect(res.status).toBe("ran");
      expect(getReplyFromConfig).toHaveBeenCalled();
      const callCtx = getReplyFromConfig.mock.calls[0]?.[0];
      expect(callCtx.SessionKey).toBe("agent:main:main");
    });
  });

  describe("sequential block delivery", () => {
    const emptyRegistry = createEmptyPluginRegistry();
    const sendText = vi.fn(async ({ text }: { text: string }) => ({
      channel: "telegram" as const,
      messageId: `tg:${text}`,
    }));

    beforeEach(() => {
      sendText.mockClear();
      sendText.mockImplementation(async ({ text }: { text: string }) => ({
        channel: "telegram" as const,
        messageId: `tg:${text}`,
      }));
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "telegram",
              outbound: {
                deliveryMode: "direct",
                sendText,
              },
            }),
          },
        ]),
      );
      setDeliverDepsForTest({
        getGlobalHookRunner: () => null,
        enqueueDelivery: async () => "mock-queue-id",
        ackDelivery: async () => {},
        failDelivery: async () => {},
      });
    });

    afterEach(() => {
      setDeliverDepsForTest();
      releasePinnedPluginChannelRegistry();
      setActivePluginRegistry(emptyRegistry);
    });

    function enqueueAlarmEvent() {
      enqueueSystemEvent("【電脳アラーム発火 (ID: alarm_1)】タスク: 声かけて", {
        sessionKey: "agent:main:main",
        contextKey: "alarm:alarm_1",
        deliveryContext: { channel: "telegram", to: "chat-123" },
      });
    }

    it("streams each block reply live and skips duplicates in the final sweep", async () => {
      enqueueAlarmEvent();
      const order: string[] = [];
      const getReplyFromConfig = vi.fn(
        async (
          _ctx: unknown,
          opts?: { onBlockReply?: (p: { text?: string }) => Promise<void> | void },
        ) => {
          await opts?.onBlockReply?.({ text: "今からやるね" });
          order.push("block1-sent");
          await opts?.onBlockReply?.({ text: "完了したよ" });
          order.push("block2-sent");
          order.push("final-returned");
          return [{ text: "今からやるね" }, { text: "完了したよ" }];
        },
      );

      const res = await runEventPumpOnce({
        cfg: testConfig,
        sessionKey: "agent:main:main",
        reason: "alarm:alarm_1",
        heartbeat: { target: "last" },
        deps: { getReplyFromConfig, nowMs: () => 1000 },
      });

      expect(res.status).toBe("ran");
      // Each block arrives live, in order, before the final sweep runs.
      expect(order).toEqual(["block1-sent", "block2-sent", "final-returned"]);
      // Already-streamed payloads are not re-delivered in the final sweep.
      expect(sendText).toHaveBeenCalledTimes(2);
      expect(sendText).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ text: "今からやるね" }),
      );
      expect(sendText).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: "完了したよ" }));
    });

    it("delivers the final payload when nothing was streamed live", async () => {
      enqueueAlarmEvent();
      const getReplyFromConfig = vi.fn(async () => [{ text: "まとめて報告" }]);

      const res = await runEventPumpOnce({
        cfg: testConfig,
        sessionKey: "agent:main:main",
        reason: "alarm:alarm_1",
        heartbeat: { target: "last" },
        deps: { getReplyFromConfig, nowMs: () => 1000 },
      });

      expect(res.status).toBe("ran");
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ text: "まとめて報告" }));
    });
  });
});

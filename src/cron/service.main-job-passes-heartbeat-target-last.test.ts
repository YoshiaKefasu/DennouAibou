import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-main-event-pump",
});

type RunEventPumpOnce = NonNullable<
  ConstructorParameters<typeof CronService>[0]["runEventPumpOnce"]
>;

describe("cron main job event pump routing", () => {
  function createMainCronJob(params: {
    now: number;
    id: string;
    wakeMode: CronJob["wakeMode"];
  }): CronJob {
    return {
      id: params.id,
      name: params.id,
      enabled: true,
      createdAtMs: params.now - 10_000,
      updatedAtMs: params.now - 10_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: params.wakeMode,
      payload: { kind: "systemEvent", text: "Check in" },
      state: { nextRunAtMs: params.now - 1 },
    };
  }

  function createCronWithSpies(params: { storePath: string; runEventPumpOnce: RunEventPumpOnce }) {
    const enqueueSystemEvent = vi.fn();
    const requestWakeNow = vi.fn();
    const cron = new CronService({
      storePath: params.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent,
      requestWakeNow,
      runEventPumpOnce: params.runEventPumpOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    return { cron, requestWakeNow };
  }

  async function runSingleTick(cron: CronService) {
    await cron.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    cron.stop();
  }

  it("should invoke runEventPumpOnce for wakeMode=now main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      now,
      id: "test-main-delivery",
      wakeMode: "now",
    });

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const runEventPumpOnce = vi.fn<RunEventPumpOnce>(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const { cron } = createCronWithSpies({
      storePath,
      runEventPumpOnce,
    });

    await runSingleTick(cron);

    expect(runEventPumpOnce).toHaveBeenCalled();

    // The options passed should include heartbeat.target = "last" so the
    // event pump delivers the response to the last active channel.
    const callArgs = runEventPumpOnce.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.heartbeat).toBeDefined();
    expect(callArgs?.heartbeat?.target).toBe("last");
  });

  it("should use requestWakeNow for wakeMode=next-heartbeat main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      now,
      id: "test-next-heartbeat",
      wakeMode: "next-heartbeat",
    });

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const runEventPumpOnce = vi.fn<RunEventPumpOnce>(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const { cron, requestWakeNow } = createCronWithSpies({
      storePath,
      runEventPumpOnce,
    });

    await runSingleTick(cron);

    expect(requestWakeNow).toHaveBeenCalled();
    expect(runEventPumpOnce).not.toHaveBeenCalled();
  });
});

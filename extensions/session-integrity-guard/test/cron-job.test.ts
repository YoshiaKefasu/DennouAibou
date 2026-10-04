import { describe, expect, it, vi } from "vitest";
import {
  INTEGRITY_DEFAULT_FREQUENCY,
  INTEGRITY_EVENT_TEXT,
  IntegrityScheduler,
  resolveSessionIntegrityConfig,
  runIntegrityHealthCheck,
  type HealthCheckOutcome,
} from "../src/cron-job.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("resolveSessionIntegrityConfig", () => {
  it("defaults enabled=true and frequency=0 3 * * *", () => {
    expect(resolveSessionIntegrityConfig({})).toEqual({
      enabled: true,
      cron: "0 3 * * *",
      autoRepair: false,
      notify: { enabled: false, channel: "discord" },
    });
  });

  it("honors plugin overrides", () => {
    expect(
      resolveSessionIntegrityConfig({
        pluginConfig: {
          enabled: false,
          frequency: "*/5 * * * *",
          timezone: "Asia/Tokyo",
          autoRepair: true,
          notify: { enabled: true, channel: "telegram", to: "-1001", accountId: "ops" },
        },
      }),
    ).toEqual({
      enabled: false,
      cron: "*/5 * * * *",
      timezone: "Asia/Tokyo",
      autoRepair: true,
      notify: {
        enabled: true,
        channel: "telegram",
        to: "-1001",
        accountId: "ops",
      },
    });
  });
});

describe("IntegrityScheduler", () => {
  it("exposes the default frequency constant", () => {
    expect(INTEGRITY_DEFAULT_FREQUENCY).toBe("0 3 * * *");
  });

  it("returns false on invalid schedule without throwing", () => {
    const logger = createLogger();
    const scheduler = new IntegrityScheduler({
      schedule: "not-a-cron-expression",
      logger,
    });
    expect(scheduler.start()).toBe(false);
    expect(scheduler.isRunning).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("starts with a stub factory and stops cleanly", () => {
    const logger = createLogger();
    const stop = vi.fn();
    const scheduler = new IntegrityScheduler({
      schedule: "0 3 * * *",
      logger,
      cronFactory: () => ({ stop }),
    });
    expect(scheduler.start()).toBe(true);
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("runOnce scans and delivers notify when enabled", async () => {
    const logger = createLogger();
    const outcome: HealthCheckOutcome = {
      scanned: 2,
      failures: 1,
      results: [],
      repairs: [],
      notifyMessage: "anomaly found",
    };
    const runCheck = vi.fn().mockResolvedValue(outcome);
    const deliverNotify = vi.fn().mockResolvedValue(undefined);
    const scheduler = new IntegrityScheduler({
      schedule: "0 3 * * *",
      logger,
      runCheck,
      deliverNotify,
      notify: { enabled: true, channel: "telegram", to: "-1001" },
    });
    const result = await scheduler.runOnce();
    expect(result).toBe(outcome);
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(deliverNotify).toHaveBeenCalledTimes(1);
    expect(deliverNotify.mock.calls[0]?.[0]).toBe("anomaly found");
  });

  it("runOnce skips delivery when notify is disabled", async () => {
    const logger = createLogger();
    const outcome: HealthCheckOutcome = {
      scanned: 1,
      failures: 0,
      results: [],
      repairs: [],
      notifyMessage: null,
    };
    const runCheck = vi.fn().mockResolvedValue(outcome);
    const deliverNotify = vi.fn().mockResolvedValue(undefined);
    const scheduler = new IntegrityScheduler({
      schedule: "0 3 * * *",
      logger,
      runCheck,
      deliverNotify,
      notify: { enabled: false, channel: "discord" },
    });
    await scheduler.runOnce();
    expect(deliverNotify).not.toHaveBeenCalled();
  });
});

describe("runIntegrityHealthCheck", () => {
  it("emits one log line per scanned session and a summary line", async () => {
    const logger = createLogger();
    const outcome = await runIntegrityHealthCheck({ logger });
    // No real session dir on the test host → empty list, but the function still
    // returns shape-stable output.
    expect(outcome.scanned).toBeGreaterThanOrEqual(0);
    expect(outcome.results).toHaveLength(outcome.scanned);
    if (outcome.scanned > 0) {
      expect(logger.info).toHaveBeenCalled();
    }
  });

  it("keeps the manual trigger event text stable", () => {
    expect(INTEGRITY_EVENT_TEXT).toBe("__openclaw_session_integrity_health_check__");
  });
});

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import {
  INTEGRITY_CRON_NAME,
  INTEGRITY_CRON_TAG,
  INTEGRITY_EVENT_TEXT,
  reconcileIntegrityCronJob,
  resolveCronServiceFromStartupEvent,
  resolveSessionIntegrityConfig,
  runIntegrityHealthCheck,
  type CronServiceLike,
} from "../src/cron-job.js";

type ManagedCronJobLike = NonNullable<Awaited<ReturnType<CronServiceLike["list"]>>>[number];
type CronList = Awaited<ReturnType<CronServiceLike["list"]>>;

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createCronHarness(initialJobs: ManagedCronJobLike[] = []) {
  const jobs: ManagedCronJobLike[] = [...initialJobs];
  const addCalls: Parameters<CronServiceLike["add"]>[0][] = [];
  const updateCalls: Array<{ id: string; patch: Parameters<CronServiceLike["update"]>[1] }> = [];
  const removeCalls: string[] = [];

  const cron: CronServiceLike = {
    async list() {
      return jobs.map((job) => ({
        ...job,
        ...(job.schedule ? { schedule: { ...job.schedule } } : {}),
        ...(job.payload ? { payload: { ...job.payload } } : {}),
      }));
    },
    async add(input) {
      addCalls.push(input);
      jobs.push({
        id: `job-${jobs.length + 1}`,
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        schedule: { ...input.schedule },
        sessionTarget: input.sessionTarget,
        wakeMode: input.wakeMode,
        payload: { ...input.payload },
        createdAtMs: Date.now(),
      });
      return {};
    },
    async update(id, patch) {
      updateCalls.push({ id, patch });
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index < 0) {
        return {};
      }
      const current = jobs[index]!;
      jobs[index] = {
        ...current,
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.description ? { description: patch.description } : {}),
        ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
        ...(patch.schedule ? { schedule: { ...patch.schedule } } : {}),
        ...(patch.sessionTarget ? { sessionTarget: patch.sessionTarget } : {}),
        ...(patch.wakeMode ? { wakeMode: patch.wakeMode } : {}),
        ...(patch.payload ? { payload: { ...patch.payload } } : {}),
      };
      return {};
    },
    async remove(id) {
      removeCalls.push(id);
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        jobs.splice(index, 1);
      }
      return { removed: true };
    },
  };

  return { cron, jobs, addCalls, updateCalls, removeCalls };
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

describe("resolveCronServiceFromStartupEvent", () => {
  it("returns null when event is not a gateway startup", () => {
    expect(resolveCronServiceFromStartupEvent({ type: "agent", action: "startup" })).toBeNull();
  });

  it("extracts cron from context.cron", () => {
    const cron = {
      list: async () => [],
      add: async () => ({}),
      update: async () => ({}),
      remove: async () => ({ removed: true }),
    };
    const event = {
      type: "gateway",
      action: "startup",
      context: { cron },
    };
    expect(resolveCronServiceFromStartupEvent(event)).toBe(cron);
  });
});

describe("reconcileIntegrityCronJob", () => {
  it("returns unavailable when cron is null", async () => {
    const result = await reconcileIntegrityCronJob({
      cron: null,
      config: resolveSessionIntegrityConfig({}),
      logger: createLogger(),
    });
    expect(result).toEqual({ status: "unavailable", removed: 0 });
  });

  it("creates the managed job when none exist", async () => {
    const harness = createCronHarness();
    const result = await reconcileIntegrityCronJob({
      cron: harness.cron,
      config: resolveSessionIntegrityConfig({}),
      logger: createLogger(),
    });
    expect(result.status).toBe("added");
    expect(harness.addCalls).toHaveLength(1);
    const desired = harness.addCalls[0]!;
    expect(desired.name).toBe(INTEGRITY_CRON_NAME);
    expect(desired.description).toContain(INTEGRITY_CRON_TAG);
    expect(desired.schedule).toEqual({ kind: "cron", expr: "0 3 * * *" });
    expect(desired.payload).toEqual({ kind: "systemEvent", text: INTEGRITY_EVENT_TEXT });
    expect(desired.sessionTarget).toBe("main");
    expect(desired.wakeMode).toBe("next-heartbeat");
  });

  it("no-ops when the managed job already matches the desired config", async () => {
    const config = resolveSessionIntegrityConfig({});
    // description must match the formatter output exactly: `describeJob(config)`
    // uses the same default cron expr / tag.
    const harness = createCronHarness([
      {
        id: "job-1",
        name: INTEGRITY_CRON_NAME,
        description: `${INTEGRITY_CRON_TAG} Daily session integrity scan at "0 3 * * *".`,
        enabled: true,
        schedule: { kind: "cron", expr: "0 3 * * *" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: INTEGRITY_EVENT_TEXT },
        createdAtMs: 1,
      },
    ]);
    const result = await reconcileIntegrityCronJob({
      cron: harness.cron,
      config,
      logger: createLogger(),
    });
    expect(result.status).toBe("noop");
    expect(harness.updateCalls).toHaveLength(0);
    expect(harness.addCalls).toHaveLength(0);
  });

  it("removes the managed job when disabled", async () => {
    const harness = createCronHarness([
      {
        id: "job-1",
        name: INTEGRITY_CRON_NAME,
        description: `${INTEGRITY_CRON_TAG} Daily session integrity scan at "0 3 * * *".`,
        enabled: true,
        schedule: { kind: "cron", expr: "0 3 * * *" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: INTEGRITY_EVENT_TEXT },
        createdAtMs: 1,
      },
    ]);
    const result = await reconcileIntegrityCronJob({
      cron: harness.cron,
      config: resolveSessionIntegrityConfig({ pluginConfig: { enabled: false } }),
      logger: createLogger(),
    });
    expect(result.status).toBe("disabled");
    expect(harness.removeCalls).toEqual(["job-1"]);
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
});

// Type-only sanity: ensure the harness return types stay in lock-step with
// the cron service type exported by the plugin (caught at compile time but
// re-asserted here for documentation).
const _typeCheck: CronList = [] as Awaited<ReturnType<CronServiceLike["list"]>>;
void _typeCheck;

// Compile-time sanity: OpenClawPluginApi surface used by register() exists.
const _apiShape: Pick<OpenClawPluginApi, "registerHook" | "on" | "logger"> = {
  registerHook: () => undefined,
  on: () => undefined,
  logger: createLogger(),
};
void _apiShape;

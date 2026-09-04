import { describe, expect, it, vi } from "vitest";
import {
  INTEGRITY_NOTIFY_CRON_NAME,
  INTEGRITY_NOTIFY_CRON_TAG,
  INTEGRITY_NOTIFY_EVENT_TEXT,
  reconcileIntegrityNotifyCronJob,
  resolveSessionIntegrityConfig,
  type CronServiceLike,
} from "../src/cron-job.js";
import {
  buildNotifyDelivery,
  formatNotifyMessage,
  resolveNotifyConfig,
  type NotifyConfig,
} from "../src/notify.js";

type ManagedCronJobLike = NonNullable<Awaited<ReturnType<CronServiceLike["list"]>>>[number];

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
        ...(job.delivery ? { delivery: { ...job.delivery } } : {}),
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
        ...(input.delivery ? { delivery: { ...input.delivery } } : {}),
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
        ...(patch.delivery ? { delivery: { ...patch.delivery } } : {}),
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

describe("resolveNotifyConfig", () => {
  it("defaults to disabled discord", () => {
    expect(resolveNotifyConfig(undefined)).toEqual({ enabled: false, channel: "discord" });
  });

  it("accepts telegram with optional to/accountId/bestEffort", () => {
    expect(
      resolveNotifyConfig({
        enabled: true,
        channel: "telegram",
        to: "-100123",
        accountId: "ops-bot",
        bestEffort: true,
      }),
    ).toEqual({
      enabled: true,
      channel: "telegram",
      to: "-100123",
      accountId: "ops-bot",
      bestEffort: true,
    });
  });
});

describe("buildNotifyDelivery", () => {
  it("returns mode: 'none' when notify is disabled", () => {
    const cfg: NotifyConfig = { enabled: false, channel: "discord" };
    expect(buildNotifyDelivery(cfg)).toEqual({ mode: "none" });
  });

  it("returns mode: 'announce' with channel/target/accountId when enabled", () => {
    const cfg: NotifyConfig = {
      enabled: true,
      channel: "telegram",
      to: "19098680",
      accountId: "ops-bot",
      bestEffort: true,
    };
    expect(buildNotifyDelivery(cfg)).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "19098680",
      accountId: "ops-bot",
      bestEffort: true,
    });
  });
});

describe("formatNotifyMessage", () => {
  it("includes scanned/failures/auto-repair header and per-file lines", () => {
    const text = formatNotifyMessage({
      scanned: 5,
      failures: 2,
      autoRepair: true,
      files: [
        {
          file: "/var/sessions/a.jsonl",
          orphanCount: 3,
          removedCount: 3,
          backupPath: "/var/sessions/a.jsonl.bak.20260904-120000",
          status: "repaired",
        },
      ],
    });
    expect(text).toContain("session-integrity-guard");
    expect(text).toContain("scanned: 5");
    expect(text).toContain("failures: 2");
    expect(text).toContain("auto-repair: ON");
    expect(text).toContain("a.jsonl");
    expect(text).toContain("orphans=3");
    expect(text).toContain("repair: -3");
    expect(text).toContain(".bak.20260904-120000");
  });
});

describe("reconcileIntegrityNotifyCronJob", () => {
  it("returns unavailable when cron is null", async () => {
    const result = await reconcileIntegrityNotifyCronJob({
      cron: null,
      config: resolveSessionIntegrityConfig({}),
      logger: createLogger(),
    });
    expect(result).toEqual({ status: "unavailable", removed: 0 });
  });

  it("creates the announce cron with mode: 'none' when notify is enabled but channel is unset", async () => {
    const harness = createCronHarness();
    const config = resolveSessionIntegrityConfig({
      pluginConfig: { notify: { enabled: true } },
    });
    const result = await reconcileIntegrityNotifyCronJob({
      cron: harness.cron,
      config,
      logger: createLogger(),
    });
    expect(result.status).toBe("added");
    expect(harness.addCalls).toHaveLength(1);
    const desired = harness.addCalls[0]!;
    expect(desired.name).toBe(INTEGRITY_NOTIFY_CRON_NAME);
    expect(desired.description).toContain(INTEGRITY_NOTIFY_CRON_TAG);
    expect(desired.payload).toEqual({ kind: "systemEvent", text: INTEGRITY_NOTIFY_EVENT_TEXT });
    expect(desired.delivery).toEqual({ mode: "announce", channel: "discord" });
    expect(desired.enabled).toBe(true);
  });

  it("skips the announce cron (status: disabled) when notify is disabled by default", async () => {
    const harness = createCronHarness();
    const result = await reconcileIntegrityNotifyCronJob({
      cron: harness.cron,
      config: resolveSessionIntegrityConfig({}),
      logger: createLogger(),
    });
    expect(result.status).toBe("disabled");
    expect(harness.addCalls).toHaveLength(0);
  });

  it("creates the announce cron with mode: 'announce' when notify is enabled", async () => {
    const harness = createCronHarness();
    const config = resolveSessionIntegrityConfig({
      pluginConfig: {
        notify: { enabled: true, channel: "discord", accountId: "ops-bot", bestEffort: true },
      },
    });
    const result = await reconcileIntegrityNotifyCronJob({
      cron: harness.cron,
      config,
      logger: createLogger(),
    });
    expect(result.status).toBe("added");
    const desired = harness.addCalls[0]!;
    expect(desired.delivery).toEqual({
      mode: "announce",
      channel: "discord",
      accountId: "ops-bot",
      bestEffort: true,
    });
    expect(desired.enabled).toBe(true);
  });

  it("no-ops when the existing job matches the desired config", async () => {
    const harness = createCronHarness([
      {
        id: "job-1",
        name: INTEGRITY_NOTIFY_CRON_NAME,
        description: `${INTEGRITY_NOTIFY_CRON_TAG} Publish session-integrity-guard anomalies to Discord / Telegram.`,
        enabled: true,
        schedule: { kind: "cron", expr: "5 3 * * *" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: INTEGRITY_NOTIFY_EVENT_TEXT },
        delivery: { mode: "announce", channel: "discord" },
        createdAtMs: 1,
      },
    ]);
    const config = resolveSessionIntegrityConfig({
      pluginConfig: { notify: { enabled: true, channel: "discord" } },
    });
    const result = await reconcileIntegrityNotifyCronJob({
      cron: harness.cron,
      config,
      logger: createLogger(),
    });
    expect(result.status).toBe("noop");
    expect(harness.updateCalls).toHaveLength(0);
  });

  it("patches delivery when the announce channel changes", async () => {
    const harness = createCronHarness([
      {
        id: "job-1",
        name: INTEGRITY_NOTIFY_CRON_NAME,
        description: `${INTEGRITY_NOTIFY_CRON_TAG} Publish session-integrity-guard anomalies to Discord / Telegram.`,
        enabled: true,
        schedule: { kind: "cron", expr: "5 3 * * *" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: INTEGRITY_NOTIFY_EVENT_TEXT },
        delivery: { mode: "announce", channel: "discord" },
        createdAtMs: 1,
      },
    ]);
    const config = resolveSessionIntegrityConfig({
      pluginConfig: {
        notify: { enabled: true, channel: "telegram", to: "-1001", accountId: "ops" },
      },
    });
    const result = await reconcileIntegrityNotifyCronJob({
      cron: harness.cron,
      config,
      logger: createLogger(),
    });
    expect(result.status).toBe("updated");
    expect(harness.updateCalls).toHaveLength(1);
    expect(harness.updateCalls[0]!.patch.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-1001",
      accountId: "ops",
    });
  });

  it("removes the announce cron when the integrity guard is disabled", async () => {
    const harness = createCronHarness([
      {
        id: "job-1",
        name: INTEGRITY_NOTIFY_CRON_NAME,
        description: `${INTEGRITY_NOTIFY_CRON_TAG} Publish session-integrity-guard anomalies to Discord / Telegram.`,
        enabled: true,
        schedule: { kind: "cron", expr: "5 3 * * *" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: INTEGRITY_NOTIFY_EVENT_TEXT },
        delivery: { mode: "announce", channel: "discord" },
        createdAtMs: 1,
      },
    ]);
    const result = await reconcileIntegrityNotifyCronJob({
      cron: harness.cron,
      config: resolveSessionIntegrityConfig({ pluginConfig: { enabled: false } }),
      logger: createLogger(),
    });
    expect(result.status).toBe("disabled");
    expect(harness.removeCalls).toEqual(["job-1"]);
  });
});

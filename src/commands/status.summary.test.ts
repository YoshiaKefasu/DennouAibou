import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusSummaryDeps } from "./status.summary.js";
import { getStatusSummary } from "./status.summary.js";

const statusSummaryMocks = {
  hasPotentialConfiguredChannels: vi.fn(() => true),
  buildChannelSummary: vi.fn(async () => ["ok"]),
  resolveLinkChannelContext: vi.fn(async () => undefined),
  listGatewayAgentsBasic: vi.fn(() => ({
    defaultId: "main",
    agents: [{ id: "main" }],
  })),
  peekSystemEvents: vi.fn(() => []),
  resolveRuntimeServiceVersion: vi.fn(() => "2026.3.8"),
};

const statusSummaryRuntimeMock = {
  classifySessionKey: vi.fn(() => "direct"),
  resolveConfiguredStatusModelRef: vi.fn(() => ({
    provider: "openai",
    model: "gpt-5.4",
  })),
  resolveSessionModelRef: vi.fn(() => ({
    provider: "openai",
    model: "gpt-5.4",
  })),
  resolveContextTokensForModel: vi.fn(() => 200_000),
};

const taskMaintenanceModuleMock = {
  getInspectableTaskRegistrySummary: vi.fn(() => ({
    total: 0,
    active: 0,
    terminal: 0,
    failures: 0,
    byStatus: {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      cancelled: 0,
      lost: 0,
    },
    byRuntime: {
      subagent: 0,
      acp: 0,
      cli: 0,
      cron: 0,
    },
  })),
  getInspectableTaskAuditSummary: vi.fn(() => ({
    total: 1,
    warnings: 1,
    errors: 0,
    byCode: {
      stale_queued: 0,
      stale_running: 0,
      lost: 0,
      delivery_failed: 1,
      missing_cleanup: 0,
      inconsistent_timestamps: 0,
    },
  })),
} as unknown as NonNullable<StatusSummaryDeps["taskMaintenanceModule"]>;

function createDeps(): StatusSummaryDeps {
  return {
    statusSummaryRuntime:
      statusSummaryRuntimeMock as unknown as StatusSummaryDeps["statusSummaryRuntime"],
    taskMaintenanceModule: taskMaintenanceModuleMock,
    loadConfig: () => ({}),
    hasPotentialConfiguredChannels: statusSummaryMocks.hasPotentialConfiguredChannels as never,
    resolveLinkChannelContext:
      statusSummaryMocks.resolveLinkChannelContext as unknown as StatusSummaryDeps["resolveLinkChannelContext"],
    buildChannelSummary:
      statusSummaryMocks.buildChannelSummary as unknown as StatusSummaryDeps["buildChannelSummary"],
    listGatewayAgentsBasic:
      statusSummaryMocks.listGatewayAgentsBasic as unknown as StatusSummaryDeps["listGatewayAgentsBasic"],
    peekSystemEvents:
      statusSummaryMocks.peekSystemEvents as unknown as StatusSummaryDeps["peekSystemEvents"],
    resolveRuntimeServiceVersion:
      statusSummaryMocks.resolveRuntimeServiceVersion as unknown as StatusSummaryDeps["resolveRuntimeServiceVersion"],
  };
}

describe("getStatusSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusSummaryMocks.hasPotentialConfiguredChannels.mockReturnValue(true);
    statusSummaryMocks.buildChannelSummary.mockResolvedValue(["ok"]);
  });

  it("includes runtimeVersion in the status payload", async () => {
    const summary = await getStatusSummary({}, createDeps());

    expect(summary.runtimeVersion).toBe("2026.3.8");
    expect(summary.heartbeat.defaultAgentId).toBe("main");
    expect(summary.channelSummary).toEqual(["ok"]);
    expect(summary.tasks.active).toBe(0);
    expect(summary.taskAudit.warnings).toBe(1);
  });

  it("skips channel summary imports when no channels are configured", async () => {
    statusSummaryMocks.hasPotentialConfiguredChannels.mockReturnValue(false);

    const summary = await getStatusSummary({}, createDeps());

    expect(summary.channelSummary).toEqual([]);
    expect(summary.linkChannel).toBeUndefined();
    expect(statusSummaryMocks.buildChannelSummary).not.toHaveBeenCalled();
    expect(statusSummaryMocks.resolveLinkChannelContext).not.toHaveBeenCalled();
  });

  it("does not trigger async context warmup while building status summaries", async () => {
    await getStatusSummary({}, createDeps());

    expect(statusSummaryRuntimeMock.resolveContextTokensForModel as Mock).toHaveBeenCalledWith(
      expect.objectContaining({ allowAsyncLoad: false }),
    );
  });
});

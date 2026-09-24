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

function createDeps(): StatusSummaryDeps {
  return {
    statusSummaryRuntime:
      statusSummaryRuntimeMock as unknown as StatusSummaryDeps["statusSummaryRuntime"],
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

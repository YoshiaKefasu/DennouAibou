import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  bootstrapOutboundChannelPlugin,
  resetOutboundChannelBootstrapStateForTests,
  type OutboundChannelBootstrapDeps,
} from "./channel-bootstrap.runtime.js";
import {
  normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin,
  type OutboundChannelResolutionDeps,
} from "./channel-resolution.js";

// Explicit dependency injection replaces the module-level `vi.mock` calls that
// Bun's runner cannot intercept (partial `vi.mock` drops exports that transitive
// importers need). The bootstrap internals are injected too, so the real caching
// and retry behaviour in `bootstrapOutboundChannelPlugin` stays under test.
const getChannelPluginMock = vi.fn();
const getActivePluginRegistryMock = vi.fn();
const normalizeMessageChannelMock = vi.fn();
const isDeliverableMessageChannelMock = vi.fn();
const getActivePluginChannelRegistryMock = vi.fn();
const getActivePluginChannelRegistryVersionMock = vi.fn();
const applyPluginAutoEnableMock = vi.fn();
const resolveDefaultAgentIdMock = vi.fn();
const resolveAgentWorkspaceDirMock = vi.fn();
const resolveRuntimePluginRegistryMock = vi.fn();

function createDeps(): OutboundChannelResolutionDeps {
  const bootstrapDeps = {
    getActivePluginChannelRegistry: getActivePluginChannelRegistryMock,
    getActivePluginChannelRegistryVersion: getActivePluginChannelRegistryVersionMock,
    applyPluginAutoEnable: applyPluginAutoEnableMock,
    resolveRuntimePluginRegistry: resolveRuntimePluginRegistryMock,
    resolveDefaultAgentId: resolveDefaultAgentIdMock,
    resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  } as unknown as Partial<OutboundChannelBootstrapDeps>;
  return {
    getChannelPlugin:
      getChannelPluginMock as unknown as OutboundChannelResolutionDeps["getChannelPlugin"],
    getActivePluginRegistry:
      getActivePluginRegistryMock as unknown as OutboundChannelResolutionDeps["getActivePluginRegistry"],
    normalizeMessageChannel:
      normalizeMessageChannelMock as unknown as OutboundChannelResolutionDeps["normalizeMessageChannel"],
    isDeliverableMessageChannel:
      isDeliverableMessageChannelMock as unknown as OutboundChannelResolutionDeps["isDeliverableMessageChannel"],
    bootstrapOutboundChannelPlugin: (params) =>
      bootstrapOutboundChannelPlugin(params, bootstrapDeps),
  };
}

function resolveChannel(channel: string, cfg?: OpenClawConfig) {
  return resolveOutboundChannelPlugin({ channel, cfg }, createDeps());
}

function expectBootstrapArgs() {
  expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
    expect.objectContaining({
      config: { autoEnabled: true },
      activationSourceConfig: { channels: {} },
      workspaceDir: "/tmp/workspace",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    }),
  );
}

describe("outbound channel resolution", () => {
  beforeEach(() => {
    getChannelPluginMock.mockReset();
    getActivePluginRegistryMock.mockReset();
    normalizeMessageChannelMock.mockReset();
    isDeliverableMessageChannelMock.mockReset();
    getActivePluginChannelRegistryMock.mockReset();
    getActivePluginChannelRegistryVersionMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolveDefaultAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    resolveRuntimePluginRegistryMock.mockReset();

    normalizeMessageChannelMock.mockImplementation((value?: string | null) =>
      typeof value === "string" ? value.trim().toLowerCase() : undefined,
    );
    isDeliverableMessageChannelMock.mockImplementation((value?: string) =>
      ["telegram", "discord", "slack"].includes(String(value)),
    );
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });
    getActivePluginChannelRegistryMock.mockReturnValue(undefined);
    getActivePluginChannelRegistryVersionMock.mockReturnValue(1);
    applyPluginAutoEnableMock.mockReturnValue({
      config: { autoEnabled: true },
      autoEnabledReasons: {},
    });
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");

    resetOutboundChannelBootstrapStateForTests();
  });

  it.each([
    { input: " Telegram ", expected: "telegram" },
    { input: "unknown", expected: undefined },
    { input: null, expected: undefined },
  ])("normalizes deliverable outbound channel for %j", ({ input, expected }) => {
    expect(normalizeDeliverableOutboundChannel(input, createDeps())).toBe(expected);
  });

  it("returns the already-registered plugin without bootstrapping", () => {
    const plugin = { id: "telegram" };
    getChannelPluginMock.mockReturnValueOnce(plugin);

    expect(resolveChannel("telegram", {} as never)).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("falls back to the active registry when getChannelPlugin misses", () => {
    const plugin = { id: "telegram" };
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin }],
    });

    expect(resolveChannel("telegram", {} as never)).toBe(plugin);
  });

  it("bootstraps plugins once per registry key and returns the newly loaded plugin", () => {
    const plugin = { id: "telegram" };
    getChannelPluginMock.mockReturnValueOnce(undefined).mockReturnValueOnce(plugin);

    expect(resolveChannel("telegram", { channels: {} } as never)).toBe(plugin);
    expectBootstrapArgs();

    getChannelPluginMock.mockReturnValue(undefined);
    resolveChannel("telegram", { channels: {} } as never);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
    expectBootstrapArgs();
  });

  it("bootstraps when the active registry has other channels but not the requested one", () => {
    const plugin = { id: "telegram" };
    getChannelPluginMock.mockReturnValueOnce(undefined).mockReturnValueOnce(plugin);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: { id: "discord" } }],
    });

    expect(resolveChannel("telegram", { channels: {} } as never)).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("retries bootstrap after a transient load failure", () => {
    getChannelPluginMock.mockReturnValue(undefined);
    resolveRuntimePluginRegistryMock.mockImplementationOnce(() => {
      throw new Error("transient");
    });

    expect(resolveChannel("telegram", { channels: {} } as never)).toBeUndefined();

    resolveChannel("telegram", { channels: {} } as never);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(2);
  });

  it("retries bootstrap when the pinned channel registry version changes", () => {
    getChannelPluginMock.mockReturnValue(undefined);

    resolveChannel("telegram", { channels: {} } as never);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);

    getActivePluginChannelRegistryVersionMock.mockReturnValue(2);
    resolveChannel("telegram", { channels: {} } as never);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(2);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listChannelPluginCatalogEntries } from "../channels/plugins/catalog.js";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import type {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./channel-setup/plugin-install.js";
import { channelsRemoveCommand as channelsRemoveCommandImpl } from "./channels.js";
import { channelCommandDeps, configMocks } from "./channels.mock-harness.js";
import {
  createMSTeamsCatalogEntry,
  createMSTeamsDeletePlugin,
} from "./channels.plugin-install.test-helpers.js";
import type { ChannelsRemoveDeps } from "./channels/remove.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const catalogEntriesMock = vi.fn<typeof listChannelPluginCatalogEntries>(() => []);
const ensureInstalledMock = vi.fn<typeof ensureChannelSetupPluginInstalled>(async ({ cfg }) => ({
  cfg,
  installed: true,
}));
const loadSnapshotMock = vi.fn<typeof loadChannelSetupPluginRegistrySnapshotForChannel>(() =>
  createTestRegistry(),
);
const removeDeps: ChannelsRemoveDeps = {
  ...channelCommandDeps,
  resolveInstallableChannelPluginDeps: {
    listChannelPluginCatalogEntries: catalogEntriesMock,
    ensureChannelSetupPluginInstalled: ensureInstalledMock,
    loadChannelSetupPluginRegistrySnapshotForChannel: loadSnapshotMock,
  },
};
const channelsRemoveCommand = (
  opts: Parameters<typeof channelsRemoveCommandImpl>[0],
  runtime: Parameters<typeof channelsRemoveCommandImpl>[1],
  params: Parameters<typeof channelsRemoveCommandImpl>[2],
) => channelsRemoveCommandImpl(opts, runtime, params, removeDeps);

const runtime = createTestRuntime();

describe("channelsRemoveCommand", () => {
  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockClear();
    configMocks.writeConfigFile.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    catalogEntriesMock.mockClear();
    catalogEntriesMock.mockReturnValue([]);
    ensureInstalledMock.mockClear();
    ensureInstalledMock.mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
    }));
    loadSnapshotMock.mockClear();
    loadSnapshotMock.mockReturnValue(createTestRegistry());
    setActivePluginRegistry(createTestRegistry());
  });

  it("removes an external channel account after installing its plugin on demand", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          msteams: {
            enabled: true,
            tenantId: "tenant-1",
          },
        },
      },
      sourceConfig: {
        channels: {
          msteams: {
            enabled: true,
            tenantId: "tenant-1",
          },
        },
      },
    });
    const catalogEntry: ChannelPluginCatalogEntry = createMSTeamsCatalogEntry();
    catalogEntriesMock.mockReturnValue([catalogEntry]);
    const scopedPlugin = createMSTeamsDeletePlugin();
    loadSnapshotMock.mockReturnValueOnce(createTestRegistry()).mockReturnValueOnce(
      createTestRegistry([
        {
          pluginId: "@openclaw/msteams-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );

    await channelsRemoveCommand(
      {
        channel: "msteams",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureInstalledMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: catalogEntry,
      }),
    );
    expect(loadSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "msteams",
        pluginId: "@openclaw/msteams-plugin",
      }),
    );
    expect(configMocks.writeConfigFile).toHaveBeenCalledWith(
      expect.not.objectContaining({
        channels: expect.objectContaining({
          msteams: expect.anything(),
        }),
      }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});

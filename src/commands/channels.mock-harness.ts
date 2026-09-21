import { vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import type { ChannelsAddDeps } from "./channels/add.js";
import type { ChannelsListDeps } from "./channels/list.js";
import type { ChannelsRemoveDeps } from "./channels/remove.js";
import { requireValidConfigFileSnapshot } from "./config-validation.js";

type ConfigModule = typeof import("../config/config.js");

type DeleteTelegramUpdateOffset = (params: { accountId?: string }) => Promise<void>;

const readConfigFileSnapshotMock = vi.fn<ConfigModule["readConfigFileSnapshot"]>();
const writeConfigFileMock = vi.fn<ConfigModule["writeConfigFile"]>(async () => {});
const emptyFileSnapshot: ConfigFileSnapshot = {
  path: "",
  exists: true,
  raw: null,
  parsed: {},
  sourceConfig: {},
  resolved: {},
  valid: true,
  runtimeConfig: {},
  config: {},
  issues: [],
  warnings: [],
  legacyIssues: [],
};
const replaceConfigFileMock = vi.fn<ConfigModule["replaceConfigFile"]>(async (params) => {
  await writeConfigFileMock(params.nextConfig);
  return {
    path: emptyFileSnapshot.path,
    previousHash: null,
    snapshot: emptyFileSnapshot,
    nextConfig: params.nextConfig as OpenClawConfig,
  };
});

export const configMocks: {
  readConfigFileSnapshot: MockFn<ConfigModule["readConfigFileSnapshot"]>;
  writeConfigFile: MockFn<ConfigModule["writeConfigFile"]>;
  replaceConfigFile: MockFn<ConfigModule["replaceConfigFile"]>;
} = {
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
  replaceConfigFile: replaceConfigFileMock,
};

export const channelCommandDeps: ChannelsAddDeps & ChannelsRemoveDeps & ChannelsListDeps = {
  requireValidConfigFileSnapshot: async (runtime) => {
    return await requireValidConfigFileSnapshot(runtime, undefined, {
      readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
    });
  },
  replaceConfigFile: configMocks.replaceConfigFile,
};

export const offsetMocks: {
  deleteTelegramUpdateOffset: MockFn<DeleteTelegramUpdateOffset>;
} = {
  deleteTelegramUpdateOffset: vi.fn<DeleteTelegramUpdateOffset>(async () => {}),
};

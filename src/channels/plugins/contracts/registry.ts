import type { OpenClawConfig } from "../../../config/config.js";
import { loadBundledPluginPublicSurfaceSync } from "../../../test-utils/bundled-plugin-public-surface.js";
import { listBundledChannelPlugins, setBundledChannelRuntime } from "../bundled.js";
import type { ChannelPlugin } from "../types.js";
import { channelPluginSurfaceKeys, type ChannelPluginSurface } from "./manifest.js";

type SurfaceContractEntry = {
  id: string;
  plugin: Pick<
    ChannelPlugin,
    | "id"
    | "actions"
    | "setup"
    | "status"
    | "outbound"
    | "messaging"
    | "threading"
    | "directory"
    | "gateway"
  >;
  surfaces: readonly ChannelPluginSurface[];
};

type ThreadingContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "threading">;
};

type DirectoryContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "directory">;
  coverage: "lookups" | "presence";
  cfg?: OpenClawConfig;
  accountId?: string;
};

type LineContractApi = {
  listLineAccountIds: () => string[];
  resolveDefaultLineAccountId: (cfg: OpenClawConfig) => string | undefined;
  resolveLineAccount: (params: { cfg: OpenClawConfig; accountId?: string }) => unknown;
};

// Register the bundled LINE channel's contract surface so registry-backed
// contract suites resolve its runtime adapters. Loaded through the same Jiti
// (require-path) loader as every other extension artifact in this directory —
// mixing this with a native import() would trip Node's dual-module-graph check
// under the non-isolated vitest runner.
const lineContractApi = loadBundledPluginPublicSurfaceSync<LineContractApi>({
  pluginId: "line",
  artifactBasename: "contract-api.js",
});

setBundledChannelRuntime("line", {
  channel: {
    line: {
      listLineAccountIds: lineContractApi.listLineAccountIds,
      resolveDefaultLineAccountId: lineContractApi.resolveDefaultLineAccountId,
      resolveLineAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) =>
        lineContractApi.resolveLineAccount({ cfg, accountId }),
    },
  },
} as never);

let surfaceContractRegistryCache: SurfaceContractEntry[] | undefined;
let threadingContractRegistryCache: ThreadingContractEntry[] | undefined;
let directoryContractRegistryCache: DirectoryContractEntry[] | undefined;

export function getSurfaceContractRegistry(): SurfaceContractEntry[] {
  surfaceContractRegistryCache ??= listBundledChannelPlugins().map((plugin) => ({
    id: plugin.id,
    plugin,
    surfaces: channelPluginSurfaceKeys.filter((surface) => Boolean(plugin[surface])),
  }));
  return surfaceContractRegistryCache;
}

export function getThreadingContractRegistry(): ThreadingContractEntry[] {
  threadingContractRegistryCache ??= getSurfaceContractRegistry()
    .filter((entry) => entry.surfaces.includes("threading"))
    .map((entry) => ({
      id: entry.id,
      plugin: entry.plugin,
    }));
  return threadingContractRegistryCache;
}

const directoryPresenceOnlyIds = new Set<string>();

export function getDirectoryContractRegistry(): DirectoryContractEntry[] {
  directoryContractRegistryCache ??= getSurfaceContractRegistry()
    .filter((entry) => entry.surfaces.includes("directory"))
    .map((entry) => ({
      id: entry.id,
      plugin: entry.plugin,
      coverage: directoryPresenceOnlyIds.has(entry.id) ? "presence" : "lookups",
    }));
  return directoryContractRegistryCache;
}

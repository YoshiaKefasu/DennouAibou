import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelRegistryCallProbeForTest } from "../runtime.js";
import { assertNoImportTimeSideEffects } from "./testkit.js";

const CHANNEL_REGISTRY_SEAM = "listChannelPlugins()";
const CHANNEL_REGISTRY_WHY =
  "it boots active channel metadata on hot runtime/config import paths and turns cheap module evaluation into plugin registry work.";
const CHANNEL_REGISTRY_FIX =
  "keep the seam behind a lazy getter/runtime boundary so import stays cold and the first real lookup loads once.";

// Observes registry work through src/plugins/runtime.ts: every listChannelPlugins()
// / getChannelPlugin() call funnels into requireActivePluginChannelRegistry(), and
// direct version reads are observed separately.
const listChannelRegistryProbe = vi.fn();
const versionProbe = vi.fn();

const listChannelPlugins = vi.fn(() => [
  {
    id: "signal",
    messaging: {
      defaultMarkdownTableMode: "bullets" as const,
    },
  },
]);
const getActivePluginChannelRegistryVersion = vi.fn(() => 1);

let importSequence = 0;

async function importFresh(pathname: string): Promise<unknown> {
  importSequence += 1;
  return import(`${new URL(pathname, import.meta.url).href}?cold=${importSequence}`);
}

function expectNoChannelRegistryDuringImport(moduleId: string) {
  assertNoImportTimeSideEffects({
    moduleId,
    forbiddenSeam: CHANNEL_REGISTRY_SEAM,
    calls: listChannelRegistryProbe.mock.calls,
    why: CHANNEL_REGISTRY_WHY,
    fixHint: CHANNEL_REGISTRY_FIX,
  });
  expect(versionProbe).not.toHaveBeenCalled();
}

afterEach(() => {
  setChannelRegistryCallProbeForTest(null);
});

describe("runtime import side-effect contracts", () => {
  beforeEach(() => {
    listChannelRegistryProbe.mockClear();
    versionProbe.mockClear();
    listChannelPlugins.mockClear();
    getActivePluginChannelRegistryVersion.mockClear();
    setChannelRegistryCallProbeForTest({
      onRequireActivePluginChannelRegistry: listChannelRegistryProbe,
      onActivePluginChannelRegistryVersion: versionProbe,
    });
  });

  it("keeps config/markdown-tables cold on import", async () => {
    await importFresh("../../config/markdown-tables.ts");

    expectNoChannelRegistryDuringImport("src/config/markdown-tables.ts");
  });

  it("keeps markdown table defaults lazy and memoized after import", async () => {
    const markdownTables = (await importFresh(
      "../../config/markdown-tables.ts",
    )) as typeof import("../../config/markdown-tables.js");

    expectNoChannelRegistryDuringImport("src/config/markdown-tables.ts");

    markdownTables.setMarkdownTableRegistrySourceForTests({
      listChannelPlugins,
      getActivePluginChannelRegistryVersion,
    });

    expect(markdownTables.DEFAULT_TABLE_MODES.get("signal")).toBe("bullets");
    expect(getActivePluginChannelRegistryVersion).toHaveBeenCalled();
    expect(listChannelPlugins).toHaveBeenCalledTimes(1);
    expect(markdownTables.DEFAULT_TABLE_MODES.has("signal")).toBe(true);
    expect(getActivePluginChannelRegistryVersion).toHaveBeenCalled();
    expect(listChannelPlugins).toHaveBeenCalledTimes(1);
  });

  it("keeps plugins/runtime/runtime-channel cold on import", async () => {
    await importFresh("../runtime/runtime-channel.ts");

    expectNoChannelRegistryDuringImport("src/plugins/runtime/runtime-channel.ts");
  });

  it("keeps plugins/runtime/runtime-system cold on import", async () => {
    await importFresh("../runtime/runtime-system.ts");

    expectNoChannelRegistryDuringImport("src/plugins/runtime/runtime-system.ts");
  });

  it("keeps web-search/runtime cold on import", async () => {
    await importFresh("../../web-search/runtime.ts");

    expectNoChannelRegistryDuringImport("src/web-search/runtime.ts");
  });

  it("keeps web-fetch/runtime cold on import", async () => {
    await importFresh("../../web-fetch/runtime.ts");

    expectNoChannelRegistryDuringImport("src/web-fetch/runtime.ts");
  });

  it("keeps plugins/runtime/index cold on import", async () => {
    await importFresh("../runtime/index.ts");

    expectNoChannelRegistryDuringImport("src/plugins/runtime/index.ts");
  });
});

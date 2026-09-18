import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TABLE_MODES,
  resolveMarkdownTableMode,
  setMarkdownTableRegistrySourceForTests,
  type MarkdownTableRegistrySource,
} from "./markdown-tables.js";

const listChannelPlugins = vi.fn(() => [
  { id: "mattermost", messaging: { defaultMarkdownTableMode: "off" as const } },
  { id: "signal", messaging: { defaultMarkdownTableMode: "bullets" as const } },
  { id: "whatsapp", messaging: { defaultMarkdownTableMode: "bullets" as const } },
]);
const getActivePluginChannelRegistryVersion = vi.fn(() => 1);

const registrySource: MarkdownTableRegistrySource = {
  listChannelPlugins,
  getActivePluginChannelRegistryVersion,
};

beforeEach(() => {
  listChannelPlugins.mockClear();
  getActivePluginChannelRegistryVersion.mockClear();
  setMarkdownTableRegistrySourceForTests(registrySource);
});

afterEach(() => {
  setMarkdownTableRegistrySourceForTests(null);
});

describe("DEFAULT_TABLE_MODES", () => {
  it("mattermost mode is off", () => {
    expect(DEFAULT_TABLE_MODES.get("mattermost")).toBe("off");
  });

  it("signal mode is bullets", () => {
    expect(DEFAULT_TABLE_MODES.get("signal")).toBe("bullets");
  });

  it("whatsapp mode is bullets", () => {
    expect(DEFAULT_TABLE_MODES.get("whatsapp")).toBe("bullets");
  });

  it("slack has no special default in this seam-only slice", () => {
    expect(DEFAULT_TABLE_MODES.get("slack")).toBeUndefined();
  });

  it("memoizes the default modes per registry version", () => {
    expect(DEFAULT_TABLE_MODES.get("signal")).toBe("bullets");
    expect(DEFAULT_TABLE_MODES.get("signal")).toBe("bullets");

    expect(listChannelPlugins).toHaveBeenCalledTimes(1);
    expect(getActivePluginChannelRegistryVersion).toHaveBeenCalled();
  });
});

describe("resolveMarkdownTableMode", () => {
  it("defaults to code for slack", () => {
    expect(resolveMarkdownTableMode({ channel: "slack" })).toBe("code");
  });

  it("coerces explicit block mode to code for slack", () => {
    const cfg = { channels: { slack: { markdown: { tables: "block" as const } } } };
    expect(resolveMarkdownTableMode({ cfg, channel: "slack" })).toBe("code");
  });

  it("coerces explicit block mode to code for non-slack channels", () => {
    const cfg = { channels: { telegram: { markdown: { tables: "block" as const } } } };
    expect(resolveMarkdownTableMode({ cfg, channel: "telegram" })).toBe("code");
  });
});

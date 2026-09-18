import { beforeEach, describe, expect, it, vi } from "vitest";
import type { listBundledPluginMetadata as listBundledPluginMetadataType } from "../plugins/bundled-plugin-metadata.js";
import type { BundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";
import { ChannelsSchema, setBundledPluginMetadataSourceForTests } from "./zod-schema.providers.js";

const listBundledPluginMetadataMock = vi.fn<typeof listBundledPluginMetadataType>();

describe("ChannelsSchema bundled runtime loading", () => {
  beforeEach(() => {
    listBundledPluginMetadataMock.mockReset();
    listBundledPluginMetadataMock.mockReturnValue([]);
    setBundledPluginMetadataSourceForTests(listBundledPluginMetadataMock);
  });

  it("skips bundled channel runtime discovery when only core channel keys are present", () => {
    const parsed = ChannelsSchema.parse({
      defaults: {
        groupPolicy: "open",
      },
      modelByChannel: {
        telegram: {
          primary: "gpt-5.4",
        },
      },
    });

    expect(parsed?.defaults?.groupPolicy).toBe("open");
    expect(listBundledPluginMetadataMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        includeChannelConfigs: true,
      }),
    );
  });

  it("loads bundled channel runtime discovery only when plugin-owned channel config is present", () => {
    listBundledPluginMetadataMock.mockReturnValueOnce([
      {
        manifest: {
          channelConfigs: {
            discord: {
              runtime: {
                safeParse: (value: unknown) => ({ success: true, data: value }),
              },
            },
          },
        },
      } as unknown as BundledPluginMetadata,
    ]);

    ChannelsSchema.parse({
      discord: {},
    });

    expect(listBundledPluginMetadataMock.mock.calls).toContainEqual([
      expect.objectContaining({
        includeChannelConfigs: true,
        includeSyntheticChannelConfigs: true,
      }),
    ]);
  });
});

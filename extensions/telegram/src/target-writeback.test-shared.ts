import type { OpenClawConfig } from "openclaw/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;

export const readConfigFileSnapshotForWrite: AsyncUnknownMock = vi.fn();
export const writeConfigFile: AsyncUnknownMock = vi.fn();

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await import("openclaw/plugin-sdk/config-runtime");
  return {
    ...actual,
    readConfigFileSnapshotForWrite,
    writeConfigFile,
  };
});

export function installMaybePersistResolvedTelegramTargetTests(params?: {
  includeGatewayScopeCases?: boolean;
}) {
  describe("maybePersistResolvedTelegramTarget", () => {
    let maybePersistResolvedTelegramTarget: typeof import("./target-writeback.js").maybePersistResolvedTelegramTarget;

    beforeEach(async () => {
      vi.resetModules();
      ({ maybePersistResolvedTelegramTarget } = await import("./target-writeback.js"));
      readConfigFileSnapshotForWrite.mockReset();
      writeConfigFile.mockReset();
    });

    it("skips writeback when target is already numeric", async () => {
      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: "-100123",
        resolvedChatId: "-100123",
      });

      expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    });

    if (params?.includeGatewayScopeCases) {
      it("skips config writeback for gateway callers missing operator.admin", async () => {
        await maybePersistResolvedTelegramTarget({
          cfg: {} as OpenClawConfig,
          rawTarget: "t.me/mychannel",
          resolvedChatId: "-100123",
          gatewayClientScopes: ["operator.write"],
        });

        expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
        expect(writeConfigFile).not.toHaveBeenCalled();
      });

      it("skips config writeback for gateway callers with an empty scope set", async () => {
        await maybePersistResolvedTelegramTarget({
          cfg: {} as OpenClawConfig,
          rawTarget: "t.me/mychannel",
          resolvedChatId: "-100123",
          gatewayClientScopes: [],
        });

        expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
        expect(writeConfigFile).not.toHaveBeenCalled();
      });
    }

    it("writes back matching config targets", async () => {
      readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: {
          config: {
            channels: {
              telegram: {
                defaultTo: "t.me/mychannel",
                accounts: {
                  alerts: {
                    defaultTo: "@mychannel",
                  },
                },
              },
            },
          },
        },
        writeOptions: { expectedConfigPath: "/tmp/dennou-aibou.json" },
      });
      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: "t.me/mychannel",
        resolvedChatId: "-100123",
      });

      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      expect(writeConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: {
            telegram: {
              defaultTo: "-100123",
              accounts: {
                alerts: {
                  defaultTo: "-100123",
                },
              },
            },
          },
        }),
        expect.objectContaining({ expectedConfigPath: "/tmp/dennou-aibou.json" }),
      );
    });

    it("preserves topic suffix style in writeback target", async () => {
      readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: {
          config: {
            channels: {
              telegram: {
                defaultTo: "t.me/mychannel:topic:9",
              },
            },
          },
        },
        writeOptions: {},
      });

      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: "t.me/mychannel:topic:9",
        resolvedChatId: "-100123",
      });

      expect(writeConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: {
            telegram: {
              defaultTo: "-100123:topic:9",
            },
          },
        }),
        expect.any(Object),
      );
    });

    it("matches username targets case-insensitively", async () => {
      readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: {
          config: {
            channels: {
              telegram: {
                defaultTo: "https://t.me/mychannel",
              },
            },
          },
        },
        writeOptions: {},
      });
      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: "@MyChannel",
        resolvedChatId: "-100123",
      });

      expect(writeConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: {
            telegram: {
              defaultTo: "-100123",
            },
          },
        }),
        expect.any(Object),
      );
    });
  });
}

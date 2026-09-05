import { expect } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { requireBundledChannelPlugin } from "../bundled.js";
import type { ChannelPlugin } from "../types.js";

type SetupContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "config" | "setup">;
  cases: Array<{
    name: string;
    cfg: OpenClawConfig;
    accountId?: string;
    input: Record<string, unknown>;
    expectedAccountId?: string;
    expectedValidation?: string | null;
    beforeTest?: () => void;
    assertPatchedConfig?: (cfg: OpenClawConfig) => void;
    assertResolvedAccount?: (account: unknown, cfg: OpenClawConfig) => void;
  }>;
};

type StatusContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "config" | "status">;
  cases: Array<{
    name: string;
    cfg: OpenClawConfig;
    accountId?: string;
    runtime?: Record<string, unknown>;
    probe?: unknown;
    beforeTest?: () => void;
    assertSnapshot?: (snapshot: Record<string, unknown>) => void;
    assertSummary?: (summary: Record<string, unknown>) => void;
  }>;
};

let setupContractRegistryCache: SetupContractEntry[] | undefined;
let statusContractRegistryCache: StatusContractEntry[] | undefined;

export function getSetupContractRegistry(): SetupContractEntry[] {
  setupContractRegistryCache ??= [
    {
      id: "line",
      plugin: requireBundledChannelPlugin("line"),
      cases: [
        {
          name: "default account stores token and secret",
          cfg: {} as OpenClawConfig,
          input: {
            channelAccessToken: "line-token",
            channelSecret: "line-secret",
          },
          expectedAccountId: "default",
          assertPatchedConfig: (cfg) => {
            expect((cfg.channels?.line as { enabled?: boolean } | undefined)?.enabled).toBe(true);
            expect(
              (cfg.channels?.line as { channelAccessToken?: string } | undefined)
                ?.channelAccessToken,
            ).toBe("line-token");
            expect(
              (cfg.channels?.line as { channelSecret?: string } | undefined)?.channelSecret,
            ).toBe("line-secret");
          },
        },
        {
          name: "non-default env setup is rejected",
          cfg: {} as OpenClawConfig,
          accountId: "ops",
          input: {
            useEnv: true,
          },
          expectedAccountId: "ops",
          expectedValidation: "LINE_CHANNEL_ACCESS_TOKEN can only be used for the default account.",
        },
      ],
    },
  ];
  return setupContractRegistryCache;
}

export function getStatusContractRegistry(): StatusContractEntry[] {
  statusContractRegistryCache ??= [
    {
      id: "line",
      plugin: requireBundledChannelPlugin("line"),
      cases: [
        {
          name: "configured account produces a webhook status snapshot",
          cfg: {
            channels: {
              line: {
                enabled: true,
                channelAccessToken: "line-token",
                channelSecret: "line-secret",
              },
            },
          } as OpenClawConfig,
          runtime: {
            accountId: "default",
            running: true,
          },
          probe: { ok: true },
          assertSnapshot: (snapshot) => {
            expect(snapshot.accountId).toBe("default");
            expect(snapshot.enabled).toBe(true);
            expect(snapshot.configured).toBe(true);
            expect(snapshot.mode).toBe("webhook");
          },
        },
      ],
    },
  ];
  return statusContractRegistryCache;
}

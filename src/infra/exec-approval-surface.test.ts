import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasConfiguredExecApprovalDmRoute,
  resolveExecApprovalInitiatingSurfaceState,
  type ExecApprovalSurfaceDeps,
} from "./exec-approval-surface.js";

const loadConfigMock = vi.fn();
const getChannelPluginMock = vi.fn();
const listChannelPluginsMock = vi.fn();
const isDeliverableMessageChannelMock = vi.fn();
const normalizeMessageChannelMock = vi.fn();

function surfaceDeps(): ExecApprovalSurfaceDeps {
  return {
    loadConfig: loadConfigMock,
    getChannelPlugin: getChannelPluginMock,
    listChannelPlugins: listChannelPluginsMock,
    isDeliverableMessageChannel: isDeliverableMessageChannelMock,
    normalizeMessageChannel: normalizeMessageChannelMock,
  };
}

describe("resolveExecApprovalInitiatingSurfaceState", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    getChannelPluginMock.mockReset();
    listChannelPluginsMock.mockReset();
    isDeliverableMessageChannelMock.mockReset();
    normalizeMessageChannelMock.mockReset();
    normalizeMessageChannelMock.mockImplementation((value?: string | null) =>
      typeof value === "string" ? value.trim().toLowerCase() : undefined,
    );
    isDeliverableMessageChannelMock.mockImplementation(
      (value?: string) => value === "slack" || value === "discord" || value === "telegram",
    );
  });

  it.each([
    {
      channel: null,
      expected: {
        kind: "enabled",
        channel: undefined,
        channelLabel: "this platform",
        accountId: undefined,
      },
    },
    {
      channel: "tui",
      expected: {
        kind: "enabled",
        channel: "tui",
        channelLabel: "terminal UI",
        accountId: undefined,
      },
    },
    {
      channel: "webchat",
      expected: {
        kind: "enabled",
        channel: "webchat",
        channelLabel: "Web UI",
        accountId: undefined,
      },
    },
  ])("treats built-in initiating surface %j", ({ channel, expected }) => {
    expect(resolveExecApprovalInitiatingSurfaceState({ channel }, surfaceDeps())).toEqual(expected);
  });

  it("uses the provided cfg for telegram and discord client enablement", () => {
    getChannelPluginMock.mockImplementation((channel: string) =>
      channel === "telegram"
        ? {
            meta: { label: "Telegram" },
            auth: {
              getActionAvailabilityState: () => ({ kind: "enabled" }),
            },
          }
        : channel === "discord"
          ? {
              meta: { label: "Discord" },
              auth: {
                getActionAvailabilityState: () => ({ kind: "disabled" }),
              },
            }
          : undefined,
    );
    const cfg = { channels: {} };

    expect(
      resolveExecApprovalInitiatingSurfaceState(
        {
          channel: "telegram",
          accountId: "main",
          cfg: cfg as never,
        },
        surfaceDeps(),
      ),
    ).toEqual({
      kind: "enabled",
      channel: "telegram",
      channelLabel: "Telegram",
      accountId: "main",
    });
    expect(
      resolveExecApprovalInitiatingSurfaceState(
        {
          channel: "discord",
          accountId: "main",
          cfg: cfg as never,
        },
        surfaceDeps(),
      ),
    ).toEqual({
      kind: "disabled",
      channel: "discord",
      channelLabel: "Discord",
      accountId: "main",
    });

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("reads approval availability from approvalCapability when auth is omitted", () => {
    getChannelPluginMock.mockReturnValue({
      meta: { label: "Discord" },
      approvalCapability: {
        getActionAvailabilityState: () => ({ kind: "disabled" }),
      },
    });

    expect(
      resolveExecApprovalInitiatingSurfaceState(
        {
          channel: "discord",
          accountId: "main",
          cfg: {} as never,
        },
        surfaceDeps(),
      ),
    ).toEqual({
      kind: "disabled",
      channel: "discord",
      channelLabel: "Discord",
      accountId: "main",
    });
  });

  it("loads config lazily when cfg is omitted and marks unsupported channels", () => {
    loadConfigMock.mockReturnValueOnce({ loaded: true });
    getChannelPluginMock.mockImplementation((channel: string) =>
      channel === "telegram"
        ? {
            meta: { label: "Telegram" },
            auth: {
              getActionAvailabilityState: () => ({ kind: "disabled" }),
            },
          }
        : undefined,
    );

    expect(
      resolveExecApprovalInitiatingSurfaceState(
        {
          channel: "telegram",
          accountId: "main",
        },
        surfaceDeps(),
      ),
    ).toEqual({
      kind: "disabled",
      channel: "telegram",
      channelLabel: "Telegram",
      accountId: "main",
    });
    expect(loadConfigMock).toHaveBeenCalledOnce();

    expect(resolveExecApprovalInitiatingSurfaceState({ channel: "signal" }, surfaceDeps())).toEqual(
      {
        kind: "unsupported",
        channel: "signal",
        channelLabel: "Signal",
        accountId: undefined,
      },
    );
  });

  it("treats deliverable chat channels without a custom adapter as enabled", () => {
    expect(resolveExecApprovalInitiatingSurfaceState({ channel: "slack" }, surfaceDeps())).toEqual({
      kind: "enabled",
      channel: "slack",
      channelLabel: "Slack",
      accountId: undefined,
    });
  });
});

describe("hasConfiguredExecApprovalDmRoute", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    getChannelPluginMock.mockReset();
    listChannelPluginsMock.mockReset();
    isDeliverableMessageChannelMock.mockReset();
    normalizeMessageChannelMock.mockReset();
    normalizeMessageChannelMock.mockImplementation((value?: string | null) =>
      typeof value === "string" ? value.trim().toLowerCase() : undefined,
    );
    isDeliverableMessageChannelMock.mockImplementation(
      (value?: string) => value === "slack" || value === "discord" || value === "telegram",
    );
  });

  it.each([
    {
      plugins: [
        {
          approvals: {
            delivery: {
              hasConfiguredDmRoute: () => false,
            },
          },
        },
        {
          approvals: {
            delivery: {
              hasConfiguredDmRoute: () => true,
            },
          },
        },
      ],
      expected: true,
    },
    {
      plugins: [
        {
          approvals: {
            delivery: {
              hasConfiguredDmRoute: () => false,
            },
          },
        },
        {
          approvals: {
            delivery: {
              hasConfiguredDmRoute: () => false,
            },
          },
        },
        {
          approvals: undefined,
        },
      ],
      expected: false,
    },
  ])("reports whether any plugin routes approvals to DM for %j", ({ plugins, expected }) => {
    listChannelPluginsMock.mockReturnValueOnce(plugins);
    expect(hasConfiguredExecApprovalDmRoute({} as never, surfaceDeps())).toBe(expected);
  });

  it("detects DM routes exposed through approvalCapability", () => {
    listChannelPluginsMock.mockReturnValueOnce([
      {
        approvalCapability: {
          delivery: {
            hasConfiguredDmRoute: () => true,
          },
        },
      },
    ]);

    expect(hasConfiguredExecApprovalDmRoute({} as never, surfaceDeps())).toBe(true);
  });

  it("preserves legacy DM routes when approvalCapability only defines auth", () => {
    listChannelPluginsMock.mockReturnValueOnce([
      {
        approvalCapability: {
          authorizeActorAction: () => ({ authorized: true }),
        },
        approvals: {
          delivery: {
            hasConfiguredDmRoute: () => true,
          },
        },
      },
    ]);

    expect(hasConfiguredExecApprovalDmRoute({} as never, surfaceDeps())).toBe(true);
  });
});

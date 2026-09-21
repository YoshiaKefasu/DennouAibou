import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelMessageActionAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../channels/plugins/types.js";
import { resolveCommandSecretRefsViaGateway } from "../cli/command-secret-gateway.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { callGatewayLeastPrivilege, randomIdempotencyKey } from "../gateway/call.js";
import { messageGatewayTesting } from "../infra/outbound/message.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { captureEnv } from "../test-utils/env.js";
import { messageCommand as messageCommandImpl, type MessageCommandOverrides } from "./message.js";

// Explicit dependency injection replaces the module-level `vi.mock` calls
// (Bun cannot intercept ESM imports).

let testConfig: Record<string, unknown> = {};

const applyPluginAutoEnableMock = vi.fn<typeof applyPluginAutoEnable>(({ config }) => ({
  config: config ?? {},
  changes: [],
  autoEnabledReasons: {},
}));

const resolveCommandSecretRefsViaGatewayMock = vi.fn<typeof resolveCommandSecretRefsViaGateway>(
  async ({ config }) => ({
    resolvedConfig: config,
    diagnostics: [],
    targetStatesByPath: {},
    hadUnresolvedTargets: false,
  }),
);

// A generic-bound `vi.fn` cannot satisfy the gateway runtime module's generic
// call signature, so the test runtime uses a typed stub with call tracking.
type CallGatewayLeastPrivilegeOpts = Parameters<typeof callGatewayLeastPrivilege>[0];
const callGatewayCalls: CallGatewayLeastPrivilegeOpts[] = [];
const callGatewayResponses: unknown[] = [];
const callGatewayLeastPrivilegeStub = async <T = Record<string, unknown>>(
  opts: CallGatewayLeastPrivilegeOpts,
): Promise<T> => {
  callGatewayCalls.push(opts);
  return callGatewayResponses.shift() as T;
};
const randomIdempotencyKeyMock = vi.fn<typeof randomIdempotencyKey>(() => "idem-1-1-1-1");

const handleDiscordAction = vi.fn<
  (input: Record<string, unknown>, cfg: unknown) => Promise<{ details: { ok: boolean } }>
>(async () => ({
  details: { ok: true },
}));

const handleTelegramAction = vi.fn<
  (input: Record<string, unknown>, cfg: unknown) => Promise<{ details: { ok: boolean } }>
>(async () => ({
  details: { ok: true },
}));

const commandOverrides: MessageCommandOverrides = {
  loadConfig: () => testConfig as OpenClawConfig,
  applyPluginAutoEnable: applyPluginAutoEnableMock,
  resolveCommandSecretRefsViaGateway: resolveCommandSecretRefsViaGatewayMock,
};

const messageCommand = (
  opts: Parameters<typeof messageCommandImpl>[0],
  deps: Parameters<typeof messageCommandImpl>[1],
  runtime: Parameters<typeof messageCommandImpl>[2],
) => messageCommandImpl(opts, deps, runtime, commandOverrides);

let envSnapshot: ReturnType<typeof captureEnv>;
const EMPTY_TEST_REGISTRY = createTestRegistry([]);

beforeAll(() => {
  messageGatewayTesting.setRuntimeForTests({
    callGatewayLeastPrivilege: callGatewayLeastPrivilegeStub,
    randomIdempotencyKey: randomIdempotencyKeyMock,
  });
});

afterAll(() => {
  messageGatewayTesting.setRuntimeForTests(null);
});

beforeEach(() => {
  envSnapshot = captureEnv(["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"]);
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.DISCORD_BOT_TOKEN = "";
  testConfig = {};
  setActivePluginRegistry(EMPTY_TEST_REGISTRY);
  callGatewayCalls.length = 0;
  callGatewayResponses.length = 0;
  randomIdempotencyKeyMock.mockClear();
  handleDiscordAction.mockClear();
  handleTelegramAction.mockClear();
  resolveCommandSecretRefsViaGatewayMock.mockClear();
  applyPluginAutoEnableMock.mockClear();
  applyPluginAutoEnableMock.mockImplementation(({ config }) => ({
    config: config ?? {},
    changes: [],
    autoEnabledReasons: {},
  }));
});

afterEach(() => {
  envSnapshot.restore();
});

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const makeDeps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
  sendMessageWhatsApp: vi.fn(),
  sendMessageTelegram: vi.fn(),
  sendMessageDiscord: vi.fn(),
  sendMessageSlack: vi.fn(),
  sendMessageSignal: vi.fn(),
  sendMessageIMessage: vi.fn(),
  ...overrides,
});

const createStubPlugin = (params: {
  id: ChannelPlugin["id"];
  label?: string;
  actions?: ChannelMessageActionAdapter;
  outbound?: ChannelOutboundAdapter;
}): ChannelPlugin => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label ?? String(params.id),
    selectionLabel: params.label ?? String(params.id),
    docsPath: `/channels/${params.id}`,
    blurb: "test stub.",
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({}),
    isConfigured: async () => true,
  },
  actions: params.actions,
  outbound: params.outbound,
});

type ChannelActionParams = Parameters<
  NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>
>[0];

const createDiscordPollPluginRegistration = () => ({
  pluginId: "discord",
  source: "test",
  plugin: createStubPlugin({
    id: "discord",
    label: "Discord",
    actions: {
      describeMessageTool: () => ({ actions: ["poll"] }),
      handleAction: (async ({ action, params, cfg, accountId }: ChannelActionParams) => {
        return await handleDiscordAction(
          { action, to: params.to, accountId: accountId ?? undefined },
          cfg,
        );
      }) as unknown as NonNullable<ChannelPlugin["actions"]>["handleAction"],
    },
  }),
});

const createTelegramSendPluginRegistration = () => ({
  pluginId: "telegram",
  source: "test",
  plugin: createStubPlugin({
    id: "telegram",
    label: "Telegram",
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
      handleAction: (async ({ action, params, cfg, accountId }: ChannelActionParams) => {
        return await handleTelegramAction(
          { action, to: params.to, accountId: accountId ?? undefined },
          cfg,
        );
      }) as unknown as NonNullable<ChannelPlugin["actions"]>["handleAction"],
    },
  }),
});

const createTelegramPollPluginRegistration = () => ({
  pluginId: "telegram",
  source: "test",
  plugin: createStubPlugin({
    id: "telegram",
    label: "Telegram",
    actions: {
      describeMessageTool: () => ({ actions: ["poll"] }),
      handleAction: (async ({ action, params, cfg, accountId }: ChannelActionParams) => {
        return await handleTelegramAction(
          { action, to: params.to, accountId: accountId ?? undefined },
          cfg,
        );
      }) as unknown as NonNullable<ChannelPlugin["actions"]>["handleAction"],
    },
  }),
});

function createTelegramSecretRawConfig() {
  return {
    channels: {
      telegram: {
        token: { $secret: "vault://telegram/token" }, // pragma: allowlist secret
      },
    },
  };
}

function createTelegramResolvedTokenConfig(token: string) {
  return {
    channels: {
      telegram: {
        token,
      },
    },
  };
}

function mockResolvedCommandConfig(params: {
  rawConfig: Record<string, unknown>;
  resolvedConfig: Record<string, unknown>;
  diagnostics?: string[];
}) {
  testConfig = params.rawConfig;
  resolveCommandSecretRefsViaGatewayMock.mockResolvedValueOnce({
    resolvedConfig: params.resolvedConfig as OpenClawConfig,
    diagnostics: params.diagnostics ?? ["resolved channels.telegram.token"],
    targetStatesByPath: {},
    hadUnresolvedTargets: false,
  });
}

async function runTelegramDirectOutboundSend(params: {
  rawConfig: Record<string, unknown>;
  resolvedConfig: Record<string, unknown>;
  diagnostics?: string[];
}) {
  mockResolvedCommandConfig(params);
  const sendText = vi.fn(async (_ctx: { cfg?: unknown; to?: string; text?: string }) => ({
    channel: "telegram" as const,
    messageId: "msg-1",
    chatId: "123456",
  }));
  const sendMedia = vi.fn(async (_ctx: { cfg?: unknown }) => ({
    channel: "telegram" as const,
    messageId: "msg-2",
    chatId: "123456",
  }));
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: createStubPlugin({
          id: "telegram",
          label: "Telegram",
          outbound: {
            deliveryMode: "direct",
            sendText,
            sendMedia,
          },
        }),
      },
    ]),
  );

  const deps = makeDeps();
  await messageCommand(
    {
      action: "send",
      channel: "telegram",
      target: "123456",
      message: "hi",
    },
    deps,
    runtime,
  );

  return { sendText };
}

describe("messageCommand", () => {
  it("threads resolved SecretRef config into outbound send actions", async () => {
    const rawConfig = createTelegramSecretRawConfig();
    const resolvedConfig = createTelegramResolvedTokenConfig("12345:resolved-token");
    mockResolvedCommandConfig({
      rawConfig: rawConfig as unknown as Record<string, unknown>,
      resolvedConfig: resolvedConfig as unknown as Record<string, unknown>,
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createTelegramSendPluginRegistration(),
        },
      ]),
    );

    const deps = makeDeps();
    await messageCommand(
      {
        action: "send",
        channel: "telegram",
        target: "123456",
        message: "hi",
      },
      deps,
      runtime,
    );

    expect(resolveCommandSecretRefsViaGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: rawConfig,
        commandName: "message",
      }),
    );
    const secretResolveCall = resolveCommandSecretRefsViaGatewayMock.mock.calls[0]?.[0] as {
      targetIds?: Set<string>;
    };
    expect(secretResolveCall.targetIds).toBeInstanceOf(Set);
    expect(
      [...(secretResolveCall.targetIds ?? [])].every((id) => id.startsWith("channels.telegram.")),
    ).toBe(true);
    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "send", to: "123456", accountId: undefined }),
      resolvedConfig,
    );
  });

  it("threads resolved SecretRef config into outbound adapter sends", async () => {
    const rawConfig = createTelegramSecretRawConfig();
    const resolvedConfig = createTelegramResolvedTokenConfig("12345:resolved-token");
    const { sendText } = await runTelegramDirectOutboundSend({
      rawConfig: rawConfig as unknown as Record<string, unknown>,
      resolvedConfig: resolvedConfig as unknown as Record<string, unknown>,
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: resolvedConfig,
        to: "123456",
        text: "hi",
      }),
    );
    expect(sendText.mock.calls[0]?.[0]?.cfg).not.toBe(rawConfig);
  });

  it("keeps local-fallback resolved cfg in outbound adapter sends", async () => {
    const rawConfig = {
      channels: {
        telegram: {
          token: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    };
    const locallyResolvedConfig = {
      channels: {
        telegram: {
          token: "12345:local-fallback-token",
        },
      },
    };
    const { sendText } = await runTelegramDirectOutboundSend({
      rawConfig: rawConfig as unknown as Record<string, unknown>,
      resolvedConfig: locallyResolvedConfig as unknown as Record<string, unknown>,
      diagnostics: ["gateway secrets.resolve unavailable; used local resolver fallback."],
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: locallyResolvedConfig,
      }),
    );
    expect(sendText.mock.calls[0]?.[0]?.cfg).not.toBe(rawConfig);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("[secrets] gateway secrets.resolve unavailable"),
    );
  });

  it("defaults channel when only one configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-abc";
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createTelegramSendPluginRegistration(),
        },
      ]),
    );
    const deps = makeDeps();
    await messageCommand(
      {
        target: "123456",
        message: "hi",
      },
      deps,
      runtime,
    );
    expect(handleTelegramAction).toHaveBeenCalled();
  });

  it("defaults channel from the auto-enabled config snapshot when only one channel becomes configured", async () => {
    const rawConfig = {};
    const resolvedConfig = {};
    const autoEnabledConfig = {
      channels: {
        telegram: {
          token: "12345:auto-enabled-token",
        },
      },
      plugins: { allow: ["telegram"] },
    };
    mockResolvedCommandConfig({
      rawConfig,
      resolvedConfig,
      diagnostics: [],
    });
    applyPluginAutoEnableMock.mockReturnValue({
      config: autoEnabledConfig as OpenClawConfig,
      changes: [],
      autoEnabledReasons: {},
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createTelegramSendPluginRegistration(),
        },
      ]),
    );

    const deps = makeDeps();
    await messageCommand(
      {
        target: "123456",
        message: "hi",
      },
      deps,
      runtime,
    );

    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: resolvedConfig,
      env: process.env,
    });
    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "send",
        to: "123456",
      }),
      autoEnabledConfig,
    );
  });

  it("requires channel when multiple configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-abc";
    process.env.DISCORD_BOT_TOKEN = "token-discord";
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createTelegramSendPluginRegistration(),
        },
        {
          ...createDiscordPollPluginRegistration(),
        },
      ]),
    );
    const deps = makeDeps();
    await expect(
      messageCommand(
        {
          target: "123",
          message: "hi",
        },
        deps,
        runtime,
      ),
    ).rejects.toThrow(/Channel is required/);
  });

  it("sends via gateway for WhatsApp", async () => {
    callGatewayResponses.push({ messageId: "g1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: createStubPlugin({
            id: "whatsapp",
            label: "WhatsApp",
            outbound: {
              deliveryMode: "gateway",
            },
          }),
        },
      ]),
    );
    const deps = makeDeps();
    await messageCommand(
      {
        action: "send",
        channel: "whatsapp",
        target: "+15551234567",
        message: "hi",
      },
      deps,
      runtime,
    );
    expect(callGatewayCalls.length).toBeGreaterThan(0);
  });

  it("routes discord polls through message action", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createDiscordPollPluginRegistration(),
        },
      ]),
    );
    const deps = makeDeps();
    await messageCommand(
      {
        action: "poll",
        channel: "discord",
        target: "channel:123456789",
        pollQuestion: "Snack?",
        pollOption: ["Pizza", "Sushi"],
      },
      deps,
      runtime,
    );
    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "poll",
        to: "channel:123456789",
      }),
      expect.any(Object),
    );
  });

  it("routes telegram polls through message action", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createTelegramPollPluginRegistration(),
        },
      ]),
    );
    const deps = makeDeps();
    await messageCommand(
      {
        action: "poll",
        channel: "telegram",
        target: "123456789",
        pollQuestion: "Ship it?",
        pollOption: ["Yes", "No"],
        pollDurationSeconds: 120,
      },
      deps,
      runtime,
    );
    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "poll",
        to: "123456789",
      }),
      expect.any(Object),
    );
  });
});

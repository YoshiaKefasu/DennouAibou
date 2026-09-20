import { EventEmitter } from "node:events";
import { RateLimitError } from "@buape/carbon";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as providerTesting, monitorDiscordProvider } from "./provider.js";

type ProviderTestMocks = {
  clientConstructorOptionsMock: Mock<(options?: unknown) => void>;
  clientFetchUserMock: Mock<(target: string) => Promise<{ id: string }>>;
  clientGetPluginMock: Mock<(name: string) => unknown>;
  clientHandleDeployRequestMock: Mock<() => Promise<void>>;
  createDiscordNativeCommandMock: Mock<(params?: { command?: { name?: string } }) => unknown>;
  createDiscordMessageHandlerMock: Mock<(params?: unknown) => unknown>;
  createdBindingManagers: Array<{ stop: ReturnType<typeof vi.fn> }>;
  createNoopThreadBindingManagerMock: Mock<() => { stop: ReturnType<typeof vi.fn> }>;
  createThreadBindingManagerMock: Mock<() => { stop: ReturnType<typeof vi.fn> }>;
  getPluginCommandSpecsMock: Mock<(provider?: string) => { name: string }[]>;
  listNativeCommandSpecsForConfigMock: Mock<(params?: unknown) => unknown[]>;
  listSkillCommandsForAgentsMock: Mock<(params?: unknown) => unknown[]>;
  monitorLifecycleMock: Mock<(params: { threadBindings: { stop: () => void } }) => Promise<void>>;
  resolveDiscordAccountMock: Mock<(params?: unknown) => unknown>;
  resolveNativeCommandsEnabledMock: Mock<(params?: unknown) => boolean>;
  resolveNativeSkillsEnabledMock: Mock<(params?: unknown) => boolean>;
  isVerboseMock: Mock<() => boolean>;
  shouldLogVerboseMock: Mock<() => boolean>;
  voiceRuntimeModuleLoadedMock: Mock<() => void>;
};

function baseDiscordAccountConfig() {
  return {
    commands: { native: true, nativeSkills: false },
    voice: { enabled: false },
    agentComponents: { enabled: false },
    execApprovals: { enabled: false },
  };
}

function createProviderTestMocks(): ProviderTestMocks {
  const createdBindingManagers: ProviderTestMocks["createdBindingManagers"] = [];
  return {
    clientConstructorOptionsMock: vi.fn(),
    clientFetchUserMock: vi.fn(async (_target: string) => ({ id: "bot-1" })),
    clientGetPluginMock: vi.fn(() => undefined),
    clientHandleDeployRequestMock: vi.fn(async () => undefined),
    createDiscordNativeCommandMock: vi.fn((params?: { command?: { name?: string } }) => ({
      name: params?.command?.name ?? "mock-command",
    })),
    createDiscordMessageHandlerMock: vi.fn(() =>
      Object.assign(
        vi.fn(async () => undefined),
        { deactivate: vi.fn() },
      ),
    ),
    createdBindingManagers,
    createNoopThreadBindingManagerMock: vi.fn(() => {
      const manager = { stop: vi.fn() };
      createdBindingManagers.push(manager);
      return manager;
    }),
    createThreadBindingManagerMock: vi.fn(() => {
      const manager = { stop: vi.fn() };
      createdBindingManagers.push(manager);
      return manager;
    }),
    getPluginCommandSpecsMock: vi.fn(() => []),
    listNativeCommandSpecsForConfigMock: vi.fn(() => [
      { name: "cmd", description: "built-in", acceptsArgs: false },
    ]),
    listSkillCommandsForAgentsMock: vi.fn(() => []),
    monitorLifecycleMock: vi.fn(async (params: { threadBindings: { stop: () => void } }) => {
      params.threadBindings.stop();
    }),
    resolveDiscordAccountMock: vi.fn(() => ({
      accountId: "default",
      token: "cfg-token",
      config: baseDiscordAccountConfig(),
    })),
    resolveNativeCommandsEnabledMock: vi.fn(() => true),
    resolveNativeSkillsEnabledMock: vi.fn(() => false),
    isVerboseMock: vi.fn(() => false),
    shouldLogVerboseMock: vi.fn(() => false),
    voiceRuntimeModuleLoadedMock: vi.fn(),
  };
}

function getFirstDiscordMessageHandlerParams<T extends object>(mocks: ProviderTestMocks) {
  expect(mocks.createDiscordMessageHandlerMock).toHaveBeenCalledTimes(1);
  const firstCall = mocks.createDiscordMessageHandlerMock.mock.calls.at(0) as [T] | undefined;
  return firstCall?.[0];
}

function wireProviderDeps(mocks: ProviderTestMocks) {
  providerTesting.setFetchDiscordApplicationId(async () => "app-1");
  providerTesting.setCreateDiscordNativeCommand(mocks.createDiscordNativeCommandMock as never);
  providerTesting.setRunDiscordGatewayLifecycle(((...args: unknown[]) =>
    mocks.monitorLifecycleMock(
      ...(args as Parameters<typeof mocks.monitorLifecycleMock>),
    )) as Parameters<typeof providerTesting.setRunDiscordGatewayLifecycle>[0]);
  providerTesting.setLoadDiscordVoiceRuntime(async () => {
    mocks.voiceRuntimeModuleLoadedMock();
    return {
      DiscordVoiceManager: class DiscordVoiceManager {},
      DiscordVoiceReadyListener: class DiscordVoiceReadyListener {},
    } as never;
  });
  providerTesting.setLoadDiscordProviderSessionRuntime(
    (async () =>
      ({
        resolveThreadBindingIdleTimeoutMs: () => 24 * 60 * 60 * 1000,
        resolveThreadBindingMaxAgeMs: () => 7 * 24 * 60 * 60 * 1000,
        resolveThreadBindingsEnabled: () => true,
        createDiscordMessageHandler: mocks.createDiscordMessageHandlerMock,
        createNoopThreadBindingManager: mocks.createNoopThreadBindingManagerMock,
        createThreadBindingManager: mocks.createThreadBindingManagerMock,
      }) as never) as NonNullable<
      Parameters<typeof providerTesting.setLoadDiscordProviderSessionRuntime>[0]
    >,
  );
  providerTesting.setCreateClient((options, handlers) => {
    mocks.clientConstructorOptionsMock(options);
    return {
      options,
      listeners: handlers?.listeners ?? [],
      rest: { put: vi.fn(async () => undefined) },
      handleDeployRequest: async () => await mocks.clientHandleDeployRequestMock(),
      fetchUser: async (target: string) => await mocks.clientFetchUserMock(target),
      getPlugin: (name: string) => mocks.clientGetPluginMock(name),
    } as never;
  });
  providerTesting.setCreateDiscordGatewayPlugin((() => ({ id: "gateway-plugin" })) as never);
  providerTesting.setGetPluginCommandSpecs(((provider?: string) =>
    mocks.getPluginCommandSpecsMock(provider)) as never);
  providerTesting.setResolveDiscordAccount(((...args: unknown[]) =>
    mocks.resolveDiscordAccountMock(
      ...(args as Parameters<typeof mocks.resolveDiscordAccountMock>),
    )) as never);
  providerTesting.setResolveNativeCommandsEnabled(((...args: unknown[]) =>
    mocks.resolveNativeCommandsEnabledMock(
      ...(args as Parameters<typeof mocks.resolveNativeCommandsEnabledMock>),
    )) as never);
  providerTesting.setResolveNativeSkillsEnabled(((...args: unknown[]) =>
    mocks.resolveNativeSkillsEnabledMock(
      ...(args as Parameters<typeof mocks.resolveNativeSkillsEnabledMock>),
    )) as never);
  providerTesting.setListNativeCommandSpecsForConfig(((...args: unknown[]) =>
    mocks.listNativeCommandSpecsForConfigMock(
      ...(args as Parameters<typeof mocks.listNativeCommandSpecsForConfigMock>),
    )) as never);
  providerTesting.setListSkillCommandsForAgents(((...args: unknown[]) =>
    mocks.listSkillCommandsForAgentsMock(
      ...(args as Parameters<typeof mocks.listSkillCommandsForAgentsMock>),
    )) as never);
  providerTesting.setIsVerbose(() => mocks.isVerboseMock());
  providerTesting.setShouldLogVerbose(() => mocks.shouldLogVerboseMock());
}

function createCompatRateLimitError(
  response: Response,
  body: { message: string; retry_after: number; global: boolean },
  _request?: Request,
): RateLimitError {
  const RateLimitErrorCtor = RateLimitError as unknown as new (
    response: Response,
    body: { message: string; retry_after: number; global: boolean },
  ) => RateLimitError;
  return new RateLimitErrorCtor(response, body);
}

function createConfigWithDiscordAccount(overrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    channels: {
      discord: {
        accounts: {
          default: {
            token: "MTIz.abc.def",
            ...overrides,
          },
        },
      },
    },
  } as OpenClawConfig;
}

const baseRuntime = (): RuntimeEnv => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
});

const baseConfig = (): OpenClawConfig =>
  ({
    channels: {
      discord: {
        accounts: {
          default: {
            token: "MTIz.abc.def",
          },
        },
      },
    },
  }) as OpenClawConfig;

describe("monitorDiscordProvider", () => {
  let m: ProviderTestMocks;

  const getConstructedEventQueue = (): { listenerTimeout?: number } | undefined => {
    expect(m.clientConstructorOptionsMock).toHaveBeenCalledTimes(1);
    const opts = m.clientConstructorOptionsMock.mock.calls[0]?.[0] as {
      eventQueue?: { listenerTimeout?: number };
    };
    return opts.eventQueue;
  };

  const getConstructedClientOptions = (): {
    eventQueue?: { listenerTimeout?: number };
  } => {
    expect(m.clientConstructorOptionsMock).toHaveBeenCalledTimes(1);
    return (
      (m.clientConstructorOptionsMock.mock.calls[0]?.[0] as {
        eventQueue?: { listenerTimeout?: number };
      }) ?? {}
    );
  };

  beforeEach(() => {
    m = createProviderTestMocks();
    wireProviderDeps(m);
  });

  it("stops thread bindings when startup fails before lifecycle begins", async () => {
    m.createDiscordNativeCommandMock.mockImplementation(() => {
      throw new Error("native command boom");
    });

    await expect(
      monitorDiscordProvider({
        config: baseConfig(),
        runtime: baseRuntime(),
      }),
    ).rejects.toThrow("native command boom");

    expect(m.monitorLifecycleMock).not.toHaveBeenCalled();
    expect(m.createdBindingManagers).toHaveLength(1);
    expect(m.createdBindingManagers[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("disconnects the shared gateway and suppresses late gateway errors when startup fails before lifecycle begins", async () => {
    const disconnect = vi.fn();
    const emitter = new EventEmitter();
    const gateway = { emitter, disconnect, isConnected: false };
    const runtime = baseRuntime();
    m.clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? gateway : undefined,
    );
    m.createDiscordMessageHandlerMock.mockImplementationOnce(() => {
      throw new Error("handler init failed");
    });

    await expect(
      monitorDiscordProvider({
        config: baseConfig(),
        runtime,
      }),
    ).rejects.toThrow("handler init failed");

    expect(m.monitorLifecycleMock).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(() =>
      emitter.emit("error", new Error("Max reconnect attempts (0) reached after code 1005")),
    ).not.toThrow();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("suppressed late gateway reconnect-exhausted error after dispose"),
    );
  });

  it("does not double-stop thread bindings when lifecycle performs cleanup", async () => {
    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(m.monitorLifecycleMock).toHaveBeenCalledTimes(1);
    expect(m.createdBindingManagers).toHaveLength(1);
    expect(m.createdBindingManagers[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("does not load the Discord voice runtime when voice is disabled", async () => {
    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(m.voiceRuntimeModuleLoadedMock).not.toHaveBeenCalled();
  });

  it("loads the Discord voice runtime only when voice is enabled", async () => {
    m.resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "MTIz.abc.def",
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: true },
        agentComponents: { enabled: false },
        execApprovals: { enabled: false },
      },
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(m.voiceRuntimeModuleLoadedMock).toHaveBeenCalledTimes(1);
  });

  it("captures gateway errors emitted before lifecycle wait starts", async () => {
    const emitter = new EventEmitter();
    const drained: Array<{ message: string; type: string }> = [];
    m.clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? { emitter, disconnect: vi.fn() } : undefined,
    );
    m.monitorLifecycleMock.mockImplementationOnce(async (params) => {
      (
        params as {
          gatewaySupervisor?: {
            drainPending: (
              handler: (event: { message: string; type: string }) => "continue" | "stop",
            ) => "continue" | "stop";
          };
          threadBindings: { stop: () => void };
        }
      ).gatewaySupervisor?.drainPending((event) => {
        drained.push(event);
        return "continue";
      });
      params.threadBindings.stop();
    });
    m.clientFetchUserMock.mockImplementationOnce(async () => {
      emitter.emit("error", new Error("Fatal Gateway error: 4014"));
      return { id: "bot-1" };
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(m.monitorLifecycleMock).toHaveBeenCalledTimes(1);
    expect(drained).toHaveLength(1);
    expect(drained[0]?.type).toBe("disallowed-intents");
    expect(drained[0]?.message).toContain("4014");
  });

  it("passes default eventQueue.listenerTimeout of 120s to Carbon Client", async () => {
    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const eventQueue = getConstructedEventQueue();
    expect(eventQueue).toEqual({ listenerTimeout: 120_000 });
  });

  it("forwards custom eventQueue config from discord config to Carbon Client", async () => {
    m.resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "MTIz.abc.def",
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: false },
        agentComponents: { enabled: false },
        execApprovals: { enabled: false },
        eventQueue: { listenerTimeout: 300_000 },
      },
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const eventQueue = getConstructedEventQueue();
    expect(eventQueue?.listenerTimeout).toBe(300_000);
  });

  it("does not reuse eventQueue.listenerTimeout as the queued inbound worker timeout", async () => {
    await monitorDiscordProvider({
      config: createConfigWithDiscordAccount({
        eventQueue: { listenerTimeout: 50_000 },
      }),
      runtime: baseRuntime(),
    });

    const params = getFirstDiscordMessageHandlerParams<{
      workerRunTimeoutMs?: number;
      listenerTimeoutMs?: number;
    }>(m);
    expect(params?.workerRunTimeoutMs).toBeUndefined();
    expect("listenerTimeoutMs" in (params ?? {})).toBe(false);
  });

  it("forwards inbound worker timeout config to the Discord message handler", async () => {
    m.resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "MTIz.abc.def",
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: false },
        agentComponents: { enabled: false },
        execApprovals: { enabled: false },
        inboundWorker: { runTimeoutMs: 300_000 },
      },
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const params = getFirstDiscordMessageHandlerParams<{
      workerRunTimeoutMs?: number;
    }>(m);
    expect(params?.workerRunTimeoutMs).toBe(300_000);
  });

  it("continues startup when Discord daily slash-command create quota is exhausted", async () => {
    const runtime = baseRuntime();
    const request = new Request("https://discord.com/api/v10/applications/commands", {
      method: "PUT",
    });
    const rateLimitError = createCompatRateLimitError(
      new Response(null, {
        status: 429,
        headers: {
          "X-RateLimit-Scope": "shared",
          "X-RateLimit-Bucket": "bucket-1",
        },
      }),
      {
        message: "Max number of daily application command creates has been reached (200)",
        retry_after: 193.632,
        global: false,
      },
      request,
    );
    rateLimitError.discordCode = 30034;
    m.clientHandleDeployRequestMock.mockRejectedValueOnce(rateLimitError);

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime,
    });

    expect(m.clientHandleDeployRequestMock).toHaveBeenCalledTimes(1);
    expect(m.clientFetchUserMock).toHaveBeenCalledWith("@me");
    expect(m.monitorLifecycleMock).toHaveBeenCalledTimes(1);
  });

  it("formats rejected Discord deploy entries with command details", () => {
    const details = providerTesting.formatDiscordDeployErrorDetails({
      status: 400,
      discordCode: 50035,
      rawBody: {
        code: 50035,
        message: "Invalid Form Body",
        errors: {
          63: {
            description: {
              _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 100 or fewer." }],
            },
          },
          65: {
            description: {
              _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 100 or fewer." }],
            },
          },
          66: {
            description: {
              _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 100 or fewer." }],
            },
          },
          67: {
            description: {
              _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 100 or fewer." }],
            },
          },
        },
      },
      deployRequestBody: Array.from({ length: 68 }, (_entry, index) => ({
        name: `command-${index}`,
        description: `description-${index}`,
      })),
    });

    expect(details).toContain("status=400");
    expect(details).toContain("code=50035");
    expect(details).toContain("rejected=");
    expect(details).toContain(
      '#63 fields=description name=command-63 description="description-63"',
    );
    expect(details).toContain(
      '#65 fields=description name=command-65 description="description-65"',
    );
    expect(details).toContain(
      '#66 fields=description name=command-66 description="description-66"',
    );
    expect(details).not.toContain("command-67");
  });

  it("configures Carbon native deploy by default", async () => {
    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(m.clientHandleDeployRequestMock).toHaveBeenCalledTimes(1);
    expect(getConstructedClientOptions().eventQueue?.listenerTimeout).toBe(120_000);
  });

  it("reports connected status on startup and shutdown", async () => {
    const setStatus = vi.fn();
    m.clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? { isConnected: true } : undefined,
    );

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
      setStatus,
    });

    expect(setStatus.mock.calls).toContainEqual([expect.objectContaining({ connected: true })]);
    expect(setStatus.mock.calls).toContainEqual([expect.objectContaining({ connected: false })]);
  });

  it("logs Discord startup phases and early gateway debug events", async () => {
    const runtime = baseRuntime();
    const emitter = new EventEmitter();
    const gateway = { emitter, isConnected: true, reconnectAttempts: 0 };
    m.clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? gateway : undefined,
    );
    m.clientFetchUserMock.mockImplementationOnce(async () => {
      emitter.emit("debug", "Gateway websocket opened");
      return { id: "bot-1", username: "Molty" };
    });
    m.isVerboseMock.mockReturnValue(true);

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime,
    });

    const messages = (runtime.log as Mock).mock.calls.map((call) => String(call[0]));
    expect(messages.some((msg) => msg.includes("fetch-application-id:start"))).toBe(true);
    expect(messages.some((msg) => msg.includes("fetch-application-id:done"))).toBe(true);
    expect(messages.some((msg) => msg.includes("deploy-commands:start"))).toBe(true);
    expect(messages.some((msg) => msg.includes("deploy-commands:done"))).toBe(true);
    expect(messages.some((msg) => msg.includes("fetch-bot-identity:start"))).toBe(true);
    expect(messages.some((msg) => msg.includes("fetch-bot-identity:done"))).toBe(true);
    expect(
      messages.some(
        (msg) => msg.includes("gateway-debug") && msg.includes("Gateway websocket opened"),
      ),
    ).toBe(true);
  });

  it("keeps Discord startup chatter quiet by default", async () => {
    const runtime = baseRuntime();

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime,
    });

    const messages = (runtime.log as Mock).mock.calls.map((call) => String(call[0]));
    expect(messages.some((msg) => msg.includes("discord startup ["))).toBe(false);
  });
});

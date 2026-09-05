import { EventEmitter } from "node:events";
import { RateLimitError } from "@buape/carbon";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseConfig,
  baseRuntime,
  getFirstDiscordMessageHandlerParams,
  getProviderMonitorTestMocks,
  resetDiscordProviderMonitorMocks,
} from "../test-support/provider.test-support.js";

const {
  clientConstructorOptionsMock,
  clientFetchUserMock,
  clientGetPluginMock,
  clientHandleDeployRequestMock,
  createDiscordAutoPresenceControllerMock,
  createDiscordMessageHandlerMock,
  createDiscordNativeCommandMock,
  createdBindingManagers,
  createNoopThreadBindingManagerMock,
  createThreadBindingManagerMock,
  getPluginCommandSpecsMock,
  isVerboseMock,
  listNativeCommandSpecsForConfigMock,
  listSkillCommandsForAgentsMock,
  monitorLifecycleMock,
  resolveDiscordAllowlistConfigMock,
  resolveDiscordAccountMock,
  resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabledMock,
  shouldLogVerboseMock,
  voiceRuntimeModuleLoadedMock,
} = getProviderMonitorTestMocks();

let monitorDiscordProvider: typeof import("./provider.js").monitorDiscordProvider;
let providerTesting: typeof import("./provider.js").__testing;
let runtimeEnvModule: typeof import("openclaw/plugin-sdk/runtime-env");

function createCompatRateLimitError(
  response: Response,
  body: { message: string; retry_after: number; global: boolean },
  request?: Request,
): RateLimitError {
  const compatRequest =
    request ??
    new Request("https://discord.com/api/v10/applications/commands", {
      method: "PUT",
    });
  const RateLimitErrorCtor = RateLimitError as unknown as new (
    response: Response,
    body: { message: string; retry_after: number; global: boolean },
    request?: Request,
  ) => RateLimitError;
  return new RateLimitErrorCtor(response, body, compatRequest);
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

vi.mock("../voice/manager.runtime.js", () => {
  voiceRuntimeModuleLoadedMock();
  return {
    DiscordVoiceManager: class DiscordVoiceManager {},
    DiscordVoiceReadyListener: class DiscordVoiceReadyListener {},
  };
});
describe("monitorDiscordProvider", () => {
  const getConstructedEventQueue = (): { listenerTimeout?: number } | undefined => {
    expect(clientConstructorOptionsMock).toHaveBeenCalledTimes(1);
    const opts = clientConstructorOptionsMock.mock.calls[0]?.[0] as {
      eventQueue?: { listenerTimeout?: number };
    };
    return opts.eventQueue;
  };

  const getConstructedClientOptions = (): {
    eventQueue?: { listenerTimeout?: number };
  } => {
    expect(clientConstructorOptionsMock).toHaveBeenCalledTimes(1);
    return (
      (clientConstructorOptionsMock.mock.calls[0]?.[0] as {
        eventQueue?: { listenerTimeout?: number };
      }) ?? {}
    );
  };

  beforeAll(async () => {
    vi.doMock("openclaw/plugin-sdk/plugin-runtime", async () => {
      const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-runtime")>(
        "openclaw/plugin-sdk/plugin-runtime",
      );
      return {
        ...actual,
        getPluginCommandSpecs: getPluginCommandSpecsMock,
      };
    });
    vi.doMock("../accounts.js", () => ({
      resolveDiscordAccount: (...args: Parameters<typeof resolveDiscordAccountMock>) =>
        resolveDiscordAccountMock(...args),
    }));
    vi.doMock("../probe.js", () => ({
      fetchDiscordApplicationId: async () => "app-1",
    }));
    vi.doMock("../token.js", () => ({
      normalizeDiscordToken: (value?: string) => value,
    }));
    runtimeEnvModule = await import("openclaw/plugin-sdk/runtime-env");
    vi.spyOn(runtimeEnvModule, "logVerbose").mockImplementation(() => undefined);
    ({ monitorDiscordProvider, __testing: providerTesting } = await import("./provider.js"));
  });

  beforeEach(() => {
    resetDiscordProviderMonitorMocks();
    vi.mocked(runtimeEnvModule.logVerbose).mockClear();
    providerTesting.setFetchDiscordApplicationId(async () => "app-1");
    providerTesting.setCreateDiscordNativeCommand(((
      ...args: Parameters<typeof providerTesting.setCreateDiscordNativeCommand>[0] extends
        | ((...inner: infer P) => unknown)
        | undefined
        ? P
        : never
    ) =>
      createDiscordNativeCommandMock(
        ...(args as Parameters<typeof createDiscordNativeCommandMock>),
      )) as NonNullable<Parameters<typeof providerTesting.setCreateDiscordNativeCommand>[0]>);
    providerTesting.setRunDiscordGatewayLifecycle((...args) =>
      monitorLifecycleMock(...(args as Parameters<typeof monitorLifecycleMock>)),
    );
    providerTesting.setLoadDiscordVoiceRuntime(async () => {
      voiceRuntimeModuleLoadedMock();
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
          createDiscordMessageHandler: createDiscordMessageHandlerMock,
          createNoopThreadBindingManager: createNoopThreadBindingManagerMock,
          createThreadBindingManager: createThreadBindingManagerMock,
        }) as never) as NonNullable<
        Parameters<typeof providerTesting.setLoadDiscordProviderSessionRuntime>[0]
      >,
    );
    providerTesting.setCreateClient((options, handlers) => {
      clientConstructorOptionsMock(options);
      return {
        options,
        listeners: handlers.listeners ?? [],
        rest: { put: vi.fn(async () => undefined) },
        handleDeployRequest: async () => await clientHandleDeployRequestMock(),
        fetchUser: async (target: string) => await clientFetchUserMock(target),
        getPlugin: (name: string) => clientGetPluginMock(name),
      } as never;
    });
    providerTesting.setGetPluginCommandSpecs((provider?: string) =>
      getPluginCommandSpecsMock(provider),
    );
    providerTesting.setResolveDiscordAccount(
      (...args) => resolveDiscordAccountMock(...args) as never,
    );
    providerTesting.setResolveNativeCommandsEnabled((...args) =>
      resolveNativeCommandsEnabledMock(...args),
    );
    providerTesting.setResolveNativeSkillsEnabled((...args) =>
      resolveNativeSkillsEnabledMock(...args),
    );
    providerTesting.setListNativeCommandSpecsForConfig((...args) =>
      listNativeCommandSpecsForConfigMock(...args),
    );
    providerTesting.setListSkillCommandsForAgents(
      (...args) => listSkillCommandsForAgentsMock(...args) as never,
    );
    providerTesting.setIsVerbose(() => isVerboseMock());
    providerTesting.setShouldLogVerbose(() => shouldLogVerboseMock());
  });

  it("stops thread bindings when startup fails before lifecycle begins", async () => {
    createDiscordNativeCommandMock.mockImplementation(() => {
      throw new Error("native command boom");
    });

    await expect(
      monitorDiscordProvider({
        config: baseConfig(),
        runtime: baseRuntime(),
      }),
    ).rejects.toThrow("native command boom");

    expect(monitorLifecycleMock).not.toHaveBeenCalled();
    expect(createdBindingManagers).toHaveLength(1);
    expect(createdBindingManagers[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("disconnects the shared gateway and suppresses late gateway errors when startup fails before lifecycle begins", async () => {
    const disconnect = vi.fn();
    const emitter = new EventEmitter();
    const gateway = { emitter, disconnect, isConnected: false };
    const runtime = baseRuntime();
    clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? gateway : undefined,
    );
    createDiscordMessageHandlerMock.mockImplementationOnce(() => {
      throw new Error("handler init failed");
    });

    await expect(
      monitorDiscordProvider({
        config: baseConfig(),
        runtime,
      }),
    ).rejects.toThrow("handler init failed");

    expect(monitorLifecycleMock).not.toHaveBeenCalled();
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

    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
    expect(createdBindingManagers).toHaveLength(1);
    expect(createdBindingManagers[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("does not load the Discord voice runtime when voice is disabled", async () => {
    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(voiceRuntimeModuleLoadedMock).not.toHaveBeenCalled();
  });

  it("loads the Discord voice runtime only when voice is enabled", async () => {
    resolveDiscordAccountMock.mockReturnValue({
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

    expect(voiceRuntimeModuleLoadedMock).toHaveBeenCalledTimes(1);
  });

  it("captures gateway errors emitted before lifecycle wait starts", async () => {
    const emitter = new EventEmitter();
    const drained: Array<{ message: string; type: string }> = [];
    clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? { emitter, disconnect: vi.fn() } : undefined,
    );
    monitorLifecycleMock.mockImplementationOnce(async (params) => {
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
    clientFetchUserMock.mockImplementationOnce(async () => {
      emitter.emit("error", new Error("Fatal Gateway error: 4014"));
      return { id: "bot-1" };
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
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
    resolveDiscordAccountMock.mockReturnValue({
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
    }>();
    expect(params?.workerRunTimeoutMs).toBeUndefined();
    expect("listenerTimeoutMs" in (params ?? {})).toBe(false);
  });

  it("forwards inbound worker timeout config to the Discord message handler", async () => {
    resolveDiscordAccountMock.mockReturnValue({
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
    }>();
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
    clientHandleDeployRequestMock.mockRejectedValueOnce(rateLimitError);

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime,
    });

    expect(clientHandleDeployRequestMock).toHaveBeenCalledTimes(1);
    expect(clientFetchUserMock).toHaveBeenCalledWith("@me");
    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
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

    expect(clientHandleDeployRequestMock).toHaveBeenCalledTimes(1);
    expect(getConstructedClientOptions().eventQueue?.listenerTimeout).toBe(120_000);
  });

  it("reports connected status on startup and shutdown", async () => {
    const setStatus = vi.fn();
    clientGetPluginMock.mockImplementation((name: string) =>
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
    clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? gateway : undefined,
    );
    clientFetchUserMock.mockImplementationOnce(async () => {
      emitter.emit("debug", "Gateway websocket opened");
      return { id: "bot-1", username: "Molty" };
    });
    isVerboseMock.mockReturnValue(true);

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime,
    });

    const messages = vi.mocked(runtime.log).mock.calls.map((call) => String(call[0]));
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

    const messages = vi.mocked(runtime.log).mock.calls.map((call) => String(call[0]));
    expect(messages.some((msg) => msg.includes("discord startup ["))).toBe(false);
  });
});

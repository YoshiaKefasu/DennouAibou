import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  GatewayIntents,
  GatewayOpcodes,
  baseRegisterClientSpy,
  baseSendSpy,
  GatewayPlugin,
  globalFetchMock,
  HttpsProxyAgent,
  getLastAgent,
  restProxyAgentSpy,
  undiciFetchMock,
  undiciProxyAgentSpy,
  resetLastAgent,
  webSocketSpy,
  wsProxyAgentSpy,
} = vi.hoisted(() => {
  const wsProxyAgentSpy = vi.fn();
  const undiciProxyAgentSpy = vi.fn();
  const restProxyAgentSpy = vi.fn();
  const undiciFetchMock = vi.fn();
  const globalFetchMock = vi.fn();
  const baseRegisterClientSpy = vi.fn();
  const baseSendSpy = vi.fn();
  const webSocketSpy = vi.fn();

  const GatewayIntents = {
    Guilds: 1 << 0,
    GuildMessages: 1 << 1,
    MessageContent: 1 << 2,
    DirectMessages: 1 << 3,
    GuildMessageReactions: 1 << 4,
    DirectMessageReactions: 1 << 5,
    GuildPresences: 1 << 6,
    GuildMembers: 1 << 7,
  } as const;

  const GatewayOpcodes = {
    Heartbeat: 1,
    Identify: 2,
    PresenceUpdate: 3,
    Resume: 6,
  } as const;

  class GatewayPlugin {
    options: unknown;
    gatewayInfo: unknown;
    constructor(options?: unknown, gatewayInfo?: unknown) {
      this.options = options;
      this.gatewayInfo = gatewayInfo;
    }
    async registerClient(client: unknown) {
      baseRegisterClientSpy(client);
    }
    send(payload: unknown, skipRateLimit?: boolean) {
      baseSendSpy(payload, skipRateLimit);
    }
  }

  class HttpsProxyAgent {
    static lastCreated: HttpsProxyAgent | undefined;
    proxyUrl: string;
    constructor(proxyUrl: string) {
      if (proxyUrl === "bad-proxy") {
        throw new Error("bad proxy");
      }
      this.proxyUrl = proxyUrl;
      HttpsProxyAgent.lastCreated = this;
      wsProxyAgentSpy(proxyUrl);
    }
  }

  return {
    baseRegisterClientSpy,
    baseSendSpy,
    GatewayIntents,
    GatewayOpcodes,
    GatewayPlugin,
    globalFetchMock,
    HttpsProxyAgent,
    getLastAgent: () => HttpsProxyAgent.lastCreated,
    restProxyAgentSpy,
    undiciFetchMock,
    undiciProxyAgentSpy,
    resetLastAgent: () => {
      HttpsProxyAgent.lastCreated = undefined;
    },
    webSocketSpy,
    wsProxyAgentSpy,
  };
});

// Unit test: don't import Carbon just to check the prototype chain.
vi.mock("@buape/carbon/gateway", () => ({
  GatewayIntents,
  GatewayOpcodes,
  GatewayPlugin,
}));

vi.mock("@buape/carbon/dist/src/plugins/gateway/index.js", () => ({
  GatewayIntents,
  GatewayOpcodes,
  GatewayPlugin,
}));

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent,
}));

describe("createDiscordGatewayPlugin", () => {
  let createDiscordGatewayPlugin: typeof import("./gateway-plugin.js").createDiscordGatewayPlugin;

  beforeAll(async () => {
    ({ createDiscordGatewayPlugin } = await import("./gateway-plugin.js"));
  });

  function createRuntime() {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
  }

  function createProxyTestingOverrides() {
    return {
      HttpsProxyAgentCtor:
        HttpsProxyAgent as unknown as typeof import("https-proxy-agent").HttpsProxyAgent,
      ProxyAgentCtor: class {
        proxyUrl: string;
        constructor(proxyUrl: string) {
          this.proxyUrl = proxyUrl;
          undiciProxyAgentSpy(proxyUrl);
          restProxyAgentSpy(proxyUrl);
        }
      } as unknown as typeof import("undici").ProxyAgent,
      undiciFetch: undiciFetchMock,
      webSocketCtor: class {
        constructor(url: string, options?: { agent?: unknown }) {
          webSocketSpy(url, options);
        }
      } as unknown as new (url: string, options?: { agent?: unknown }) => import("ws").WebSocket,
      registerClient: async (_plugin: unknown, client: unknown) => {
        baseRegisterClientSpy(client);
      },
    };
  }

  async function registerGatewayClient(plugin: unknown) {
    await (
      plugin as {
        registerClient: (client: {
          options: { token: string };
          registerListener: typeof baseRegisterClientSpy;
          unregisterListener: ReturnType<typeof vi.fn>;
        }) => Promise<void>;
      }
    ).registerClient({
      options: { token: "token-123" },
      registerListener: baseRegisterClientSpy,
      unregisterListener: vi.fn(),
    });
  }

  async function expectGatewayRegisterFetchFailure(response: Response) {
    const runtime = createRuntime();
    globalFetchMock.mockResolvedValue(response);
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    await expect(registerGatewayClient(plugin)).rejects.toThrow(
      "Failed to get gateway information from Discord",
    );
    expect(baseRegisterClientSpy).not.toHaveBeenCalled();
  }

  async function expectGatewayRegisterFallback(response: Response) {
    const runtime = createRuntime();
    globalFetchMock.mockResolvedValue(response);
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    await registerGatewayClient(plugin);

    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(1);
    expect((plugin as unknown as { gatewayInfo?: { url?: string } }).gatewayInfo?.url).toBe(
      "wss://gateway.discord.gg/",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("discord: gateway metadata lookup failed transiently"),
    );
  }

  async function registerGatewayClientWithMetadata(params: {
    plugin: unknown;
    fetchMock: typeof globalFetchMock;
  }) {
    params.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ url: "wss://gateway.discord.gg" }),
    } as Response);
    await registerGatewayClient(params.plugin);
  }

  beforeEach(() => {
    setTestGlobal("fetch", globalFetchMock);
    vi.useRealTimers();
    baseRegisterClientSpy.mockClear();
    baseSendSpy.mockClear();
    globalFetchMock.mockClear();
    restProxyAgentSpy.mockClear();
    undiciFetchMock.mockClear();
    undiciProxyAgentSpy.mockClear();
    wsProxyAgentSpy.mockClear();
    webSocketSpy.mockClear();
    resetLastAgent();
  });

  it("uses safe gateway metadata lookup without proxy", async () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    await registerGatewayClientWithMetadata({ plugin, fetchMock: globalFetchMock });

    expect(globalFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/gateway/bot",
      expect.objectContaining({
        headers: { Authorization: "Bot token-123" },
      }),
    );
    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(1);
  });

  function sendGatewayPayload(plugin: unknown, payload: { op: number; d?: unknown }) {
    (plugin as { send: (payload: unknown, skipRateLimit?: boolean) => void }).send(payload, true);
  }

  it("injects the configured presence into the identify payload", () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: { status: "idle", activity: "Reading docs" },
      runtime,
    });

    const payload: { op: number; d?: Record<string, unknown> } = {
      op: GatewayOpcodes.Identify,
      d: { token: "token-123", properties: {}, intents: 1 },
    };
    sendGatewayPayload(plugin, payload);

    expect(baseSendSpy).toHaveBeenCalledTimes(1);
    expect(payload.d?.presence).toEqual({
      since: null,
      activities: [{ name: "Custom Status", type: 4, state: "Reading docs" }],
      status: "idle",
      afk: false,
    });
  });

  it("defaults to an online presence in the identify payload when presence is unconfigured", () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    const payload: { op: number; d?: Record<string, unknown> } = {
      op: GatewayOpcodes.Identify,
      d: { token: "token-123", properties: {}, intents: 1 },
    };
    sendGatewayPayload(plugin, payload);

    expect(payload.d?.presence).toEqual({
      since: null,
      activities: [],
      status: "online",
      afk: false,
    });
  });

  it("leaves non-identify payloads untouched", () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    const presenceUpdate: { op: number; d?: Record<string, unknown> } = {
      op: GatewayOpcodes.PresenceUpdate,
      d: { since: null, activities: [], status: "dnd", afk: false },
    };
    sendGatewayPayload(plugin, presenceUpdate);
    const heartbeat: { op: number; d?: unknown } = { op: GatewayOpcodes.Heartbeat, d: null };
    sendGatewayPayload(plugin, heartbeat);

    expect(baseSendSpy).toHaveBeenCalledTimes(2);
    expect(presenceUpdate.d).toEqual({ since: null, activities: [], status: "dnd", afk: false });
    expect(heartbeat.d).toBeNull();
  });

  it("maps plain-text Discord 503 responses to fetch failed", async () => {
    await expectGatewayRegisterFallback({
      ok: false,
      status: 503,
      text: async () =>
        "upstream connect error or disconnect/reset before headers. reset reason: overflow",
    } as Response);
  });

  it("keeps fatal Discord metadata failures fatal", async () => {
    await expectGatewayRegisterFetchFailure({
      ok: false,
      status: 401,
      text: async () => "401: Unauthorized",
    } as Response);
  });

  it("uses proxy agent for gateway WebSocket when configured", async () => {
    const runtime = createRuntime();

    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://127.0.0.1:8080" },
      runtime,
      __testing: createProxyTestingOverrides(),
    });

    expect(Object.getPrototypeOf(plugin)).not.toBe(GatewayPlugin.prototype);

    const createWebSocket = (plugin as unknown as { createWebSocket: (url: string) => unknown })
      .createWebSocket;
    createWebSocket("wss://gateway.discord.gg");

    expect(wsProxyAgentSpy).toHaveBeenCalledWith("http://127.0.0.1:8080");
    expect(webSocketSpy).toHaveBeenCalledWith(
      "wss://gateway.discord.gg",
      expect.objectContaining({ agent: getLastAgent() }),
    );
    expect(runtime.log).toHaveBeenCalledWith("discord: gateway proxy enabled");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("falls back to the default gateway plugin when proxy is invalid", async () => {
    const runtime = createRuntime();

    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "bad-proxy" },
      runtime,
    });

    expect(Object.getPrototypeOf(plugin)).not.toBe(GatewayPlugin.prototype);
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("uses proxy fetch for gateway metadata lookup before registering", async () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://127.0.0.1:8080" },
      runtime,
      __testing: createProxyTestingOverrides(),
    });

    await registerGatewayClientWithMetadata({ plugin, fetchMock: undiciFetchMock });

    expect(restProxyAgentSpy).toHaveBeenCalledWith("http://127.0.0.1:8080");
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/gateway/bot",
      expect.objectContaining({
        headers: { Authorization: "Bot token-123" },
        dispatcher: expect.objectContaining({ proxyUrl: "http://127.0.0.1:8080" }),
      }),
    );
    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(1);
  });

  it("accepts IPv6 loopback proxy URLs for gateway metadata and websocket setup", async () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://[::1]:8080" },
      runtime,
      __testing: createProxyTestingOverrides(),
    });

    const createWebSocket = (plugin as unknown as { createWebSocket: (url: string) => unknown })
      .createWebSocket;
    createWebSocket("wss://gateway.discord.gg");
    await registerGatewayClientWithMetadata({ plugin, fetchMock: undiciFetchMock });

    expect(wsProxyAgentSpy).toHaveBeenCalledWith("http://[::1]:8080");
    expect(restProxyAgentSpy).toHaveBeenCalledWith("http://[::1]:8080");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("falls back to the default gateway plugin when proxy is remote", async () => {
    const runtime = createRuntime();

    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://proxy.test:8080" },
      runtime,
    });

    expect(Object.getPrototypeOf(plugin)).not.toBe(GatewayPlugin.prototype);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("loopback host"));
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("maps body read failures to fetch failed", async () => {
    await expectGatewayRegisterFallback({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error("body stream closed");
      },
    } as unknown as Response);
  });

  it("falls back to the default gateway url when metadata lookup times out", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    globalFetchMock.mockImplementation(() => new Promise(() => {}));
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    const registerPromise = registerGatewayClient(plugin);
    vi.advanceTimersByTime(10_000);
    await registerPromise;

    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(1);
    expect((plugin as unknown as { gatewayInfo?: { url?: string } }).gatewayInfo?.url).toBe(
      "wss://gateway.discord.gg/",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("discord: gateway metadata lookup failed transiently"),
    );
  });

  it("refreshes fallback gateway metadata on the next register attempt", async () => {
    const runtime = createRuntime();
    globalFetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () =>
          "upstream connect error or disconnect/reset before headers. reset reason: overflow",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            url: "wss://gateway.discord.gg/?v=10",
            shards: 8,
            session_start_limit: {
              total: 1000,
              remaining: 999,
              reset_after: 120_000,
              max_concurrency: 16,
            },
          }),
      } as Response);
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    await registerGatewayClient(plugin);
    await registerGatewayClient(plugin);

    expect(globalFetchMock).toHaveBeenCalledTimes(2);
    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(2);
    expect(
      (plugin as unknown as { gatewayInfo?: { url?: string; shards?: number } }).gatewayInfo,
    ).toMatchObject({
      url: "wss://gateway.discord.gg/?v=10",
      shards: 8,
    });
  });
});

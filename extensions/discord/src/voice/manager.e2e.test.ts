import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createConnectionMock,
  joinVoiceChannelMock,
  entersStateMock,
  createAudioPlayerMock,
  createAudioResourceMock,
  resolveAgentRouteMock,
  agentCommandMock,
  transcribeAudioFileMock,
  fetchWithSsrFGuardMock,
  createSpeechGuardResult,
} = vi.hoisted(() => {
  type EventHandler = (...args: unknown[]) => unknown;
  type MockConnection = {
    destroy: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    receiver: {
      speaking: {
        on: ReturnType<typeof vi.fn>;
        off: ReturnType<typeof vi.fn>;
      };
      subscribe: ReturnType<typeof vi.fn>;
    };
    handlers: Map<string, EventHandler>;
  };

  const createConnectionMock = (): MockConnection => {
    const handlers = new Map<string, EventHandler>();
    const connection: MockConnection = {
      destroy: vi.fn(),
      subscribe: vi.fn(),
      on: vi.fn((event: string, handler: EventHandler) => {
        handlers.set(event, handler);
      }),
      off: vi.fn(),
      receiver: {
        speaking: {
          on: vi.fn(),
          off: vi.fn(),
        },
        subscribe: vi.fn(() => ({
          on: vi.fn(),
          [Symbol.asyncIterator]: async function* () {},
        })),
      },
      handlers,
    };
    return connection;
  };

  const createSpeechGuardResult = (init?: { status?: number; body?: string }) => ({
    response: new Response(init?.body ?? "mp3-bytes", { status: init?.status ?? 200 }),
    finalUrl: "https://openrouter.ai/api/v1/audio/speech",
    release: vi.fn(async () => {}),
  });

  return {
    createConnectionMock,
    createSpeechGuardResult,
    joinVoiceChannelMock: vi.fn(() => createConnectionMock()),
    entersStateMock: vi.fn(async (_target?: unknown, _state?: string, _timeoutMs?: number) => {
      return undefined;
    }),
    createAudioPlayerMock: vi.fn(() => ({
      on: vi.fn(),
      off: vi.fn(),
      stop: vi.fn(),
      play: vi.fn(),
      state: { status: "idle" },
    })),
    createAudioResourceMock: vi.fn((_input?: unknown) => ({ volume: { setVolume: vi.fn() } })),
    resolveAgentRouteMock: vi.fn(() => ({ agentId: "agent-1", sessionKey: "discord:g1:c1" })),
    agentCommandMock: vi.fn(async (_opts?: unknown, _runtime?: unknown) => ({
      payloads: [] as Array<{ text?: string }>,
    })),
    transcribeAudioFileMock: vi.fn(async () => ({ text: "hello from voice" })),
    fetchWithSsrFGuardMock: vi.fn(async (_params?: unknown) => createSpeechGuardResult()),
  };
});

vi.mock("./sdk-runtime.js", () => ({
  loadDiscordVoiceSdk: () => ({
    AudioPlayerStatus: { Playing: "playing", Idle: "idle" },
    EndBehaviorType: { AfterSilence: "AfterSilence" },
    VoiceConnectionStatus: {
      Ready: "ready",
      Disconnected: "disconnected",
      Destroyed: "destroyed",
      Signalling: "signalling",
      Connecting: "connecting",
    },
    createAudioPlayer: createAudioPlayerMock,
    createAudioResource: createAudioResourceMock,
    entersState: entersStateMock,
    joinVoiceChannel: joinVoiceChannelMock,
  }),
}));

// Note: Bun's `vi.mock` factory does not receive `importOriginal`, and a factory that re-imports
// the same specifier deadlocks while the real module is still being evaluated. The voice manager
// only consumes `fetchWithSsrFGuard` / `formatErrorMessage`, so the mock is a plain fake.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  formatErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock("openclaw/plugin-sdk/routing", async () => {
  const actual = await import("openclaw/plugin-sdk/routing");
  return {
    ...actual,
    resolveAgentRoute: resolveAgentRouteMock,
  };
});

vi.mock("openclaw/plugin-sdk/agent-runtime", async () => {
  const actual = await import("openclaw/plugin-sdk/agent-runtime");
  return {
    ...actual,
    agentCommandFromIngress: agentCommandMock,
  };
});

vi.mock("../runtime.js", () => ({
  getDiscordRuntime: () => ({
    mediaUnderstanding: {
      transcribeAudioFile: transcribeAudioFileMock,
    },
  }),
}));

let managerModule: typeof import("./manager.js");

function createClient() {
  return {
    fetchChannel: vi.fn(async (channelId: string) => ({
      id: channelId,
      guildId: "g1",
      guild: { id: "g1", name: "Guild One" },
      type: ChannelType.GuildVoice,
    })),
    fetchGuild: vi.fn(async (guildId: string) => ({
      id: guildId,
      name: "Guild One",
    })),
    getPlugin: vi.fn(() => ({
      getGatewayAdapterCreator: vi.fn(() => vi.fn()),
    })),
    fetchMember: vi.fn(),
    fetchUser: vi.fn(),
    rest: {
      post: vi.fn(async () => ({ id: "m1" })),
    },
  };
}

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

type SessionEntryFixture = {
  guildId: string;
  guildName?: string;
  channelId: string;
  channelName?: string;
  sessionChannelId: string;
  route: { agentId: string; sessionKey: string; mainSessionKey?: string };
  connection: ReturnType<typeof createConnectionMock>;
  player: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    state: { status: string };
  };
  processingQueue: Promise<void>;
  activeSpeakers: Set<string>;
  decryptFailureCount: number;
  lastDecryptFailureAt: number;
  decryptRecoveryInFlight: boolean;
  stop: () => void;
  generation: number;
};

function createSessionEntry(overrides: Partial<SessionEntryFixture> = {}): SessionEntryFixture {
  return {
    guildId: "g1",
    channelId: "1001",
    sessionChannelId: "1001",
    route: {
      agentId: "agent-1",
      sessionKey: "discord:g1:1001",
      mainSessionKey: "agent:main:main",
    },
    connection: createConnectionMock(),
    player: {
      on: vi.fn(),
      off: vi.fn(),
      stop: vi.fn(),
      play: vi.fn(),
      state: { status: "idle" },
    },
    processingQueue: Promise.resolve(),
    activeSpeakers: new Set<string>(),
    decryptFailureCount: 0,
    lastDecryptFailureAt: 0,
    decryptRecoveryInFlight: false,
    stop: vi.fn(),
    generation: 0,
    ...overrides,
  };
}

describe("DiscordVoiceManager", () => {
  let tempDir: string;

  beforeAll(async () => {
    managerModule = await import("./manager.js");
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "discord-voice-e2e-"));
    joinVoiceChannelMock.mockReset();
    joinVoiceChannelMock.mockImplementation(() => createConnectionMock());
    entersStateMock.mockReset();
    entersStateMock.mockResolvedValue(undefined);
    createAudioPlayerMock.mockClear();
    createAudioResourceMock.mockReset();
    createAudioResourceMock.mockImplementation(() => ({ volume: { setVolume: vi.fn() } }));
    resolveAgentRouteMock.mockClear();
    agentCommandMock.mockReset();
    agentCommandMock.mockResolvedValue({ payloads: [] });
    transcribeAudioFileMock.mockReset();
    transcribeAudioFileMock.mockResolvedValue({ text: "hello from voice" });
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock.mockImplementation(async () => createSpeechGuardResult());
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const createManager = (
    discordConfig: ConstructorParameters<
      typeof managerModule.DiscordVoiceManager
    >[0]["discordConfig"] = {},
    clientOverride?: ReturnType<typeof createClient>,
    cfgOverride: ConstructorParameters<typeof managerModule.DiscordVoiceManager>[0]["cfg"] = {},
  ) =>
    new managerModule.DiscordVoiceManager({
      client: (clientOverride ?? createClient()) as never,
      cfg: cfgOverride,
      discordConfig,
      accountId: "default",
      runtime: createRuntime(),
    });

  const sessionsOf = (manager: InstanceType<typeof managerModule.DiscordVoiceManager>) =>
    (manager as unknown as { sessions: Map<string, SessionEntryFixture> }).sessions;

  const expectConnectedStatus = (
    manager: InstanceType<typeof managerModule.DiscordVoiceManager>,
    channelId: string,
  ) => {
    expect(manager.status()).toEqual([
      {
        ok: true,
        message: `connected: guild g1 channel ${channelId}`,
        guildId: "g1",
        channelId,
      },
    ]);
  };

  const emitDecryptFailure = (manager: InstanceType<typeof managerModule.DiscordVoiceManager>) => {
    const entry = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get("g1");
    expect(entry).toBeDefined();
    (
      manager as unknown as { handleReceiveError: (e: unknown, err: unknown) => void }
    ).handleReceiveError(
      entry,
      new Error("Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)"),
    );
  };

  type ProcessSegmentInvoker = {
    processSegment: (params: {
      entry: unknown;
      wavPath: string;
      userId: string;
      durationSeconds: number;
      segmentGeneration: number;
    }) => Promise<void>;
  };

  const invokeSegment = async (
    manager: InstanceType<typeof managerModule.DiscordVoiceManager>,
    entry: SessionEntryFixture,
    userId: string,
    segmentGeneration = 0,
  ) =>
    await (manager as unknown as ProcessSegmentInvoker).processSegment({
      entry,
      wavPath: path.join(tempDir, "segment.wav"),
      userId,
      durationSeconds: 1.2,
      segmentGeneration,
    });

  const processVoiceSegment = async (
    manager: InstanceType<typeof managerModule.DiscordVoiceManager>,
    userId: string,
  ) => {
    const entry = createSessionEntry();
    sessionsOf(manager).set(entry.guildId, entry);
    await invokeSegment(manager, entry, userId);
    return entry;
  };

  const voiceOpenConfig = (tts?: { maxTextLength?: number }) => ({
    groupPolicy: "open" as const,
    allowFrom: ["discord:u-1"],
    voice: {
      tts: {
        ...tts,
        providers: { openrouter: { apiKey: "test-key" } },
      },
    },
  });

  const lastSpeechRequest = (index = 0) =>
    fetchWithSsrFGuardMock.mock.calls[index]?.[0] as
      | { url: string; init: { headers: Record<string, string>; body: string }; timeoutMs: number }
      | undefined;

  const parseSpeechBody = (index = 0) => {
    const request = lastSpeechRequest(index);
    if (!request) {
      throw new Error(`missing speech request at index ${index}`);
    }
    return JSON.parse(request.init.body) as {
      model: string;
      input: string;
      response_format: string;
      voice?: string;
    };
  };

  it("keeps the new session when an old disconnected handler fires", async () => {
    const oldConnection = createConnectionMock();
    const newConnection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);
    entersStateMock.mockImplementation(async (target: unknown, status?: string) => {
      if (target === oldConnection && (status === "signalling" || status === "connecting")) {
        throw new Error("old disconnected");
      }
      return undefined;
    });

    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });
    await manager.join({ guildId: "g1", channelId: "1002" });

    const oldDisconnected = oldConnection.handlers.get("disconnected");
    expect(oldDisconnected).toBeTypeOf("function");
    await oldDisconnected?.();

    expectConnectedStatus(manager, "1002");
  });

  it("keeps the new session when an old destroyed handler fires", async () => {
    const oldConnection = createConnectionMock();
    const newConnection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);

    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });
    await manager.join({ guildId: "g1", channelId: "1002" });

    const oldDestroyed = oldConnection.handlers.get("destroyed");
    expect(oldDestroyed).toBeTypeOf("function");
    oldDestroyed?.();

    expectConnectedStatus(manager, "1002");
  });

  it("removes voice listeners on leave", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });
    await manager.leave({ guildId: "g1" });

    const player = createAudioPlayerMock.mock.results[0]?.value;
    expect(connection.receiver.speaking.off).toHaveBeenCalledWith("start", expect.any(Function));
    expect(connection.off).toHaveBeenCalledWith("disconnected", expect.any(Function));
    expect(connection.off).toHaveBeenCalledWith("destroyed", expect.any(Function));
    expect(player.off).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("passes DAVE options to joinVoiceChannel", async () => {
    const manager = createManager({
      voice: {
        daveEncryption: false,
        decryptionFailureTolerance: 8,
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });

    expect(joinVoiceChannelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        daveEncryption: false,
        decryptionFailureTolerance: 8,
      }),
    );
  });

  it("keeps the shorter timeout for initial voice connection readiness", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });

    expect(entersStateMock).toHaveBeenCalledWith(connection, "ready", 15_000);
  });

  it("stores guild metadata on joined voice sessions", async () => {
    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });

    const entry = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get("g1") as
      | { guildName?: string }
      | undefined;
    expect(entry?.guildName).toBe("Guild One");
  });

  it("attempts rejoin after repeated decrypt failures", async () => {
    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });

    emitDecryptFailure(manager);
    emitDecryptFailure(manager);
    emitDecryptFailure(manager);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
  });

  it("passes senderIsOwner=true for allowlisted voice speakers", async () => {
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname: "Owner Nick",
      user: {
        id: "u-owner",
        username: "owner",
        globalName: "Owner",
        discriminator: "1234",
      },
    });
    const manager = createManager({ groupPolicy: "open", allowFrom: ["discord:u-owner"] }, client);
    await processVoiceSegment(manager, "u-owner");

    const commandArgs = agentCommandMock.mock.calls.at(-1)?.[0] as
      | { senderIsOwner?: boolean }
      | undefined;
    expect(commandArgs?.senderIsOwner).toBe(true);
  });

  it("passes senderIsOwner=false for non-owner voice speakers", async () => {
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname: "Guest Nick",
      user: {
        id: "u-guest",
        username: "guest",
        globalName: "Guest",
        discriminator: "4321",
      },
    });
    const manager = createManager({ groupPolicy: "open", allowFrom: ["discord:u-owner"] }, client, {
      commands: { useAccessGroups: false },
    });
    await processVoiceSegment(manager, "u-guest");

    const commandArgs = agentCommandMock.mock.calls.at(-1)?.[0] as
      | { senderIsOwner?: boolean }
      | undefined;
    expect(commandArgs?.senderIsOwner).toBe(false);
  });

  it("reuses speaker context cache for repeated segments from the same speaker", async () => {
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname: "Cached Speaker",
      user: {
        id: "u-cache",
        username: "cache",
        globalName: "Cache",
        discriminator: "1111",
      },
    });
    const manager = createManager({ allowFrom: ["discord:u-cache"] }, client);
    const runSegment = async () => await processVoiceSegment(manager, "u-cache");

    await runSegment();
    await runSegment();

    expect(client.fetchMember).toHaveBeenCalledTimes(3);
  });

  it("persists full speaker context in cache writes", async () => {
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname: "Role Speaker",
      roles: ["role-voice"],
      user: {
        id: "u-role",
        username: "role",
        globalName: "Role",
        discriminator: "2222",
      },
    });
    const manager = createManager(
      {
        groupPolicy: "allowlist",
        guilds: {
          g1: {
            channels: {
              "1001": {
                roles: ["role:role-voice"],
              },
            },
          },
        },
      },
      client,
    );

    await processVoiceSegment(manager, "u-role");

    const cache = (
      manager as unknown as {
        speakerContextCache: Map<
          string,
          {
            id?: string;
            label: string;
            name?: string;
            tag?: string;
            senderIsOwner: boolean;
            expiresAt: number;
          }
        >;
      }
    ).speakerContextCache;
    const cached = cache.get("g1:u-role");

    expect(cached).toEqual(
      expect.objectContaining({
        id: "u-role",
        label: "Role Speaker",
      }),
    );
  });

  it("re-fetches member roles for repeated voice auth checks", async () => {
    const client = createClient();
    client.fetchMember
      .mockResolvedValueOnce({
        nickname: "Role Speaker",
        roles: ["role-voice"],
        user: {
          id: "u-role",
          username: "role",
          globalName: "Role",
          discriminator: "2222",
        },
      })
      .mockResolvedValueOnce({
        nickname: "Role Speaker",
        roles: ["role-voice"],
        user: {
          id: "u-role",
          username: "role",
          globalName: "Role",
          discriminator: "2222",
        },
      })
      .mockResolvedValueOnce({
        nickname: "Role Speaker",
        roles: [],
        user: {
          id: "u-role",
          username: "role",
          globalName: "Role",
          discriminator: "2222",
        },
      })
      .mockResolvedValue({
        nickname: "Role Speaker",
        roles: [],
        user: {
          id: "u-role",
          username: "role",
          globalName: "Role",
          discriminator: "2222",
        },
      });
    const manager = createManager(
      {
        groupPolicy: "allowlist",
        guilds: {
          g1: {
            channels: {
              "1001": {
                roles: ["role:role-voice"],
              },
            },
          },
        },
      },
      client,
    );

    await processVoiceSegment(manager, "u-role");
    await processVoiceSegment(manager, "u-role");

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expect(client.fetchMember).toHaveBeenCalledTimes(3);
  });

  it("fetches guild metadata before allowlist checks when the session lacks a guild name", async () => {
    const client = createClient();
    client.fetchGuild.mockResolvedValue({ id: "g1", name: "Guild One" });
    client.fetchMember.mockResolvedValue({
      nickname: "Owner Nick",
      user: {
        id: "u-owner",
        username: "owner",
        globalName: "Owner",
        discriminator: "1234",
      },
    });
    const manager = createManager(
      {
        groupPolicy: "allowlist",
        guilds: {
          "guild-one": {
            channels: {
              "*": {
                users: ["discord:u-owner"],
              },
            },
          },
        },
      },
      client,
    );

    await processVoiceSegment(manager, "u-owner");

    expect(client.fetchGuild).toHaveBeenCalledWith("g1");
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
  });

  it("plays synthesized speech for the agent reply", async () => {
    const client = createClient();
    const manager = createManager(voiceOpenConfig(), client);
    agentCommandMock.mockResolvedValue({ payloads: [{ text: "hello there" }] });

    const entry = createSessionEntry();
    sessionsOf(manager).set("g1", entry);
    await invokeSegment(manager, entry, "u-1");

    expect(transcribeAudioFileMock).toHaveBeenCalledTimes(1);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    const request = lastSpeechRequest();
    expect(request?.url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(request?.init.headers.Authorization).toBe("Bearer test-key");
    expect(parseSpeechBody()).toEqual({
      model: "fish-audio/s2.1-pro-free:free",
      input: "hello there",
      response_format: "mp3",
    });
    expect(createAudioResourceMock).toHaveBeenCalledTimes(1);
    expect(createAudioResourceMock.mock.calls[0]?.[0]).toMatch(/reply-.*\.mp3$/);
    expect(entry.player.play).toHaveBeenCalledTimes(1);
    expect(client.rest.post).not.toHaveBeenCalled();
  });

  it("advances the generation and stops playback when a new segment starts", async () => {
    const manager = createManager();
    const entry = createSessionEntry();
    entry.player.state.status = "playing";
    sessionsOf(manager).set("g1", entry);

    await (
      manager as unknown as {
        handleSpeakingStart: (e: unknown, u: string) => Promise<void>;
      }
    ).handleSpeakingStart(entry, "u-1");

    expect(entry.generation).toBe(1);
    expect(entry.player.stop).toHaveBeenCalledWith(true);
    expect(entry.activeSpeakers.size).toBe(0);
  });

  it("discards a segment whose generation is stale", async () => {
    const client = createClient();
    const manager = createManager(voiceOpenConfig(), client);
    agentCommandMock.mockResolvedValue({ payloads: [{ text: "hello there" }] });

    const entry = createSessionEntry({ generation: 1 });
    sessionsOf(manager).set("g1", entry);
    await invokeSegment(manager, entry, "u-1", 0);

    expect(transcribeAudioFileMock).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(entry.player.play).not.toHaveBeenCalled();
    expect(client.rest.post).not.toHaveBeenCalled();
  });

  it("discards a segment whose session was replaced", async () => {
    const client = createClient();
    const manager = createManager(voiceOpenConfig(), client);
    agentCommandMock.mockResolvedValue({ payloads: [{ text: "hello there" }] });

    const entry = createSessionEntry();
    sessionsOf(manager).set("g1", createSessionEntry());
    await invokeSegment(manager, entry, "u-1");

    expect(transcribeAudioFileMock).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(entry.player.play).not.toHaveBeenCalled();
    expect(client.rest.post).not.toHaveBeenCalled();
  });

  it("retries with the paid model when the free model is rate limited", async () => {
    const client = createClient();
    const manager = createManager(voiceOpenConfig(), client);
    agentCommandMock.mockResolvedValue({ payloads: [{ text: "hello there" }] });
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(createSpeechGuardResult({ status: 429, body: "rate limited" }))
      .mockResolvedValueOnce(createSpeechGuardResult());

    const entry = createSessionEntry();
    sessionsOf(manager).set("g1", entry);
    await invokeSegment(manager, entry, "u-1");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect(parseSpeechBody(0).model).toBe("fish-audio/s2.1-pro-free:free");
    expect(parseSpeechBody(1).model).toBe("fish-audio/s2.1-pro");
    expect(entry.player.play).toHaveBeenCalledTimes(1);
    expect(client.rest.post).not.toHaveBeenCalled();
  });

  it("falls back to text when the speech request is rejected", async () => {
    const client = createClient();
    const manager = createManager(voiceOpenConfig(), client);
    agentCommandMock.mockResolvedValue({ payloads: [{ text: "hello there" }] });
    fetchWithSsrFGuardMock.mockResolvedValueOnce(
      createSpeechGuardResult({ status: 400, body: "bad request" }),
    );

    const entry = createSessionEntry();
    sessionsOf(manager).set("g1", entry);
    await invokeSegment(manager, entry, "u-1");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(entry.player.play).not.toHaveBeenCalled();
    expect(client.rest.post).toHaveBeenCalledWith(Routes.channelMessages("1001"), {
      body: { content: "hello there" },
    });
  });

  it("truncates speech input to the configured maxTextLength", async () => {
    const client = createClient();
    const manager = createManager(voiceOpenConfig({ maxTextLength: 5 }), client);
    agentCommandMock.mockResolvedValue({ payloads: [{ text: "hello there" }] });

    const entry = createSessionEntry();
    sessionsOf(manager).set("g1", entry);
    await invokeSegment(manager, entry, "u-1");

    expect(parseSpeechBody().input).toBe("hello");
    expect(entry.player.play).toHaveBeenCalledTimes(1);
  });

  it("routes voice prompts to the master session", async () => {
    const client = createClient();
    const manager = createManager(voiceOpenConfig(), client);
    agentCommandMock.mockResolvedValue({ payloads: [{ text: "hello there" }] });

    const entry = createSessionEntry();
    sessionsOf(manager).set("g1", entry);
    await invokeSegment(manager, entry, "u-1");

    expect(agentCommandMock.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  it("DiscordVoiceReadyListener: propagates autoJoin errors fire-and-forget without throwing", async () => {
    const manager = createManager();
    vi.spyOn(manager, "autoJoin").mockRejectedValue(new Error("autoJoin rejected"));

    const { DiscordVoiceReadyListener } = managerModule;
    const listener = new DiscordVoiceReadyListener(manager);

    await expect(listener.handle(undefined, undefined as never)).resolves.toBeUndefined();
    expect(manager.autoJoin).toHaveBeenCalledTimes(1);
  });
});

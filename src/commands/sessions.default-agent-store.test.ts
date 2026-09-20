import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { sessionsCommand } from "./sessions.js";

const loadConfigMock = vi.fn(() => ({
  agents: {
    defaults: {
      model: { primary: "pi:opus" },
      models: { "pi:opus": {} },
      contextTokens: 32000,
    },
    list: [
      { id: "main", default: false },
      { id: "voice", default: true },
    ],
  },
  session: {
    store: "/tmp/sessions-{agentId}.json",
  },
}));

const loadSessionStoreMock = vi.fn(() => ({}));

const resolveSessionStoreTargetsOrExitMock = vi.fn(
  ({ cfg }: { cfg: { session?: { store?: string } } }) => {
    const store = cfg.session?.store ?? "/tmp/sessions-{agentId}.json";
    if (!store.includes("{agentId}")) {
      return [{ agentId: "main", storePath: store }];
    }
    return ["main", "voice"].map((agentId) => ({
      agentId,
      storePath: store.replace("{agentId}", agentId),
    }));
  },
);

const deps = {
  loadConfig: loadConfigMock,
  loadSessionStore: loadSessionStoreMock,
  resolveSessionStoreTargetsOrExit: resolveSessionStoreTargetsOrExitMock,
};

function createRuntime(): { runtime: RuntimeEnv; logs: string[] } {
  const logs: string[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: vi.fn(),
      exit: vi.fn(),
    },
    logs,
  };
}

describe("sessionsCommand default store agent selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockImplementation(() => ({
      agents: {
        defaults: {
          model: { primary: "pi:opus" },
          models: { "pi:opus": {} },
          contextTokens: 32000,
        },
        list: [
          { id: "main", default: false },
          { id: "voice", default: true },
        ],
      },
      session: {
        store: "/tmp/sessions-{agentId}.json",
      },
    }));
    loadSessionStoreMock.mockImplementation(() => ({}));
  });

  it("includes agentId on sessions rows for --all-agents JSON output", async () => {
    loadSessionStoreMock.mockReset();
    loadSessionStoreMock
      .mockReturnValueOnce({
        main_row: { sessionId: "s1", updatedAt: Date.now() - 60_000, model: "pi:opus" },
      })
      .mockReturnValueOnce({
        voice_row: { sessionId: "s2", updatedAt: Date.now() - 120_000, model: "pi:opus" },
      });
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true, json: true }, runtime, deps);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      allAgents?: boolean;
      sessions?: Array<{ key: string; agentId?: string }>;
    };
    expect(payload.allAgents).toBe(true);
    expect(payload.sessions?.map((session) => session.agentId)).toContain("main");
    expect(payload.sessions?.map((session) => session.agentId)).toContain("voice");
  });

  it("avoids duplicate rows when --all-agents resolves to a shared store path", async () => {
    loadConfigMock.mockImplementation(() => ({
      agents: {
        defaults: {
          model: { primary: "pi:opus" },
          models: { "pi:opus": {} },
          contextTokens: 32000,
        },
        list: [
          { id: "main", default: false },
          { id: "voice", default: true },
        ],
      },
      session: {
        store: "/tmp/shared-sessions.json",
      },
    }));
    loadSessionStoreMock.mockReset();
    loadSessionStoreMock.mockReturnValue({
      "agent:main:room": { sessionId: "s1", updatedAt: Date.now() - 60_000, model: "pi:opus" },
      "agent:voice:room": { sessionId: "s2", updatedAt: Date.now() - 30_000, model: "pi:opus" },
    });
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true, json: true }, runtime, deps);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      count?: number;
      stores?: Array<{ agentId: string; path: string }>;
      allAgents?: boolean;
      sessions?: Array<{ key: string; agentId?: string }>;
    };
    expect(payload.count).toBe(2);
    expect(payload.allAgents).toBe(true);
    expect(payload.stores).toEqual([{ agentId: "main", path: "/tmp/shared-sessions.json" }]);
    expect(payload.sessions?.map((session) => session.agentId).toSorted()).toEqual([
      "main",
      "voice",
    ]);
    expect(loadSessionStoreMock).toHaveBeenCalledTimes(1);
  });

  it("uses configured default agent id when resolving implicit session store path", async () => {
    loadSessionStoreMock.mockReset();
    loadSessionStoreMock.mockReturnValue({});
    resolveSessionStoreTargetsOrExitMock.mockReturnValueOnce([
      { agentId: "voice", storePath: "/tmp/sessions-voice.json" },
    ]);
    const { runtime, logs } = createRuntime();

    await sessionsCommand({}, runtime, deps);

    expect(loadSessionStoreMock).toHaveBeenCalledWith("/tmp/sessions-voice.json");
    expect(logs[0]).toContain("Session store: /tmp/sessions-voice.json");
  });

  it("uses all configured agent stores with --all-agents", async () => {
    loadSessionStoreMock.mockReset();
    loadSessionStoreMock
      .mockReturnValueOnce({
        main_row: { sessionId: "s1", updatedAt: Date.now() - 60_000, model: "pi:opus" },
      })
      .mockReturnValueOnce({});
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true }, runtime, deps);

    expect(loadSessionStoreMock).toHaveBeenNthCalledWith(1, "/tmp/sessions-main.json");
    expect(loadSessionStoreMock).toHaveBeenNthCalledWith(2, "/tmp/sessions-voice.json");
    expect(logs[0]).toContain("Session stores: 2 (main, voice)");
    expect(logs[2]).toContain("Agent");
  });
});

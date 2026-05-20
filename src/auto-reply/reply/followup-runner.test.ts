import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";

const runEmbeddedPiAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const compactEmbeddedPiSessionMock = vi.fn();
const routeReplyMock = vi.fn();
const isRoutableChannelMock = vi.fn();

let createFollowupRunner: typeof import("./followup-runner.js").createFollowupRunner;
let loadSessionStore: typeof import("../../config/sessions/store.js").loadSessionStore;
let saveSessionStore: typeof import("../../config/sessions/store.js").saveSessionStore;
let clearFollowupQueue: typeof import("./queue.js").clearFollowupQueue;
let enqueueFollowupRun: typeof import("./queue.js").enqueueFollowupRun;
let sessionRunAccounting: typeof import("./session-run-accounting.js");
let createMockFollowupRun: typeof import("./test-helpers.js").createMockFollowupRun;
let createMockTypingController: typeof import("./test-helpers.js").createMockTypingController;
const FOLLOWUP_DEBUG = process.env.OPENCLAW_DEBUG_FOLLOWUP_RUNNER_TEST === "1";
const FOLLOWUP_TEST_QUEUES = new Map<
  string,
  {
    items: FollowupRun[];
    lastRun?: FollowupRun["run"];
  }
>();

function debugFollowupTest(message: string): void {
  if (!FOLLOWUP_DEBUG) {
    return;
  }
  process.stderr.write(`[followup-runner.test] ${message}\n`);
}

async function incrementRunCompactionCountForFollowupTest(
  params: Parameters<typeof import("./session-run-accounting.js").incrementRunCompactionCount>[0],
): Promise<number | undefined> {
  const {
    sessionStore,
    sessionKey,
    sessionEntry,
    amount = 1,
    newSessionId,
    lastCallUsage,
  } = params;
  if (!sessionStore || !sessionKey) {
    return undefined;
  }
  const entry = sessionStore[sessionKey] ?? sessionEntry;
  if (!entry) {
    return undefined;
  }

  const nextCount = Math.max(0, entry.compactionCount ?? 0) + Math.max(0, amount);
  const nextEntry: SessionEntry = {
    ...entry,
    compactionCount: nextCount,
    updatedAt: Date.now(),
  };
  if (newSessionId && newSessionId !== entry.sessionId) {
    nextEntry.sessionId = newSessionId;
    if (entry.sessionFile?.trim()) {
      nextEntry.sessionFile = path.join(path.dirname(entry.sessionFile), `${newSessionId}.jsonl`);
    }
  }
  const promptTokens =
    (lastCallUsage?.input ?? 0) +
    (lastCallUsage?.cacheRead ?? 0) +
    (lastCallUsage?.cacheWrite ?? 0);
  if (promptTokens > 0) {
    nextEntry.totalTokens = promptTokens;
    nextEntry.totalTokensFresh = true;
    nextEntry.inputTokens = undefined;
    nextEntry.outputTokens = undefined;
    nextEntry.cacheRead = undefined;
    nextEntry.cacheWrite = undefined;
  }

  sessionStore[sessionKey] = nextEntry;
  if (sessionEntry) {
    Object.assign(sessionEntry, nextEntry);
  }
  return nextCount;
}

function getFollowupTestQueue(key: string): {
  items: FollowupRun[];
  lastRun?: FollowupRun["run"];
} {
  const cleaned = key.trim();
  const existing = FOLLOWUP_TEST_QUEUES.get(cleaned);
  if (existing) {
    return existing;
  }
  const created = {
    items: [] as FollowupRun[],
    lastRun: undefined as FollowupRun["run"] | undefined,
  };
  FOLLOWUP_TEST_QUEUES.set(cleaned, created);
  return created;
}

function clearFollowupQueueForFollowupTest(key: string): number {
  const cleaned = key.trim();
  const queue = FOLLOWUP_TEST_QUEUES.get(cleaned);
  if (!queue) {
    return 0;
  }
  const cleared = queue.items.length;
  FOLLOWUP_TEST_QUEUES.delete(cleaned);
  return cleared;
}

function enqueueFollowupRunForFollowupTest(key: string, run: FollowupRun): boolean {
  const queue = getFollowupTestQueue(key);
  queue.items.push(run);
  queue.lastRun = run.run;
  return true;
}

function refreshQueuedFollowupSessionForFollowupTest(params: {
  key: string;
  previousSessionId?: string;
  nextSessionId?: string;
  nextSessionFile?: string;
  nextProvider?: string;
  nextModel?: string;
  nextAuthProfileId?: string;
  nextAuthProfileIdSource?: "auto" | "user";
}): void {
  const cleaned = params.key.trim();
  if (!cleaned) {
    return;
  }
  const queue = FOLLOWUP_TEST_QUEUES.get(cleaned);
  if (!queue) {
    return;
  }
  const shouldRewriteSession =
    Boolean(params.previousSessionId) &&
    Boolean(params.nextSessionId) &&
    params.previousSessionId !== params.nextSessionId;
  const shouldRewriteSelection =
    typeof params.nextProvider === "string" ||
    typeof params.nextModel === "string" ||
    Object.hasOwn(params, "nextAuthProfileId") ||
    Object.hasOwn(params, "nextAuthProfileIdSource");
  if (!shouldRewriteSession && !shouldRewriteSelection) {
    return;
  }
  const rewrite = (run?: FollowupRun["run"]) => {
    if (!run) {
      return;
    }
    if (shouldRewriteSession && run.sessionId === params.previousSessionId) {
      run.sessionId = params.nextSessionId!;
      if (params.nextSessionFile?.trim()) {
        run.sessionFile = params.nextSessionFile;
      }
    }
    if (shouldRewriteSelection) {
      if (typeof params.nextProvider === "string") {
        run.provider = params.nextProvider;
      }
      if (typeof params.nextModel === "string") {
        run.model = params.nextModel;
      }
      if (Object.hasOwn(params, "nextAuthProfileId")) {
        run.authProfileId = params.nextAuthProfileId?.trim() || undefined;
      }
      if (Object.hasOwn(params, "nextAuthProfileIdSource")) {
        run.authProfileIdSource = run.authProfileId ? params.nextAuthProfileIdSource : undefined;
      }
    }
  };
  rewrite(queue.lastRun);
  for (const item of queue.items) {
    rewrite(item.run);
  }
}

async function persistRunSessionUsageForFollowupTest(
  params: Parameters<typeof import("./session-run-accounting.js").persistRunSessionUsage>[0],
): Promise<void> {
  const { storePath, sessionKey } = params;
  if (!storePath || !sessionKey) {
    return;
  }
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[sessionKey];
  if (!entry) {
    return;
  }
  const nextEntry: SessionEntry = {
    ...entry,
    updatedAt: Date.now(),
    modelProvider: params.providerUsed ?? entry.modelProvider,
    model: params.modelUsed ?? entry.model,
    contextTokens: params.contextTokensUsed ?? entry.contextTokens,
    systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
  };
  if (params.usage) {
    nextEntry.inputTokens = params.usage.input ?? 0;
    nextEntry.outputTokens = params.usage.output ?? 0;
    const cacheUsage = params.lastCallUsage ?? params.usage;
    nextEntry.cacheRead = cacheUsage?.cacheRead ?? 0;
    nextEntry.cacheWrite = cacheUsage?.cacheWrite ?? 0;
  }
  const promptTokens =
    params.promptTokens ??
    (params.lastCallUsage?.input ?? params.usage?.input ?? 0) +
      (params.lastCallUsage?.cacheRead ?? params.usage?.cacheRead ?? 0) +
      (params.lastCallUsage?.cacheWrite ?? params.usage?.cacheWrite ?? 0);
  nextEntry.totalTokens = promptTokens > 0 ? promptTokens : undefined;
  nextEntry.totalTokensFresh = promptTokens > 0;
  store[sessionKey] = nextEntry;
  await saveSessionStore(storePath, store);
}

async function loadFreshFollowupRunnerModuleForTest() {
  vi.resetModules();
  vi.doMock(
    "../../agents/model-fallback.js",
    () => ({ runWithModelFallback: runWithModelFallbackMock }),
  );
  vi.doMock("../../agents/session-write-lock.js", () => ({
    acquireSessionWriteLock: vi.fn(async () => ({
      release: async () => {},
    })),
    resolveSessionLockMaxHoldFromTimeout: vi.fn(() => 1),
  }));
  vi.doMock("../../agents/pi-embedded.js", () => ({
    abortEmbeddedPiRun: vi.fn(async () => false),
    compactEmbeddedPiSession: (params: unknown) => compactEmbeddedPiSessionMock(params),
    isEmbeddedPiRunActive: vi.fn(() => false),
    isEmbeddedPiRunStreaming: vi.fn(() => false),
    queueEmbeddedPiMessage: vi.fn(async () => undefined),
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
    runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
    waitForEmbeddedPiRunEnd: vi.fn(async () => undefined),
  }));
  vi.doMock("./queue.js", () => ({
    clearFollowupQueue: clearFollowupQueueForFollowupTest,
    enqueueFollowupRun: enqueueFollowupRunForFollowupTest,
    refreshQueuedFollowupSession: refreshQueuedFollowupSessionForFollowupTest,
  }));
  vi.doMock("./session-run-accounting.js", () => ({
    persistRunSessionUsage: persistRunSessionUsageForFollowupTest,
    incrementRunCompactionCount: incrementRunCompactionCountForFollowupTest,
  }));
  vi.doMock("./route-reply.js", () => ({
    isRoutableChannel: (...args: unknown[]) => isRoutableChannelMock(...args),
    routeReply: (...args: unknown[]) => routeReplyMock(...args),
  }));
  ({ createFollowupRunner } = await import("./followup-runner.js"));
  ({ loadSessionStore, saveSessionStore } = await import("../../config/sessions/store.js"));
  ({ clearFollowupQueue, enqueueFollowupRun } = await import("./queue.js"));
  sessionRunAccounting = await import("./session-run-accounting.js");
  ({ createMockFollowupRun, createMockTypingController } = await import("./test-helpers.js"));
}

const ROUTABLE_TEST_CHANNELS = new Set([
  "telegram",
  "slack",
  "discord",
  "signal",
  "imessage",
  "whatsapp",
  "feishu",
]);

beforeEach(async () => {
  await loadFreshFollowupRunnerModuleForTest();
  runEmbeddedPiAgentMock.mockReset();
  runWithModelFallbackMock.mockReset();
  compactEmbeddedPiSessionMock.mockReset();
  routeReplyMock.mockReset();
  routeReplyMock.mockResolvedValue({ ok: true });
  isRoutableChannelMock.mockReset();
  isRoutableChannelMock.mockImplementation((ch: string | undefined) =>
    Boolean(ch?.trim() && ROUTABLE_TEST_CHANNELS.has(ch.trim().toLowerCase())),
  );
  clearFollowupQueue("main");
  FOLLOWUP_TEST_QUEUES.clear();
});

afterEach(async () => {
  clearFollowupQueue("main");
  FOLLOWUP_TEST_QUEUES.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  const { clearSessionStoreCacheForTest } = await import("../../config/sessions/store.js");
  clearSessionStoreCacheForTest();
  if (!FOLLOWUP_DEBUG) {
    return;
  }
  const handles = (process as NodeJS.Process & { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles?.()
    .map((handle) => handle?.constructor?.name ?? typeof handle);
  debugFollowupTest(`active handles: ${JSON.stringify(handles ?? [])}`);
  const requests = (process as NodeJS.Process & { _getActiveRequests?: () => unknown[] })
    ._getActiveRequests?.()
    .map((request) => request?.constructor?.name ?? typeof request);
  debugFollowupTest(`active requests: ${JSON.stringify(requests ?? [])}`);
});

const baseQueuedRun = (messageProvider = "whatsapp"): FollowupRun =>
  createMockFollowupRun({ run: { messageProvider } });

function createQueuedRun(
  overrides: Partial<Omit<FollowupRun, "run">> & { run?: Partial<FollowupRun["run"]> } = {},
): FollowupRun {
  return createMockFollowupRun(overrides);
}

async function normalizeComparablePath(filePath: string): Promise<string> {
  const parent = await fs.realpath(path.dirname(filePath)).catch(() => path.dirname(filePath));
  return path.join(parent, path.basename(filePath));
}

function mockCompactionRun(params: {
  willRetry: boolean;
  result: {
    payloads: Array<{ text: string }>;
    meta: Record<string, unknown>;
  };
}) {
  runEmbeddedPiAgentMock.mockImplementationOnce(
    async (args: {
      onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
    }) => {
      args.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: params.willRetry, completed: true },
      });
      return params.result;
    },
  );
}

function createAsyncReplySpy() {
  return vi.fn(async () => {});
}

describe("createFollowupRunner compaction", () => {
  it("clears queued auto fallback pins after a successful primary probe", async () => {
    const sessionKey = "probe-clear";
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude",
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: { agentMeta: { provider: "anthropic", model: "claude" } },
    });

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultModel: "anthropic/claude",
    });

    await runner(
      createQueuedRun({
        run: {
          sessionKey,
          provider: "anthropic",
          model: "claude",
          autoFallbackPrimaryProbe: {
            provider: "anthropic",
            model: "claude",
            fallbackProvider: "openai",
            fallbackModel: "gpt-5.4",
          },
        },
      }),
    );

    const call = requireLastMockCallArg(runEmbeddedPiAgentMock, "run embedded pi agent");
    expect(call.provider).toBe("anthropic");
    expect(call.model).toBe("claude");
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
    expect(sessionEntry.modelOverrideFallbackOriginProvider).toBeUndefined();
    expect(sessionEntry.modelOverrideFallbackOriginModel).toBeUndefined();
  });

  it("rechecks queued probe throttle and keeps fallback auth when probe is not due", async () => {
    const sessionKey = "probe-skip";
    const probe = {
      provider: "anthropic",
      model: "claude",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
      fallbackAuthProfileId: "openai:fallback",
      fallbackAuthProfileIdSource: "auto" as const,
    };
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude",
      authProfileOverride: "openai:fallback",
      authProfileOverrideSource: "auto",
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    const { markAutoFallbackPrimaryProbe } = await import("../../agents/agent-scope.js");
    markAutoFallbackPrimaryProbe({ probe, sessionKey });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: { agentMeta: { provider: "openai", model: "gpt-5.4" } },
    });
    runPreflightCompactionIfNeededMock.mockImplementationOnce(
      async (params: { followupRun: FollowupRun; sessionEntry?: SessionEntry }) => {
        expect(params.followupRun.run.provider).toBe("openai");
        expect(params.followupRun.run.model).toBe("gpt-5.4");
        expect(params.followupRun.run.autoFallbackPrimaryProbe).toBeUndefined();
        return params.sessionEntry;
      },
    );

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultModel: "anthropic/claude",
    });

    await runner(
      createQueuedRun({
        run: {
          sessionKey,
          provider: "anthropic",
          model: "claude",
          authProfileId: "anthropic:primary",
          authProfileIdSource: "auto",
          autoFallbackPrimaryProbe: probe,
        },
      }),
    );

    const call = requireLastMockCallArg(runEmbeddedPiAgentMock, "run embedded pi agent");
    expect(call.provider).toBe("openai");
    expect(call.model).toBe("gpt-5.4");
    expect(call.authProfileId).toBe("openai:fallback");
    expect(call.authProfileIdSource).toBe("auto");
    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-5.4");
    expect(sessionEntry.modelOverrideSource).toBe("auto");
  });
});

describe("createFollowupRunner runtime config", () => {
  it("routes queued followups through CLI runtime dispatch when the model selects a CLI backend", async () => {
    const runtimeConfig: OpenClawConfig = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": { command: "claude" },
          },
          models: {
            "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    };
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-followup",
      updatedAt: Date.now(),
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "cli-session-1",
        },
      },
    };
    const sessionStore = { main: sessionEntry };
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        agentMeta: {
          provider: "claude-cli",
          model: "claude-opus-4-7",
        },
      },
    });

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-7",
    });

    await runner(
      createQueuedRun({
        originatingChannel: "telegram",
        run: {
          config: runtimeConfig,
          provider: "anthropic",
          model: "claude-opus-4-7",
          messageProvider: "telegram",
        },
      }),
    );

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    const call = requireLastMockCallArg(runCliAgentMock, "run cli agent");
    expect(call.provider).toBe("claude-cli");
    expect(call.model).toBe("claude-opus-4-7");
    expect(call.config).toBe(runtimeConfig);
    expect(call.cliSessionId).toBe("cli-session-1");
    expect(call.messageChannel).toBe("telegram");
  });

  it("defers queued CLI attempt terminal lifecycle events until fallback settles", async () => {
    const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
      "../../infra/agent-events.js",
    );
    const lifecyclePhases: string[] = [];
    const unsubscribe = realAgentEvents.onAgentEvent((evt) => {
      if (evt.stream !== "lifecycle") {
        return;
      }
      const phase = typeof evt.data.phase === "string" ? evt.data.phase : undefined;
      if (phase) {
        lifecyclePhases.push(phase);
      }
    });
    const runtimeConfig: OpenClawConfig = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": { command: "claude" },
          },
          models: {
            "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    };
    runWithModelFallbackMock.mockImplementationOnce(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        await expect(params.run("anthropic", "claude-opus-4-7")).rejects.toThrow("cli failed");
        return {
          result: await params.run("openai", "gpt-5.4"),
          provider: "openai",
          model: "gpt-5.4",
        };
      },
    );
    runCliAgentMock.mockRejectedValueOnce(new Error("cli failed"));
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: Date.now() },
      });
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: { phase: "end", endedAt: Date.now() },
      });
      return {
        payloads: [{ text: "fallback ok" }],
        meta: {},
      };
    });

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-7",
    });

    try {
      await runner(
        createQueuedRun({
          originatingChannel: "telegram",
          originatingTo: "chat-1",
          run: {
            config: runtimeConfig,
            provider: "anthropic",
            model: "claude-opus-4-7",
            messageProvider: "telegram",
          },
        }),
      );
    } finally {
      unsubscribe();
    }

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const embeddedCall = requireLastMockCallArg(runEmbeddedPiAgentMock, "run embedded pi agent");
    expect(embeddedCall.suppressAssistantErrorPersistence).toBe(false);
    expect(lifecyclePhases).toEqual(["start", "start", "end"]);
  });

  it("uses the active runtime snapshot for queued embedded followup runs", async () => {
    const sourceConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: {
              source: "env",
              provider: "default",
              id: "OPENAI_API_KEY",
            },
            models: [],
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "resolved-runtime-key",
            models: [],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });

    await runner(
      createQueuedRun({
        run: {
          config: sourceConfig,
          provider: "openai",
          model: "gpt-5.4",
        },
      }),
    );

    const call = requireLastMockCallArg(runEmbeddedPiAgentMock, "run embedded pi agent");
    expect(call.config).toBe(runtimeConfig);
  });

  it("skips aborted queued room-event followups", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const onBlockReply = vi.fn(async () => {});
    const typing = createMockTypingController();
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing,
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });

    await runner(
      createQueuedRun({
        currentInboundEventKind: "room_event",
        abortSignal: abortController.signal,
        run: {
          provider: "openai",
          model: "gpt-5.4",
          sourceReplyDeliveryMode: "message_tool_only",
        },
      }),
    );

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(typing.markRunComplete).toHaveBeenCalledTimes(1);
    expect(typing.markDispatchIdle).toHaveBeenCalledTimes(1);
  });

  it("passes queued room-event abort signals into followup agent runs", async () => {
    const abortController = new AbortController();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });

    await runner(
      createQueuedRun({
        currentInboundEventKind: "room_event",
        abortSignal: abortController.signal,
        run: {
          provider: "openai",
          model: "gpt-5.4",
          sourceReplyDeliveryMode: "message_tool_only",
        },
      }),
    );

    const call = requireLastMockCallArg(runEmbeddedPiAgentMock, "run embedded pi agent");
    expect(call.abortSignal).toBe(abortController.signal);
  });

  it("keeps queued delivery correlations active during followup agent runs", async () => {
    const events: string[] = [];
    runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      events.push("run");
      return {
        payloads: [],
        meta: {},
      };
    });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });

    await runner(
      createQueuedRun({
        currentInboundEventKind: "room_event",
        deliveryCorrelations: [
          {
            begin: () => {
              events.push("begin");
              return () => {
                events.push("end");
              };
            },
          },
        ],
        run: {
          provider: "openai",
          model: "gpt-5.4",
          sourceReplyDeliveryMode: "message_tool_only",
        },
      }),
    );

    expect(events).toEqual(["begin", "run", "end"]);
  });

  it("resolves queued embedded followups before preflight helpers read config", async () => {
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          whisper: {
            apiKey: {
              source: "env",
              provider: "default",
              id: "OPENAI_API_KEY",
            },
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      skills: {
        entries: {
          whisper: {
            apiKey: "resolved-runtime-key",
          },
        },
      },
    };
    resolveCommandSecretRefsViaGatewayMock.mockResolvedValueOnce({
      resolvedConfig: runtimeConfig,
      diagnostics: [],
      targetStatesByPath: { "skills.entries.whisper.apiKey": "resolved_local" },
      hadUnresolvedTargets: false,
    });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });
    const queued = createQueuedRun({
      run: {
        config: sourceConfig,
        provider: "openai",
        model: "gpt-5.4",
      },
    });

    await runner(queued);

    expect(queued.run.config).toBe(runtimeConfig);
    expect(requireMockCallArg(runPreflightCompactionIfNeededMock, 0).cfg).toBe(runtimeConfig);
    const call = requireLastMockCallArg(runEmbeddedPiAgentMock, "run embedded pi agent");
    expect(call.config).toBe(runtimeConfig);
  });

  it("passes queued origin scope into queued execution-config resolution", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });
    const sourceConfig: OpenClawConfig = {};
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });
    const queued = createQueuedRun({
      originatingChannel: "discord",
      originatingAccountId: "work",
      run: {
        config: sourceConfig,
        provider: "openai",
        model: "gpt-5.4",
        messageProvider: "discord",
        agentAccountId: "bot-account",
      },
    });

    await runner(queued);

    expect(resolveQueuedReplyExecutionConfigMock).toHaveBeenCalledWith(sourceConfig, {
      originatingChannel: "discord",
      messageProvider: "discord",
      originatingAccountId: "work",
      agentAccountId: "bot-account",
    });
  });

  it("passes queued images into queued embedded followup runs", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });
    const images = [{ type: "image" as const, data: "base64-cat", mimeType: "image/png" }];
    const imageOrder = ["inline" as const];
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
      opts: {
        images: [{ type: "image", data: "fallback", mimeType: "image/png" }],
        imageOrder: ["inline"],
      },
    });

    await runner(
      createQueuedRun({
        images,
        imageOrder,
      }),
    );

    const call = requireLastMockCallArg(runEmbeddedPiAgentMock, "run embedded pi agent");
    expect(call.images).toBe(images);
    expect(call.imageOrder).toBe(imageOrder);
  });
});

describe("createFollowupRunner progress forwarding", () => {
  it("forwards queued follow-up tool progress and verbose tool result payloads", async () => {
    const onToolStart = vi.fn(async () => {});
    const queued = createQueuedRun({
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      originatingAccountId: "acct-1",
      originatingThreadId: "thread-1",
      run: {
        messageProvider: "discord",
        sourceReplyDeliveryMode: "message_tool_only",
        verboseLevel: "on",
      },
    });

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (args: {
        onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => Promise<void>;
        onToolResult?: (payload: { text: string }) => Promise<void>;
        shouldEmitToolResult?: () => boolean;
        shouldEmitToolOutput?: () => boolean;
        toolProgressDetail?: "explain" | "raw";
      }) => {
        expect(args.shouldEmitToolResult?.()).toBe(true);
        expect(args.shouldEmitToolOutput?.()).toBe(false);
        expect(args.toolProgressDetail).toBe("raw");
        await args.onAgentEvent?.({
          stream: "tool",
          data: {
            phase: "start",
            name: "exec",
            args: { command: "echo queued-progress" },
          },
        });
        await args.onToolResult?.({ text: "🛠️ Exec: echo queued-progress" });
        return { payloads: [], meta: { agentMeta: {} } };
      },
    );

    const runner = createFollowupRunner({
      opts: { onToolStart },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "claude",
      toolProgressDetail: "raw",
    });

    await runner(queued);

    expect(onToolStart).toHaveBeenCalledWith({
      name: "exec",
      phase: "start",
      args: { command: "echo queued-progress" },
      detailMode: "raw",
    });
    expect(routeReplyMock).toHaveBeenCalledTimes(1);
    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:C1",
        accountId: "acct-1",
        threadId: "thread-1",
        mirror: false,
        payload: expect.objectContaining({ text: "🛠️ Exec: echo queued-progress" }),
      }),
    );
  });

  it("drains fire-and-forget queued tool progress before final delivery", async () => {
    const queued = createQueuedRun({
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      originatingAccountId: "acct-1",
      originatingThreadId: "thread-1",
      run: {
        messageProvider: "discord",
        verboseLevel: "on",
      },
    });
    let releaseProgressRoute: (() => void) | undefined;
    const progressRouteStarted = new Promise<void>((resolve) => {
      routeReplyMock.mockImplementationOnce(
        async () =>
          await new Promise<{ ok: true }>((release) => {
            releaseProgressRoute = () => {
              release({ ok: true });
            };
            resolve();
          }),
      );
    });

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (args: { onToolResult?: (payload: { text: string }) => Promise<void> }) => {
        void args.onToolResult?.({ text: "🛠️ Exec: echo queued-progress" });
        return { payloads: [{ text: "final reply" }], meta: { agentMeta: {} } };
      },
    );

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "claude",
    });

    const runPromise = runner(queued);
    await progressRouteStarted;
    await Promise.resolve();

    expect(routeReplyMock).toHaveBeenCalledTimes(1);
    expect(requireMockCallArg(routeReplyMock, 0).payload).toEqual(
      expect.objectContaining({ text: "🛠️ Exec: echo queued-progress" }),
    );
    expect(requireMockCallArg(routeReplyMock, 0).mirror).toBe(false);

    releaseProgressRoute?.();
    await runPromise;

    expect(routeReplyMock).toHaveBeenCalledTimes(2);
    expect(requireMockCallArg(routeReplyMock, 1).payload).toEqual(
      expect.objectContaining({ text: "final reply" }),
    );
    expect(requireMockCallArg(routeReplyMock, 1).mirror).toBeUndefined();
  });

  it("preserves queued verbose progress when default tool progress is suppressed", async () => {
    const onToolStart = vi.fn(async () => {});
    const onCommandOutput = vi.fn(async () => {});
    const queued = createQueuedRun({
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      originatingAccountId: "acct-1",
      originatingThreadId: "thread-1",
      run: {
        messageProvider: "discord",
        sourceReplyDeliveryMode: "message_tool_only",
        verboseLevel: "on",
      },
    });

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (args: {
        onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => Promise<void>;
        onToolResult?: (payload: { text: string }) => Promise<void>;
        shouldEmitToolResult?: () => boolean;
        shouldEmitToolOutput?: () => boolean;
      }) => {
        expect(args.shouldEmitToolResult?.()).toBe(true);
        expect(args.shouldEmitToolOutput?.()).toBe(false);
        await args.onAgentEvent?.({
          stream: "tool",
          data: {
            phase: "start",
            name: "exec",
            args: { command: "echo queued-suppressed-preview" },
          },
        });
        await args.onAgentEvent?.({
          stream: "command_output",
          data: { phase: "chunk", output: "queued output" },
        });
        await args.onToolResult?.({ text: "🛠️ Exec: echo queued-suppressed-preview" });
        return { payloads: [], meta: { agentMeta: {} } };
      },
    );

    const runner = createFollowupRunner({
      opts: { suppressDefaultToolProgressMessages: true, onToolStart, onCommandOutput },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "claude",
      toolProgressDetail: "raw",
    });

    await runner(queued);

    expect(onToolStart).toHaveBeenCalledWith({
      name: "exec",
      phase: "start",
      args: { command: "echo queued-suppressed-preview" },
      detailMode: "raw",
    });
    expect(onCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "chunk", output: "queued output" }),
    );
    expect(routeReplyMock).toHaveBeenCalledTimes(1);
    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:C1",
        accountId: "acct-1",
        threadId: "thread-1",
        mirror: false,
        payload: expect.objectContaining({ text: "🛠️ Exec: echo queued-suppressed-preview" }),
      }),
    );
  });

  it("suppresses queued follow-up progress when verbose progress is disabled", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-followup-progress-off-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { main: sessionEntry };
    const onToolStart = vi.fn(async () => {});
    const onItemEvent = vi.fn(async () => {});
    const onCommandOutput = vi.fn(async () => {});
    registerFollowupTestSessionStore(storePath, sessionStore);

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (args: {
        onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => Promise<void>;
        shouldEmitToolResult?: () => boolean;
        shouldEmitToolOutput?: () => boolean;
      }) => {
        expect(args.shouldEmitToolResult?.()).toBe(false);
        expect(args.shouldEmitToolOutput?.()).toBe(false);
        await args.onAgentEvent?.({
          stream: "tool",
          data: { phase: "start", name: "exec", args: { command: "echo hidden" } },
        });
        await args.onAgentEvent?.({
          stream: "item",
          data: { phase: "start", itemId: "item-1", title: "hidden item" },
        });
        await args.onAgentEvent?.({
          stream: "command_output",
          data: { phase: "chunk", output: "hidden output" },
        });
        await args.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "end", completed: true },
        });
        return { payloads: [{ text: "final" }], meta: { agentMeta: {} } };
      },
    );

    const runner = createFollowupRunner({
      opts: { onToolStart, onItemEvent, onCommandOutput },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "claude",
    });

    await runner(
      createQueuedRun({
        run: {
          messageProvider: "discord",
          sourceReplyDeliveryMode: "message_tool_only",
          verboseLevel: "off",
        },
      }),
    );

    expect(onToolStart).not.toHaveBeenCalled();
    expect(onItemEvent).not.toHaveBeenCalled();
    expect(onCommandOutput).not.toHaveBeenCalled();
    expect(sessionStore.main.compactionCount).toBe(1);
  });
});

describe("createFollowupRunner compaction", () => {
  it("adds verbose auto-compaction notice and tracks count", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});

    mockCompactionRun({
      willRetry: true,
      result: { payloads: [{ text: "final" }], meta: {} },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-6",
    });

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalled();
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toContain("Auto-compaction complete");
    expect(sessionStore.main.compactionCount).toBe(1);
  });

  it("tracks auto-compaction from embedded result metadata even when no compaction event is emitted", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-meta-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile: path.join(path.dirname(storePath), "session.jsonl"),
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {
        agentMeta: {
          sessionId: "session-rotated",
          compactionCount: 2,
          lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-6",
    });

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalled();
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toContain("Auto-compaction complete");
    expect(sessionStore.main.compactionCount).toBe(2);
    expect(sessionStore.main.sessionId).toBe("session-rotated");
    expect(await normalizeComparablePath(sessionStore.main.sessionFile ?? "")).toBe(
      await normalizeComparablePath(path.join(path.dirname(storePath), "session-rotated.jsonl")),
    );
  });

  it("refreshes queued followup runs to the rotated transcript", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-queue-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile: path.join(path.dirname(storePath), "session.jsonl"),
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {
        agentMeta: {
          sessionId: "session-rotated",
          compactionCount: 1,
          lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-6",
    });

    const queuedNext = createQueuedRun({
      prompt: "next",
      run: {
        sessionId: "session",
        sessionFile: path.join(path.dirname(storePath), "session.jsonl"),
      },
    });
    const queueSettings: QueueSettings = { mode: "queue" };
    enqueueFollowupRun("main", queuedNext, queueSettings);

    const current = createQueuedRun({
      run: {
        verboseLevel: "on",
        sessionId: "session",
        sessionFile: path.join(path.dirname(storePath), "session.jsonl"),
      },
    });

    await runner(current);

    expect(queuedNext.run.sessionId).toBe("session-rotated");
    expect(await normalizeComparablePath(queuedNext.run.sessionFile)).toBe(
      await normalizeComparablePath(path.join(path.dirname(storePath), "session-rotated.jsonl")),
    );
  });

  it("does not count failed compaction end events in followup runs", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-failed-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-6",
    });

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    runEmbeddedPiAgentMock.mockImplementationOnce(async (args) => {
      args.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: false, completed: false },
      });
      return {
        payloads: [{ text: "final" }],
        meta: {
          agentMeta: {
            compactionCount: 0,
            lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
          },
        },
      };
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toBe("final");
    expect(sessionStore.main.compactionCount).toBeUndefined();
  });

  it("injects the post-compaction refresh prompt before followup runs after preflight compaction", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-preflight-followup-"));
    const storePath = path.join(workspaceDir, "sessions.json");
    const transcriptPath = path.join(workspaceDir, "session.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        message: {
          role: "user",
          content: "x".repeat(320_000),
          timestamp: Date.now(),
        },
      })}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      [
        "## Session Startup",
        "Read AGENTS.md before replying.",
        "",
        "## Red Lines",
        "Never skip safety checks.",
      ].join("\n"),
      "utf-8",
    );

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile: transcriptPath,
      totalTokens: 10,
      totalTokensFresh: false,
      compactionCount: 1,
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    await saveSessionStore(storePath, sessionStore);

    compactEmbeddedPiSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        tokensBefore: 90_000,
        tokensAfter: 8_000,
      },
    });

    const embeddedCalls: Array<{ extraSystemPrompt?: string }> = [];
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: { extraSystemPrompt?: string }) => {
        embeddedCalls.push({ extraSystemPrompt: params.extraSystemPrompt });
        return {
          payloads: [{ text: "final" }],
          meta: { agentMeta: { usage: { input: 1, output: 1 } } },
        };
      },
    );

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
    });

    const queued = createQueuedRun({
      run: {
        sessionFile: transcriptPath,
        workspaceDir,
      },
    });

    await runner(queued);

    expect(compactEmbeddedPiSessionMock).toHaveBeenCalledOnce();
    expect(embeddedCalls[0]?.extraSystemPrompt).toContain("Post-compaction context refresh");
    expect(embeddedCalls[0]?.extraSystemPrompt).toContain("Read AGENTS.md before replying.");

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store.main?.compactionCount).toBe(2);
  });
});

describe("createFollowupRunner bootstrap warning dedupe", () => {
  it("passes stored warning signature history to embedded followup runs", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: {
          chars: 1,
          projectContextChars: 0,
          nonProjectContextChars: 1,
        },
        injectedWorkspaceFiles: [],
        skills: {
          promptChars: 0,
          entries: [],
        },
        tools: {
          listChars: 0,
          schemaChars: 0,
          entries: [],
        },
        bootstrapTruncation: {
          warningMode: "once",
          warningShown: true,
          promptWarningSignature: "sig-b",
          warningSignaturesSeen: ["sig-a", "sig-b"],
          truncatedFiles: 1,
          nearLimitFiles: 0,
          totalNearLimit: false,
        },
      },
    };
    const sessionStore: Record<string, SessionEntry> = { main: sessionEntry };

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-6",
    });

    await runner(baseQueuedRun());

    const call = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as
      | {
          allowGatewaySubagentBinding?: boolean;
          bootstrapPromptWarningSignaturesSeen?: string[];
          bootstrapPromptWarningSignature?: string;
        }
      | undefined;
    expect(call?.allowGatewaySubagentBinding).toBe(true);
    expect(call?.bootstrapPromptWarningSignaturesSeen).toEqual(["sig-a", "sig-b"]);
    expect(call?.bootstrapPromptWarningSignature).toBe("sig-b");
  });
});

describe("createFollowupRunner messaging tool dedupe", () => {
  function createMessagingDedupeRunner(
    onBlockReply: (payload: unknown) => Promise<void>,
    overrides: Partial<{
      sessionEntry: SessionEntry;
      sessionStore: Record<string, SessionEntry>;
      sessionKey: string;
      storePath: string;
    }> = {},
  ) {
    return createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
      sessionEntry: overrides.sessionEntry,
      sessionStore: overrides.sessionStore,
      sessionKey: overrides.sessionKey,
      storePath: overrides.storePath,
    });
  }

  async function runMessagingCase(params: {
    agentResult: Record<string, unknown>;
    queued?: FollowupRun;
    runnerOverrides?: Partial<{
      sessionEntry: SessionEntry;
      sessionStore: Record<string, SessionEntry>;
      sessionKey: string;
      storePath: string;
    }>;
  }) {
    const onBlockReply = createAsyncReplySpy();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      ...params.agentResult,
    });
    const runner = createMessagingDedupeRunner(onBlockReply, params.runnerOverrides);
    await runner(params.queued ?? baseQueuedRun());
    return { onBlockReply };
  }

  function makeTextReplyDedupeResult(overrides?: Record<string, unknown>) {
    return {
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      ...overrides,
    };
  }

  it("drops payloads already sent via messaging tool", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [{ text: "hello world!" }],
        messagingToolSentTexts: ["hello world!"],
      },
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers payloads when not duplicates", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: makeTextReplyDedupeResult(),
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses replies when a messaging tool sent via the same provider + target", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      },
      queued: baseQueuedRun("slack"),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("suppresses replies when provider is synthetic but originating channel matches", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      },
      queued: {
        ...baseQueuedRun("heartbeat"),
        originatingChannel: "telegram",
        originatingTo: "268300329",
      } as FollowupRun,
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("does not suppress replies for same target when account differs", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [
          { tool: "telegram", provider: "telegram", to: "268300329", accountId: "work" },
        ],
      },
      queued: {
        ...baseQueuedRun("heartbeat"),
        originatingChannel: "telegram",
        originatingTo: "268300329",
        originatingAccountId: "personal",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "268300329",
        accountId: "personal",
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("drops media URL from payload when messaging tool already sent it", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        messagingToolSentMediaUrls: ["/tmp/img.png"],
      },
    });

    // Media stripped → payload becomes non-renderable → not delivered.
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers media payload when not a duplicate", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        messagingToolSentMediaUrls: ["/tmp/other.png"],
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("persists usage even when replies are suppressed", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-followup-usage-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await saveSessionStore(storePath, sessionStore);

    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
        meta: {
          agentMeta: {
            usage: { input: 1_000, output: 50 },
            lastCallUsage: { input: 400, output: 20 },
            model: "claude-opus-4-6",
            provider: "anthropic",
          },
        },
      },
      runnerOverrides: {
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      },
      queued: baseQueuedRun("slack"),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
    const store = loadSessionStore(storePath, { skipCache: true });
    // totalTokens should reflect the last call usage snapshot, not the accumulated input.
    expect(store[sessionKey]?.totalTokens).toBe(400);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-6");
    // Accumulated usage is still stored for usage/cost tracking.
    expect(store[sessionKey]?.inputTokens).toBe(1_000);
    expect(store[sessionKey]?.outputTokens).toBe(50);
  });

  it("passes queued config into usage persistence during drained followups", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-followup-usage-cfg-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await saveSessionStore(storePath, sessionStore);

    const cfg = {
      messages: {
        responsePrefix: "agent",
      },
    };
    const persistSpy = vi.spyOn(sessionRunAccounting, "persistRunSessionUsage");
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      meta: {
        agentMeta: {
          usage: { input: 10, output: 5 },
          lastCallUsage: { input: 6, output: 3 },
          model: "claude-opus-4-6",
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: createAsyncReplySpy() },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
    });

    await expect(
      runner(
        createQueuedRun({
          run: {
            config: cfg,
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath,
        sessionKey,
        cfg,
      }),
    );
    persistSpy.mockRestore();
  });

  it("does not fall back to dispatcher when cross-channel origin routing fails", async () => {
    routeReplyMock.mockResolvedValueOnce({
      ok: false,
      error: "forced route failure",
    });
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: "channel:C1",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("falls back to dispatcher when same-channel origin routing fails", async () => {
    routeReplyMock.mockResolvedValueOnce({
      ok: false,
      error: "outbound adapter unavailable",
    });
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun(" Feishu "),
        originatingChannel: "FEISHU",
        originatingTo: "ou_abc123",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalled();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledWith(expect.objectContaining({ text: "hello world!" }));
  });

  it("routes followups with originating account/thread metadata", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:C1",
        accountId: "work",
        threadId: "1739142736.000100",
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
  });
});

describe("createFollowupRunner typing cleanup", () => {
  async function runTypingCase(agentResult: Record<string, unknown>) {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      ...agentResult,
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: createAsyncReplySpy() },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
    });

    await runner(baseQueuedRun());
    return typing;
  }

  function expectTypingCleanup(typing: ReturnType<typeof createMockTypingController>) {
    expect(typing.markRunComplete).toHaveBeenCalled();
    expect(typing.markDispatchIdle).toHaveBeenCalled();
  }

  it("calls both markRunComplete and markDispatchIdle on NO_REPLY", async () => {
    const typing = await runTypingCase({ payloads: [{ text: "NO_REPLY" }] });
    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on empty payloads", async () => {
    const typing = await runTypingCase({ payloads: [] });
    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on agent error", async () => {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("agent exploded"));

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
    });

    await runner(baseQueuedRun());

    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on successful delivery", async () => {
    const typing = createMockTypingController();
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
    });

    await runner(baseQueuedRun());

    expect(onBlockReply).toHaveBeenCalled();
    expectTypingCleanup(typing);
  });
});

describe("createFollowupRunner agentDir forwarding", () => {
  it("passes queued run agentDir to runEmbeddedPiAgent", async () => {
    runEmbeddedPiAgentMock.mockClear();
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      meta: {},
    });
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
    });
    const agentDir = path.join("/tmp", "agent-dir");
    const queued = createQueuedRun();
    await runner({
      ...queued,
      run: {
        ...queued.run,
        agentDir,
      },
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const call = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as { agentDir?: string };
    expect(call?.agentDir).toBe(agentDir);
  });
});

describe("createFollowupRunner queued user message idempotency across fallback", () => {
  it("suppresses queued user message persistence after first fallback candidate persists it", async () => {
    runEmbeddedPiAgentMock.mockClear();
    runWithModelFallbackMock.mockReset();
    runWithModelFallbackMock.mockImplementationOnce(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        await expect(params.run("anthropic", "claude-opus-4-7")).rejects.toThrow("upstream 500");
        return {
          result: await params.run("openai", "gpt-5.4"),
          provider: "openai",
          model: "gpt-5.4",
        };
      },
    );
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (args: {
        onUserMessagePersisted?: (message: {
          role: "user";
          content: Array<{ type: "text"; text: string }>;
        }) => void;
      }) => {
        args.onUserMessagePersisted?.({
          role: "user",
          content: [{ type: "text", text: "queued message" }],
        });
        throw new Error("upstream 500");
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-7",
    });

    await runner(
      createQueuedRun({
        run: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          suppressNextUserMessagePersistence: false,
        },
      }),
    );

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    const firstAttempt = requireMockCallArg(runEmbeddedPiAgentMock, 0);
    const secondAttempt = requireMockCallArg(runEmbeddedPiAgentMock, 1);
    expect(firstAttempt.suppressNextUserMessagePersistence).toBe(false);
    expect(secondAttempt.suppressNextUserMessagePersistence).toBe(true);
  });

  it("only persists assistant error stub on the first fallback candidate", async () => {
    runEmbeddedPiAgentMock.mockClear();
    runWithModelFallbackMock.mockReset();
    runWithModelFallbackMock.mockImplementationOnce(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        await expect(params.run("anthropic", "claude-opus-4-7")).rejects.toThrow("upstream 500");
        await expect(params.run("anthropic", "claude-opus-4-6")).rejects.toThrow("upstream 500");
        return {
          result: await params.run("openai", "gpt-5.4"),
          provider: "openai",
          model: "gpt-5.4",
        };
      },
    );
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (args: {
        onAssistantErrorMessagePersisted?: (message: {
          role: "assistant";
          content: string;
          stopReason: "error";
        }) => void;
      }) => {
        args.onAssistantErrorMessagePersisted?.({
          role: "assistant",
          content: "[assistant turn failed before producing content]",
          stopReason: "error",
        });
        throw new Error("upstream 500");
      },
    );
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("upstream 500"));
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-7",
    });

    await runner(
      createQueuedRun({
        run: {
          provider: "anthropic",
          model: "claude-opus-4-7",
        },
      }),
    );

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(3);
    const firstAttempt = requireMockCallArg(runEmbeddedPiAgentMock, 0);
    const secondAttempt = requireMockCallArg(runEmbeddedPiAgentMock, 1);
    const thirdAttempt = requireMockCallArg(runEmbeddedPiAgentMock, 2);
    expect(firstAttempt.suppressAssistantErrorPersistence).toBe(false);
    expect(secondAttempt.suppressAssistantErrorPersistence).toBe(true);
    expect(thirdAttempt.suppressAssistantErrorPersistence).toBe(true);
  });

  it("does not suppress when no fallback candidate persisted the queued message", async () => {
    runEmbeddedPiAgentMock.mockClear();
    runWithModelFallbackMock.mockReset();
    runWithModelFallbackMock.mockImplementationOnce(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        await expect(params.run("anthropic", "claude-opus-4-7")).rejects.toThrow("upstream early");
        return {
          result: await params.run("openai", "gpt-5.4"),
          provider: "openai",
          model: "gpt-5.4",
        };
      },
    );
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("upstream early"));
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-7",
    });

    await runner(
      createQueuedRun({
        run: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          suppressNextUserMessagePersistence: false,
        },
      }),
    );

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    const firstAttempt = requireMockCallArg(runEmbeddedPiAgentMock, 0);
    const secondAttempt = requireMockCallArg(runEmbeddedPiAgentMock, 1);
    expect(firstAttempt.suppressNextUserMessagePersistence).toBe(false);
    expect(secondAttempt.suppressNextUserMessagePersistence).toBe(false);
    expect(secondAttempt.suppressAssistantErrorPersistence).toBe(false);
  });
});

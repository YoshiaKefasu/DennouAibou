import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { createChatHandlers } from "./chat.js";
import type { GatewayRequestContext } from "./types.js";

const mockState = {
  transcriptPath: "",
  sessionId: "sess-1",
  cfg: {} as Record<string, unknown>,
  sessionEntry: {} as Record<string, unknown>,
  lastDispatchCtx: undefined as MsgContext | undefined,
};

const chatHandlers = createChatHandlers({
  loadSessionEntry: (rawKey: string) => ({
    cfg: mockState.cfg,
    storePath: path.join(path.dirname(mockState.transcriptPath), "sessions.json"),
    store: {},
    entry: {
      sessionId: mockState.sessionId,
      sessionFile: mockState.transcriptPath,
      updatedAt: Date.now(),
      ...mockState.sessionEntry,
    },
    canonicalKey: rawKey || "agent:main:main",
    legacyKey: undefined,
  }),
  dispatchInboundMessage: async (params) => {
    mockState.lastDispatchCtx = params.ctx;
    params.dispatcher.sendFinalReply({ text: "ok" });
    params.dispatcher.markComplete();
    await params.dispatcher.waitForIdle();
    return { ok: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } };
  },
  emitSessionTranscriptUpdate: () => {},
});

function createTranscriptFixture(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const transcriptPath = path.join(dir, "sess.jsonl");
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: mockState.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: "/tmp",
    })}\n`,
    "utf-8",
  );
  mockState.transcriptPath = transcriptPath;
}

function createWebchatClient() {
  return {
    connId: "webchat-conn-1",
    connect: {
      scopes: ["operator.write"],
      client: {
        id: "webchat-ui",
        mode: "webchat",
        displayName: "WebChat",
        version: "1.0.0",
      },
    },
  };
}

function createChatContext() {
  return {
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map<string, number>(),
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatAbortedRuns: new Map(),
    removeChatRun: vi.fn(),
    dedupe: new Map(),
    loadGatewayModelCatalog: async () => [],
    registerToolEventRecipient: vi.fn(),
    logGateway: { warn: vi.fn(), debug: vi.fn() },
  };
}

async function runChatSend(params: { idempotencyKey: string; client: unknown; deliver?: boolean }) {
  createTranscriptFixture("openclaw-chat-deliver-active-");
  const respond = vi.fn();
  const context = createChatContext();
  const sendParams: Record<string, unknown> = {
    sessionKey: "agent:main:main",
    message: "hello",
    idempotencyKey: params.idempotencyKey,
  };
  if (typeof params.deliver === "boolean") {
    sendParams.deliver = params.deliver;
  }
  await chatHandlers["chat.send"]({
    params: sendParams as never,
    respond: respond as never,
    req: {} as never,
    client: params.client as never,
    isWebchatConnect: () => false,
    context: context as unknown as GatewayRequestContext,
  });
  const startedAt = Date.now();
  for (;;) {
    if (context.dedupe.has(`chat:${params.idempotencyKey}`)) {
      break;
    }
    if (Date.now() - startedAt > 4_000) {
      throw new Error("timed out waiting for chat.send completion");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("chat.send deliverToActiveChannel", () => {
  afterEach(() => {
    mockState.cfg = {};
    mockState.sessionEntry = {};
    mockState.lastDispatchCtx = undefined;
  });

  it("resolves the active external route for webchat sends when enabled", async () => {
    mockState.cfg = { gateway: { chat: { deliverToActiveChannel: true } } };
    mockState.sessionEntry = { lastChannel: "telegram", lastTo: "chat-123" };

    await runChatSend({ idempotencyKey: "idem-active-on", client: createWebchatClient() });

    expect(mockState.lastDispatchCtx).toEqual(
      expect.objectContaining({
        OriginatingChannel: "telegram",
        OriginatingTo: "chat-123",
        ExplicitDeliverRoute: true,
      }),
    );
  });

  it("keeps webchat sends internal by default (flag off)", async () => {
    mockState.cfg = {};
    mockState.sessionEntry = { lastChannel: "telegram", lastTo: "chat-123" };

    await runChatSend({ idempotencyKey: "idem-active-off", client: createWebchatClient() });

    expect(mockState.lastDispatchCtx).toEqual(
      expect.objectContaining({
        OriginatingChannel: "webchat",
        ExplicitDeliverRoute: false,
      }),
    );
  });
});

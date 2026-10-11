/**
 * agent-runner — Steer 重複防止（Premortem #145 シナリオ 2）の単体テスト
 *
 * 修正内容 (src/auto-reply/reply/agent-runner.ts):
 * - `if (steered && !shouldFollowup)` → `if (steered)`: ライブセッションへの Steer 注入が
 *   成功したら followup キューへの二重投入を防ぐため無条件 early return する。
 *   （steer 不発 `false` の時だけ、後続の shouldFollowup によるフォールバック投入へ進む）
 *
 * 検証する2経路:
 * 1. steer 注入成功（queueEmbeddedPiMessage → true）: followup キューに入らず早期 return
 * 2. steer 注入不発（→ false）: 従来どおり shouldFollowup により followup キューへフォールバック
 *
 * モックは `vi.hoisted` で生成し、vi.mock ファクトリのホイスティング TDZ を避ける。
 * （既存の misc テストファイルには触れず、Steer 経路だけを隔離して検証する）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const state = vi.hoisted(() => ({
  queueEmbeddedPiMessageMock: vi.fn(() => false),
  enqueueFollowupRunMock: vi.fn(),
  runEmbeddedPiAgentMock: vi.fn(),
  scheduleFollowupDrainMock: vi.fn(),
  refreshQueuedFollowupSessionMock: vi.fn(async () => {}),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  compactEmbeddedPiSession: vi.fn(),
  queueEmbeddedPiMessage: state.queueEmbeddedPiMessageMock,
  runEmbeddedPiAgent: state.runEmbeddedPiAgentMock,
}));

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: state.enqueueFollowupRunMock,
  refreshQueuedFollowupSession: state.refreshQueuedFollowupSessionMock,
  scheduleFollowupDrain: state.scheduleFollowupDrainMock,
}));

const { runReplyAgent } = await import("./agent-runner.js");

beforeEach(() => {
  state.queueEmbeddedPiMessageMock.mockClear();
  state.enqueueFollowupRunMock.mockClear();
  state.runEmbeddedPiAgentMock.mockClear();
  state.scheduleFollowupDrainMock.mockClear();
  state.refreshQueuedFollowupSessionMock.mockClear();
});

/** misc テストの createRun 相当: Steer 分岐まで到達する最小パラメータ構成。 */
function createSteerRun(params?: { shouldFollowup?: boolean }) {
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "webchat",
    OriginatingTo: "session:1",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "webchat",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: { agents: { defaults: {} } },
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;

  return runReplyAgent({
    commandBody: "hello",
    followupRun,
    queueKey: "main",
    resolvedQueue,
    shouldSteer: true,
    shouldFollowup: params?.shouldFollowup ?? true,
    isActive: true,
    isStreaming: false,
    typing,
    sessionCtx,
    defaultModel: "anthropic/claude",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  });
}

describe("runReplyAgent steer dedup", () => {
  it("returns early without followup double-enqueue when live steer succeeds", async () => {
    state.queueEmbeddedPiMessageMock.mockReturnValueOnce(true);

    const result = await createSteerRun({ shouldFollowup: true });

    expect(result).toBeUndefined();
    expect(state.queueEmbeddedPiMessageMock).toHaveBeenCalledTimes(1);
    // Steer 注入成功時は followup キューへ落とさない（同一メッセージの二重処理防止）
    expect(state.enqueueFollowupRunMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("falls back to the followup queue when live steer injection fails", async () => {
    state.queueEmbeddedPiMessageMock.mockReturnValueOnce(false);

    const result = await createSteerRun({ shouldFollowup: true });

    expect(result).toBeUndefined();
    expect(state.queueEmbeddedPiMessageMock).toHaveBeenCalledTimes(1);
    // steer 不発時のみ followup キューへフォールバックする（従来動作）
    expect(state.enqueueFollowupRunMock).toHaveBeenCalledTimes(1);
    expect(state.runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
});

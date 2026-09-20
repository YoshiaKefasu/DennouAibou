import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectsSubagentFollowup, isLikelyInterimCronMessage } from "./subagent-followup-hints.js";
import {
  readDescendantSubagentFallbackReply,
  waitForDescendantSubagentSummary,
  type SubagentFollowupDeps,
} from "./subagent-followup.js";

type DescendantRun = ReturnType<typeof createDescendantRun>;
const listDescendantRunsForRequesterMock = vi.fn<() => DescendantRun[]>(() => []);
const readLatestAssistantReplyMock = vi.fn<
  (params: { sessionKey: string }) => Promise<string | undefined>
>(async () => undefined);
const callGatewayMock = vi.fn<() => Promise<{ status: string }>>(async () => ({ status: "ok" }));
const waitForAgentRunsToDrainMock = vi.fn(
  async (params: { getPendingRunIds: () => Iterable<string> }) => ({
    timedOut: false,
    pendingRunIds: [...params.getPendingRunIds()],
    deadlineAtMs: 0,
  }),
);

const deps: SubagentFollowupDeps = {
  listDescendantRunsForRequester: listDescendantRunsForRequesterMock,
  readLatestAssistantReply: readLatestAssistantReplyMock,
  waitForAgentRunsToDrain: waitForAgentRunsToDrainMock,
  callGateway: callGatewayMock as unknown as SubagentFollowupDeps["callGateway"],
  timings: { waitMinMs: 10, finalReplyGraceMs: 50, gracePollMs: 8 },
};

function createDescendantRun(params?: {
  runId?: string;
  childSessionKey?: string;
  task?: string;
  cleanup?: "keep" | "delete";
  endedAt?: number;
  frozenResultText?: string | null;
}) {
  return {
    runId: params?.runId ?? "run-1",
    childSessionKey: params?.childSessionKey ?? "child-1",
    requesterSessionKey: "test-session",
    requesterDisplayKey: "test-session",
    task: params?.task ?? "task-1",
    cleanup: params?.cleanup ?? "keep",
    createdAt: 1000,
    endedAt: params?.endedAt ?? 2000,
    ...(params?.frozenResultText === undefined
      ? {}
      : { frozenResultText: params.frozenResultText }),
  };
}

const readFallback = (params: { sessionKey: string; runStartedAt: number }) =>
  readDescendantSubagentFallbackReply(params, deps);
const waitSummary = (params: {
  sessionKey: string;
  initialReply?: string;
  timeoutMs: number;
  observedActiveDescendants?: boolean;
}) => waitForDescendantSubagentSummary(params, deps);

describe("isLikelyInterimCronMessage", () => {
  it("detects 'on it' as interim", () => {
    expect(isLikelyInterimCronMessage("on it")).toBe(true);
  });
  it("detects subagent-related interim text", () => {
    expect(isLikelyInterimCronMessage("spawned a subagent, it'll auto-announce when done")).toBe(
      true,
    );
  });
  it("rejects substantive content", () => {
    expect(isLikelyInterimCronMessage("Here are your results: revenue was $5000 this month")).toBe(
      false,
    );
  });
  it("does not treat empty as interim", () => {
    expect(isLikelyInterimCronMessage("")).toBe(false);
  });
  it("does not treat whitespace-only as interim", () => {
    expect(isLikelyInterimCronMessage("   ")).toBe(false);
  });
});

describe("expectsSubagentFollowup", () => {
  it("returns true for subagent spawn hints", () => {
    expect(expectsSubagentFollowup("subagent spawned")).toBe(true);
    expect(expectsSubagentFollowup("spawned a subagent")).toBe(true);
    expect(expectsSubagentFollowup("it'll auto-announce when done")).toBe(true);
    expect(expectsSubagentFollowup("both subagents are running")).toBe(true);
  });
  it("returns false for plain interim text", () => {
    expect(expectsSubagentFollowup("on it")).toBe(false);
    expect(expectsSubagentFollowup("working on it")).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(expectsSubagentFollowup("")).toBe(false);
  });
});

describe("readDescendantSubagentFallbackReply", () => {
  const runStartedAt = 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    listDescendantRunsForRequesterMock.mockReturnValue([]);
    readLatestAssistantReplyMock.mockResolvedValue(undefined);
  });

  it("returns undefined when no descendants exist", async () => {
    await expect(
      readFallback({ sessionKey: "test-session", runStartedAt }),
    ).resolves.toBeUndefined();
  });

  it("reads reply from child session transcript", async () => {
    listDescendantRunsForRequesterMock.mockReturnValue([createDescendantRun()]);
    readLatestAssistantReplyMock.mockResolvedValue("child output text");
    await expect(readFallback({ sessionKey: "test-session", runStartedAt })).resolves.toBe(
      "child output text",
    );
  });

  it("falls back to frozenResultText when session transcript unavailable", async () => {
    listDescendantRunsForRequesterMock.mockReturnValue([
      createDescendantRun({ cleanup: "delete", frozenResultText: "frozen child output" }),
    ]);
    await expect(readFallback({ sessionKey: "test-session", runStartedAt })).resolves.toBe(
      "frozen child output",
    );
  });

  it("prefers session transcript over frozenResultText", async () => {
    listDescendantRunsForRequesterMock.mockReturnValue([
      createDescendantRun({ frozenResultText: "frozen text" }),
    ]);
    readLatestAssistantReplyMock.mockResolvedValue("live transcript text");
    await expect(readFallback({ sessionKey: "test-session", runStartedAt })).resolves.toBe(
      "live transcript text",
    );
  });

  it("joins replies from multiple descendants", async () => {
    listDescendantRunsForRequesterMock.mockReturnValue([
      createDescendantRun({ frozenResultText: "first child output" }),
      createDescendantRun({
        runId: "run-2",
        childSessionKey: "child-2",
        task: "task-2",
        endedAt: 3000,
        frozenResultText: "second child output",
      }),
    ]);
    await expect(readFallback({ sessionKey: "test-session", runStartedAt })).resolves.toBe(
      "first child output\n\nsecond child output",
    );
  });

  it("skips SILENT_REPLY_TOKEN descendants", async () => {
    listDescendantRunsForRequesterMock.mockReturnValue([
      createDescendantRun(),
      createDescendantRun({
        runId: "run-2",
        childSessionKey: "child-2",
        task: "task-2",
        endedAt: 3000,
        frozenResultText: "useful output",
      }),
    ]);
    readLatestAssistantReplyMock.mockImplementation(
      async ({ sessionKey }: { sessionKey: string }) =>
        sessionKey === "child-1" ? "NO_REPLY" : undefined,
    );
    await expect(readFallback({ sessionKey: "test-session", runStartedAt })).resolves.toBe(
      "useful output",
    );
  });

  it("returns undefined when frozenResultText is null", async () => {
    listDescendantRunsForRequesterMock.mockReturnValue([
      createDescendantRun({ cleanup: "delete", frozenResultText: null }),
    ]);
    await expect(
      readFallback({ sessionKey: "test-session", runStartedAt }),
    ).resolves.toBeUndefined();
  });

  it("ignores descendants that ended before run started", async () => {
    listDescendantRunsForRequesterMock.mockReturnValue([
      createDescendantRun({ endedAt: 900, frozenResultText: "stale output" }),
    ]);
    await expect(
      readFallback({ sessionKey: "test-session", runStartedAt }),
    ).resolves.toBeUndefined();
  });
});

describe("waitForDescendantSubagentSummary", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    listDescendantRunsForRequesterMock.mockReturnValue([]);
    readLatestAssistantReplyMock.mockResolvedValue(undefined);
    callGatewayMock.mockResolvedValue({ status: "ok" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns initialReply immediately when no active descendants", async () => {
    await expect(
      waitSummary({
        sessionKey: "cron-session",
        initialReply: "on it",
        timeoutMs: 100,
        observedActiveDescendants: false,
      }),
    ).resolves.toBe("on it");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("awaits active descendants and returns synthesis", async () => {
    listDescendantRunsForRequesterMock
      .mockReturnValueOnce([
        {
          ...createDescendantRun(),
          runId: "run-abc",
          childSessionKey: "child-session",
          requesterSessionKey: "cron-session",
          requesterDisplayKey: "cron-session",
          endedAt: undefined as unknown as number,
        },
      ])
      .mockReturnValue([]);
    readLatestAssistantReplyMock.mockResolvedValue("Morning briefing complete!");
    await expect(
      waitSummary({
        sessionKey: "cron-session",
        initialReply: "on it",
        timeoutMs: 30_000,
        observedActiveDescendants: true,
      }),
    ).resolves.toBe("Morning briefing complete!");
  });

  it("returns undefined when only interim text remains", async () => {
    readLatestAssistantReplyMock.mockResolvedValue("on it");
    await expect(
      waitSummary({
        sessionKey: "cron-session",
        initialReply: "on it",
        timeoutMs: 100,
        observedActiveDescendants: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("returns synthesis when initial reply was undefined", async () => {
    listDescendantRunsForRequesterMock
      .mockReturnValueOnce([{ ...createDescendantRun(), endedAt: undefined as unknown as number }])
      .mockReturnValue([]);
    readLatestAssistantReplyMock.mockResolvedValue("Report generated successfully.");
    await expect(
      waitSummary({
        sessionKey: "cron-session",
        timeoutMs: 30_000,
        observedActiveDescendants: true,
      }),
    ).resolves.toBe("Report generated successfully.");
  });

  it("waits for multiple active runs", async () => {
    listDescendantRunsForRequesterMock
      .mockReturnValueOnce([
        { ...createDescendantRun(), runId: "run-1", endedAt: undefined as unknown as number },
        {
          ...createDescendantRun(),
          runId: "run-2",
          childSessionKey: "child-2",
          endedAt: undefined as unknown as number,
        },
      ])
      .mockReturnValue([]);
    readLatestAssistantReplyMock.mockResolvedValue("All tasks complete.");
    await waitSummary({
      sessionKey: "cron-session",
      initialReply: "spawned a subagent",
      timeoutMs: 30_000,
      observedActiveDescendants: true,
    });
    expect(waitForAgentRunsToDrainMock).toHaveBeenCalledTimes(1);
  });

  it("handles agent.wait errors through the injected drain helper", async () => {
    listDescendantRunsForRequesterMock
      .mockReturnValueOnce([
        { ...createDescendantRun(), runId: "run-err", endedAt: undefined as unknown as number },
      ])
      .mockReturnValue([]);
    readLatestAssistantReplyMock.mockResolvedValue("Completed despite gateway error.");
    await expect(
      waitSummary({
        sessionKey: "cron-session",
        initialReply: "on it",
        timeoutMs: 30_000,
        observedActiveDescendants: true,
      }),
    ).resolves.toBe("Completed despite gateway error.");
  });

  it("skips NO_REPLY synthesis", async () => {
    readLatestAssistantReplyMock.mockResolvedValue("NO_REPLY");
    await expect(
      waitSummary({
        sessionKey: "cron-session",
        initialReply: "on it",
        timeoutMs: 100,
        observedActiveDescendants: true,
      }),
    ).resolves.toBeUndefined();
  });
});

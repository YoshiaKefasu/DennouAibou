import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollUntilAssert } from "../../test/helpers/poll.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  updateSessionStore,
} from "../config/sessions.js";
import { ensureContextEnginesInitialized } from "../context-engine/init.js";
import { resolveContextEngine } from "../context-engine/registry.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { ensureRuntimePluginsLoaded } from "./runtime-plugins.js";
import { captureSubagentCompletionReply, runSubagentAnnounceFlow } from "./subagent-announce.js";
import { resolveSubagentRunOrphanReason } from "./subagent-registry-helpers.js";
import {
  getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import { __testing as registryTesting } from "./subagent-registry.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

const noop = () => {};

const mocks = {
  callGateway: vi.fn<typeof callGateway>(),
  onAgentEvent: vi.fn<typeof onAgentEvent>(() => noop),
  loadConfig: vi.fn<typeof loadConfig>(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    session: { mainKey: "main", scope: "per-sender" },
  })),
  loadSessionStore: vi.fn<typeof loadSessionStore>(() => ({})),
  resolveAgentIdFromSessionKey: vi.fn<typeof resolveAgentIdFromSessionKey>(
    (sessionKey: string | null | undefined) => {
      return (sessionKey ?? "").match(/^agent:([^:]+)/)?.[1] ?? "main";
    },
  ),
  resolveStorePath: vi.fn<typeof resolveStorePath>(() => "/tmp/test-session-store.json"),
  updateSessionStore: vi.fn<typeof updateSessionStore>(),
  emitSessionLifecycleEvent: vi.fn<typeof emitSessionLifecycleEvent>(),
  persistSubagentRunsToDisk: vi.fn<typeof persistSubagentRunsToDisk>(),
  restoreSubagentRunsFromDisk: vi.fn<typeof restoreSubagentRunsFromDisk>(() => 0),
  getSubagentRunsSnapshotForRead: vi.fn<typeof getSubagentRunsSnapshotForRead>(
    (runs) => new Map(runs),
  ),
  captureSubagentCompletionReply: vi.fn<typeof captureSubagentCompletionReply>(
    async () => "final completion reply",
  ),
  runSubagentAnnounceFlow: vi.fn<typeof runSubagentAnnounceFlow>(async () => true),
  getGlobalHookRunner: vi.fn<typeof getGlobalHookRunner>(() => null),
  ensureRuntimePluginsLoaded: vi.fn<typeof ensureRuntimePluginsLoaded>(),
  ensureContextEnginesInitialized: vi.fn<typeof ensureContextEnginesInitialized>(),
  resolveContextEngine: vi.fn<typeof resolveContextEngine>(),
  onSubagentEnded: vi.fn(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
  resolveAgentTimeoutMs: vi.fn<typeof resolveAgentTimeoutMs>(() => 1_000),
};

import * as mod from "./subagent-registry.js";

describe("subagent registry seam flow", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.onAgentEvent.mockReturnValue(noop);
    mocks.loadConfig.mockReturnValue({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" },
    });
    mocks.resolveAgentIdFromSessionKey.mockImplementation(
      (sessionKey: string | null | undefined) => {
        return (sessionKey ?? "").match(/^agent:([^:]+)/)?.[1] ?? "main";
      },
    );
    mocks.resolveStorePath.mockReturnValue("/tmp/test-session-store.json");
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
      },
    });
    mocks.getGlobalHookRunner.mockReturnValue(null);
    mocks.resolveContextEngine.mockResolvedValue({
      info: { id: "test", name: "test" },
      ingest: async () => ({ ingested: false }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      onSubagentEnded: mocks.onSubagentEnded,
    });
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "ok",
          startedAt: 111,
          endedAt: 222,
        };
      }
      return {};
    });
    registryTesting.setDepsForTest({
      callGateway: mocks.callGateway as never,
      onAgentEvent: mocks.onAgentEvent,
      loadConfig: mocks.loadConfig,
      persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
      restoreSubagentRunsFromDisk: mocks.restoreSubagentRunsFromDisk,
      getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
      captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
      runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
      ensureRuntimePluginsLoaded: mocks.ensureRuntimePluginsLoaded,
      ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
      resolveContextEngine: mocks.resolveContextEngine,
      resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
      getGlobalHookRunner: mocks.getGlobalHookRunner,
      emitSessionLifecycleEvent: mocks.emitSessionLifecycleEvent,
      sessionDeps: {
        loadConfig: mocks.loadConfig,
        loadSessionStore: mocks.loadSessionStore,
        resolveAgentIdFromSessionKey: mocks.resolveAgentIdFromSessionKey,
        resolveStorePath: mocks.resolveStorePath,
        updateSessionStore: mocks.updateSessionStore as never,
      },
    });
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    mod.resetSubagentRegistryForTests({ persist: false });
    registryTesting.setDepsForTest();
  });

  it("completes a registered run across timing persistence, lifecycle status, and announce cleanup", async () => {
    // Note: real timers are used (Bun lacks vi.advanceTimersByTimeAsync), so
    // sessionStartedAt is captured relative to Date.now() at registration.
    const beforeRegister = Date.now();
    mod.registerSubagentRun({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: " discord ", accountId: " acct-1 " },
      requesterDisplayKey: "main",
      task: "finish the task",
      cleanup: "delete",
    });

    await pollUntilAssert(
      () => {
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      },
      { timeoutMs: 3_000 },
    );

    expect(mocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      reason: "subagent-status",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionKey: "agent:main:subagent:child",
        childRunId: "run-1",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: { channel: "discord", accountId: "acct-1" },
        task: "finish the task",
        cleanup: "delete",
        roundOneReply: "final completion reply",
        outcome: { status: "ok" },
      }),
    );

    expect(mocks.updateSessionStore).toHaveBeenCalledTimes(1);
    expect(mocks.updateSessionStore).toHaveBeenCalledWith(
      "/tmp/test-session-store.json",
      expect.any(Function),
    );

    const updateStore = mocks.updateSessionStore.mock.calls[0]?.[1] as
      | ((store: Record<string, Record<string, unknown>>) => void)
      | undefined;
    expect(updateStore).toBeTypeOf("function");
    const store = {
      "agent:main:subagent:child": {
        sessionId: "sess-child",
      },
    };
    updateStore?.(store);
    expect(store["agent:main:subagent:child"]).toMatchObject({
      endedAt: 222,
      runtimeMs: 111,
      status: "done",
    });
    const storedStartedAt = (store["agent:main:subagent:child"] as { startedAt?: unknown })
      .startedAt;
    expect(typeof storedStartedAt).toBe("number");
    expect(storedStartedAt as number).toBeGreaterThanOrEqual(beforeRegister);
    expect(storedStartedAt as number).toBeLessThanOrEqual(Date.now());

    expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalled();
  });

  it("deletes delete-mode completion runs when announce cleanup gives up after retry limit", async () => {
    mocks.runSubagentAnnounceFlow.mockResolvedValue(false);
    // Note: real timers are used (Bun lacks vi.advanceTimersByTimeAsync), so
    // endedAt stays recent to avoid the 30min completion hard-expiry give-up.
    // Retry delays are 1s -> 2s -> give-up (MAX_ANNOUNCE_RETRY_COUNT=3).
    const endedAt = Date.now();
    mocks.callGateway.mockResolvedValueOnce({
      status: "ok",
      startedAt: endedAt - 500,
      endedAt,
    });

    mod.registerSubagentRun({
      runId: "run-delete-give-up",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "completion cleanup retry",
      cleanup: "delete",
      expectsCompletionMessage: true,
    });

    await pollUntilAssert(
      () => {
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      },
      { timeoutMs: 5_000 },
    );
    // Note: lower-bound backoff check (1s -> 2s). Poll granularity only
    // shortens observed gaps, so >=800ms catches shrunken/missing backoff.
    const firstAnnounceAt = Date.now();
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-delete-give-up"),
    ).toBeDefined();

    await pollUntilAssert(
      () => {
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
      },
      { timeoutMs: 5_000 },
    );
    const secondAnnounceAt = Date.now();
    expect(secondAnnounceAt - firstAnnounceAt).toBeGreaterThanOrEqual(800);

    await pollUntilAssert(
      () => {
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(3);
      },
      { timeoutMs: 5_000 },
    );
    expect(Date.now() - secondAnnounceAt).toBeGreaterThanOrEqual(800);

    await pollUntilAssert(
      () => {
        expect(
          mod
            .listSubagentRunsForRequester("agent:main:main")
            .find((entry) => entry.runId === "run-delete-give-up"),
        ).toBeUndefined();
      },
      { timeoutMs: 5_000 },
    );
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(3);
  });

  it("finalizes retry-budgeted completion delete runs during resume", async () => {
    const endedHookRunner = {
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    };
    mocks.getGlobalHookRunner.mockReturnValue(endedHookRunner as never);
    // Note: relative fixture (was fixed 2026-03-24 under fake timers).
    // Retry budget (3/3) is exhausted, so resume gives up immediately.
    const now = Date.now();
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set("run-resume-delete", {
        runId: "run-resume-delete",
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "resume delete retry budget",
        cleanup: "delete",
        createdAt: now - 120_000,
        startedAt: now - 60_000,
        endedAt: now - 30_000,
        expectsCompletionMessage: true,
        announceRetryCount: 3,
        lastAnnounceRetryAt: now - 20_000,
      });
      return 1;
    }) as never);

    mod.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    await pollUntilAssert(
      () => {
        expect(mocks.runSubagentEnded).toHaveBeenCalledTimes(1);
      },
      { timeoutMs: 3_000 },
    );
    await pollUntilAssert(
      () => {
        expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
          childSessionKey: "agent:main:subagent:child",
          reason: "deleted",
          workspaceDir: undefined,
        });
      },
      { timeoutMs: 3_000 },
    );
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-resume-delete"),
    ).toBeUndefined();
  });

  it("finalizes expired delete-mode parents when descendant cleanup retriggers deferred announce handling", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:parent": {
        sessionId: "sess-parent",
        updatedAt: 1,
      },
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
      },
    });

    // Note: relative fixture (was fixed 2026-03-24 under fake timers).
    // Parent stays expired (>5min) on any machine clock.
    const now = Date.now();
    mod.addSubagentRunForTests({
      runId: "run-parent-expired",
      childSessionKey: "agent:main:subagent:parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "expired parent cleanup",
      cleanup: "delete",
      createdAt: now - 10 * 60_000,
      startedAt: now - 9 * 60_000 - 30_000,
      endedAt: now - 9 * 60_000,
      cleanupHandled: false,
      cleanupCompletedAt: undefined,
    });

    mod.registerSubagentRun({
      runId: "run-child-finished",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "parent",
      task: "descendant settles",
      cleanup: "keep",
    });

    await pollUntilAssert(
      () => {
        expect(
          mod
            .listSubagentRunsForRequester("agent:main:main")
            .find((entry) => entry.runId === "run-parent-expired"),
        ).toBeUndefined();
      },
      { timeoutMs: 3_000 },
    );

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        childRunId: "run-child-finished",
      }),
    );
    await pollUntilAssert(
      () => {
        expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
          childSessionKey: "agent:main:subagent:parent",
          reason: "deleted",
          workspaceDir: undefined,
        });
      },
      { timeoutMs: 3_000 },
    );
  });

  it("loads runtime plugins before emitting killed subagent ended hooks", async () => {
    const endedHookRunner = {
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    };
    mocks.getGlobalHookRunner.mockReturnValue(null);
    mocks.ensureRuntimePluginsLoaded.mockImplementation(() => {
      mocks.getGlobalHookRunner.mockReturnValue(endedHookRunner as never);
    });

    mod.registerSubagentRun({
      runId: "run-killed-init",
      childSessionKey: "agent:main:subagent:killed",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", accountId: "acct-1" },
      task: "kill after init",
      cleanup: "keep",
      workspaceDir: "/tmp/killed-workspace",
    });

    const updated = mod.markSubagentRunTerminated({
      runId: "run-killed-init",
      reason: "manual kill",
    });

    expect(updated).toBe(1);
    await pollUntilAssert(
      () => {
        expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
          config: {
            agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
            session: { mainKey: "main", scope: "per-sender" },
          },
          workspaceDir: "/tmp/killed-workspace",
          allowGatewaySubagentBinding: true,
        });
      },
      { timeoutMs: 3_000 },
    );
    expect(mocks.runSubagentEnded).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: "agent:main:subagent:killed",
        reason: "subagent-killed",
        accountId: "acct-1",
        runId: "run-killed-init",
        outcome: "killed",
        error: "manual kill",
      }),
      expect.objectContaining({
        runId: "run-killed-init",
        childSessionKey: "agent:main:subagent:killed",
        requesterSessionKey: "agent:main:main",
      }),
    );
  });

  it("deletes killed delete-mode runs and notifies deleted cleanup", async () => {
    mod.registerSubagentRun({
      runId: "run-killed-delete",
      childSessionKey: "agent:main:subagent:killed-delete",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "kill and delete",
      cleanup: "delete",
      workspaceDir: "/tmp/killed-delete-workspace",
    });

    const updated = mod.markSubagentRunTerminated({
      runId: "run-killed-delete",
      reason: "manual kill",
    });

    expect(updated).toBe(1);
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-killed-delete"),
    ).toBeUndefined();
    await pollUntilAssert(
      () => {
        expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
          childSessionKey: "agent:main:subagent:killed-delete",
          reason: "deleted",
          workspaceDir: "/tmp/killed-delete-workspace",
        });
      },
      { timeoutMs: 3_000 },
    );
  });

  it("removes attachments for killed delete-mode runs", async () => {
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-kill-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");

    mod.registerSubagentRun({
      runId: "run-killed-delete-attachments",
      childSessionKey: "agent:main:subagent:killed-delete-attachments",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "kill and delete attachments",
      cleanup: "delete",
      attachmentsDir,
      attachmentsRootDir,
    });

    const updated = mod.markSubagentRunTerminated({
      runId: "run-killed-delete-attachments",
      reason: "manual kill",
    });

    expect(updated).toBe(1);
    await pollUntilAssert(
      async () => {
        await expect(fs.access(attachmentsDir)).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { timeoutMs: 3_000 },
    );
  });

  it("removes attachments for released delete-mode runs", async () => {
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-release-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");

    mod.addSubagentRunForTests({
      runId: "run-release-delete",
      childSessionKey: "agent:main:subagent:release-delete",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: undefined,
      requesterDisplayKey: "main",
      task: "release attachments",
      cleanup: "delete",
      expectsCompletionMessage: undefined,
      spawnMode: "run",
      attachmentsDir,
      attachmentsRootDir,
      createdAt: 1,
      startedAt: 1,
      sessionStartedAt: 1,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
    });

    mod.releaseSubagentRun("run-release-delete");

    await pollUntilAssert(
      async () => {
        await expect(fs.access(attachmentsDir)).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { timeoutMs: 3_000 },
    );
    await pollUntilAssert(
      () => {
        expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
          childSessionKey: "agent:main:subagent:release-delete",
          reason: "released",
          workspaceDir: undefined,
        });
      },
      { timeoutMs: 3_000 },
    );
  });

  it("loads plugin and context-engine runtime before released end hooks", async () => {
    mod.addSubagentRunForTests({
      runId: "run-release-context-engine",
      childSessionKey: "agent:main:session:child",
      controllerSessionKey: "agent:main:session:parent",
      requesterSessionKey: "agent:main:session:parent",
      requesterOrigin: undefined,
      requesterDisplayKey: "parent",
      task: "task",
      cleanup: "keep",
      expectsCompletionMessage: undefined,
      spawnMode: "run",
      workspaceDir: "/tmp/workspace",
      createdAt: 1,
      startedAt: 1,
      sessionStartedAt: 1,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
    });

    mod.releaseSubagentRun("run-release-context-engine");

    await pollUntilAssert(
      () => {
        expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
          childSessionKey: "agent:main:session:child",
          reason: "released",
          workspaceDir: "/tmp/workspace",
        });
      },
      { timeoutMs: 3_000 },
    );
    expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: {
        agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
        session: { mainKey: "main", scope: "per-sender" },
      },
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });
    expect(mocks.ensureContextEnginesInitialized).toHaveBeenCalledTimes(1);
  });
});

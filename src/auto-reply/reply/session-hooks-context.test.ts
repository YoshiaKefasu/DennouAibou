import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { HookRunner } from "../../plugins/hooks.js";
import { initSessionState } from "./session.js";

const hasHooks = vi.fn<HookRunner["hasHooks"]>();
const runSessionStart = vi.fn<HookRunner["runSessionStart"]>();
const runSessionEnd = vi.fn<HookRunner["runSessionEnd"]>();

// Inject the global hook-runner lookup instead of mocking
// `../../plugins/hook-runner-global.js` at module level.
function createHookRunner(): HookRunner {
  return {
    hasHooks,
    runSessionStart,
    runSessionEnd,
  } as unknown as HookRunner;
}

async function createStorePath(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(root, "sessions.json");
}

async function writeStore(
  storePath: string,
  store: Record<string, SessionEntry | Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
}

async function writeTranscript(
  storePath: string,
  sessionId: string,
  text = "hello",
): Promise<string> {
  const transcriptPath = path.join(path.dirname(storePath), `${sessionId}.jsonl`);
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "message",
      id: `${sessionId}-m1`,
      message: { role: "user", content: text },
    })}\n`,
    "utf-8",
  );
  return transcriptPath;
}

describe("session hook context wiring", () => {
  beforeEach(() => {
    hasHooks.mockReset();
    runSessionStart.mockReset();
    runSessionEnd.mockReset();
    runSessionStart.mockResolvedValue(undefined);
    runSessionEnd.mockResolvedValue(undefined);
    hasHooks.mockImplementation(
      (hookName) => hookName === "session_start" || hookName === "session_end",
    );
  });

  it("passes sessionKey to session_start hook context", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const storePath = await createStorePath("openclaw-session-hook-start");
    await writeStore(storePath, {});
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
      getGlobalHookRunner: createHookRunner,
    });

    expect(runSessionStart).toHaveBeenCalledTimes(1);
    const [event, context] = runSessionStart.mock.calls[0] ?? [];
    expect(event).toMatchObject({ sessionKey });
    expect(context).toMatchObject({ sessionKey, agentId: "main" });
    expect(context).toMatchObject({ sessionId: event?.sessionId });
  });

  it("passes sessionKey to session_end hook context on reset", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const storePath = await createStorePath("openclaw-session-hook-end");
    const transcriptPath = await writeTranscript(storePath, "old-session");
    await writeStore(storePath, {
      [sessionKey]: {
        sessionId: "old-session",
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "/new", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
      getGlobalHookRunner: createHookRunner,
    });

    expect(runSessionEnd).toHaveBeenCalledTimes(1);
    expect(runSessionStart).toHaveBeenCalledTimes(1);
    const [event, context] = runSessionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      sessionKey,
      reason: "new",
      transcriptArchived: true,
    });
    expect(context).toMatchObject({ sessionKey, agentId: "main" });
    expect(context).toMatchObject({ sessionId: event?.sessionId });
    expect(event?.sessionFile).toContain(".jsonl.reset.");

    const [startEvent, startContext] = runSessionStart.mock.calls[0] ?? [];
    expect(startEvent).toMatchObject({ resumedFrom: "old-session" });
    expect(event?.nextSessionId).toBe(startEvent?.sessionId);
    expect(startContext).toMatchObject({ sessionId: startEvent?.sessionId });
  });

  it("marks explicit /reset rollovers with reason reset", async () => {
    const sessionKey = "agent:main:telegram:direct:456";
    const storePath = await createStorePath("openclaw-session-hook-explicit-reset");
    const transcriptPath = await writeTranscript(storePath, "reset-session", "reset me");
    await writeStore(storePath, {
      [sessionKey]: {
        sessionId: "reset-session",
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "/reset", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
      getGlobalHookRunner: createHookRunner,
    });

    const [event] = runSessionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({ reason: "reset" });
  });

  it("maps custom reset trigger aliases to the new-session reason", async () => {
    const sessionKey = "agent:main:telegram:direct:alias";
    const storePath = await createStorePath("openclaw-session-hook-reset-alias");
    const transcriptPath = await writeTranscript(storePath, "alias-session", "alias me");
    await writeStore(storePath, {
      [sessionKey]: {
        sessionId: "alias-session",
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
      },
    });
    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/fresh"],
      },
    } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "/fresh", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
      getGlobalHookRunner: createHookRunner,
    });

    const [event] = runSessionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({ reason: "new" });
  });

  // Note: the previous "marks daily stale rollovers and exposes the archived
  // transcript path", "marks idle stale rollovers with reason idle", and
  // "prefers idle over daily when both rollover conditions are true" tests
  // have been removed because the automatic session reset machinery (idle /
  // daily / resetByType / resetByChannel) has been dismantled. Kasou's
  // master session is permanent; sessions are NEVER rotated based on
  // inactivity or a daily boundary, so no `session_end` event is fired with
  // reason `"idle"` or `"daily"` at runtime.
});

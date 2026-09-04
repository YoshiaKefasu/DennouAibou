import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSessionIntegrityGuard,
  RAW_APPEND_CUSTOM_ENTRY_SYMBOL,
  verifyAppendedEntry,
} from "./session-integrity-guard.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

const subsystemErrorLog = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", async () => {
  const actual =
    await vi.importActual<typeof import("../logging/subsystem.js")>("../logging/subsystem.js");
  const mockLogger: import("../logging/subsystem.js").SubsystemLogger = (() => {
    const passthrough = (level: string) => (message: string, meta?: Record<string, unknown>) => {
      if (level === "error") {
        subsystemErrorLog(message, meta);
      }
    };
    return {
      subsystem: "sessions/integrity",
      isEnabled: () => true,
      trace: passthrough("trace"),
      debug: passthrough("debug"),
      info: passthrough("info"),
      warn: passthrough("warn"),
      error: passthrough("error"),
      fatal: passthrough("fatal"),
      raw: () => {},
      child: () => mockLogger,
    };
  })();
  return {
    ...actual,
    createSubsystemLogger: () => mockLogger,
  };
});

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];
const asAppendMessage = (message: unknown) => message as AppendMessage;

function userMessage(text: string): AppendMessage {
  return asAppendMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
}

describe("verifyAppendedEntry", () => {
  it("returns ok when the appended id is present and leaf is valid", () => {
    const sm = SessionManager.inMemory();
    const id = sm.appendMessage(userMessage("hello"));
    expect(verifyAppendedEntry(sm, id)).toEqual({ ok: true });
  });

  it("returns entry-not-found when the session is empty and the id does not exist", () => {
    const sm = SessionManager.inMemory();
    // Sanity check: in-memory session starts with leafId === null.
    expect(sm.getLeafId()).toBeNull();
    expect(verifyAppendedEntry(sm, "missing-id")).toEqual({
      ok: false,
      reason: "entry not found after append: missing-id",
    });
  });

  it("returns entry-not-found when the id is not in the entry map", () => {
    const sm = SessionManager.inMemory();
    expect(verifyAppendedEntry(sm, "no-such-id")).toEqual({
      ok: false,
      reason: "entry not found after append: no-such-id",
    });
  });

  it("returns leaf-not-found when leafId points at a missing entry", () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage(userMessage("first"));
    const realLeafId = sm.getLeafId();
    expect(realLeafId).not.toBeNull();

    // Corrupt the in-memory leaf pointer to point at a non-existent id so we
    // can exercise the leaf check without touching the file persistence layer.
    (sm as unknown as { leafId: string | null }).leafId = "ghost-leaf-id";

    const verification = verifyAppendedEntry(sm, realLeafId as string);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.reason).toContain("leaf id not found");
    }
  });
});

describe("installSessionIntegrityGuard", () => {
  const prevSkip = process.env.DENNOU_SKIP_INTEGRITY_GUARD;

  beforeEach(() => {
    delete process.env.DENNOU_SKIP_INTEGRITY_GUARD;
  });

  afterEach(() => {
    if (prevSkip === undefined) {
      delete process.env.DENNOU_SKIP_INTEGRITY_GUARD;
    } else {
      process.env.DENNOU_SKIP_INTEGRITY_GUARD = prevSkip;
    }
  });

  it("does not mutate appendMessage when DENNOU_SKIP_INTEGRITY_GUARD=1", () => {
    process.env.DENNOU_SKIP_INTEGRITY_GUARD = "1";
    const sm = SessionManager.inMemory();
    const originalAppend = sm.appendMessage;
    const originalAppendCustomEntry = sm.appendCustomEntry;

    installSessionIntegrityGuard(sm);

    // Same function reference: skip guard means no wrapper installation.
    expect(sm.appendMessage).toBe(originalAppend);
    expect(sm.appendCustomEntry).toBe(originalAppendCustomEntry);
  });

  it("is idempotent on repeated installation", () => {
    const sm = SessionManager.inMemory();
    installSessionIntegrityGuard(sm);
    const wrappedOnce = sm.appendMessage;
    installSessionIntegrityGuard(sm);
    const wrappedTwice = sm.appendMessage;
    expect(wrappedTwice).toBe(wrappedOnce);
  });

  it("exposes the raw underlying appendMessage via [RAW_APPEND_MESSAGE] symbol", async () => {
    const { getRawSessionAppendMessage } = await import("./session-tool-result-guard.js");
    const sm = SessionManager.inMemory();
    installSessionIntegrityGuard(sm);
    const raw = getRawSessionAppendMessage(sm);
    expect(typeof raw).toBe("function");
    // The raw must not be the integrity wrapper itself (protocol inheritance).
    expect(raw).not.toBe(sm.appendMessage);
  });

  it("wraps appendCustomEntry and verifies after each append", () => {
    const sm = SessionManager.inMemory();
    installSessionIntegrityGuard(sm);
    const raw = (
      sm as unknown as {
        [RAW_APPEND_CUSTOM_ENTRY_SYMBOL]: SessionManager["appendCustomEntry"];
      }
    )[RAW_APPEND_CUSTOM_ENTRY_SYMBOL];

    // sanity: the raw is captured
    expect(typeof raw).toBe("function");

    const id = sm.appendCustomEntry("model-snapshot", { foo: 1 });
    expect(typeof id).toBe("string");
    expect(sm.getEntry(id)).toBeDefined();
  });
});

describe("guardSessionManager + integrity integration", () => {
  const prevSkip = process.env.DENNOU_SKIP_INTEGRITY_GUARD;

  beforeEach(() => {
    delete process.env.DENNOU_SKIP_INTEGRITY_GUARD;
  });

  afterEach(() => {
    if (prevSkip === undefined) {
      delete process.env.DENNOU_SKIP_INTEGRITY_GUARD;
    } else {
      process.env.DENNOU_SKIP_INTEGRITY_GUARD = prevSkip;
    }
  });

  it("keeps verification active when stacked with the tool-result guard", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    // Append two messages; both should be persisted without integrity errors.
    const a = sm.appendMessage(userMessage("first"));
    const b = sm.appendMessage(userMessage("second"));
    expect(typeof a).toBe("string");
    expect(typeof b).toBe("string");
    expect(sm.getLeafId()).not.toBeNull();
    expect(sm.getEntries().length).toBe(2);
  });

  it("logs an error when verification fails (leaf disappears)", () => {
    // Trigger the leaf-not-found path by stubbing `getLeafId` to return an id
    // that does not exist in the entry map. The verification hook runs after
    // each `appendMessage` and logs an error when the leaf is unresolvable.
    const sm = guardSessionManager(SessionManager.inMemory());
    sm.appendMessage(userMessage("seed"));

    const originalGetLeafId = sm.getLeafId.bind(sm);
    vi.spyOn(sm, "getLeafId").mockImplementation(() => "ghost-leaf-id");
    expect(originalGetLeafId()).not.toBe("ghost-leaf-id");

    subsystemErrorLog.mockClear();
    sm.appendMessage(userMessage("trigger"));

    expect(subsystemErrorLog).toHaveBeenCalledWith(
      "session integrity verification failed (appendMessage)",
      expect.objectContaining({
        appendedId: expect.any(String),
        reason: expect.stringContaining("leaf id not found"),
      }),
    );
  });

  it("installs integrity as the outermost wrapper (integrity → toolResult → raw)", async () => {
    // Install order check (per DENNOU_DOCS/SESSION_INTEGRITY_GUARD.md §3.2):
    // the integrity wrapper sits at sm.appendMessage (outermost), the raw
    // underlying remains reachable via [RAW_APPEND_MESSAGE] (protocol
    // inheritance), and both wrappers co-exist so neither is bypassed.
    const sm = SessionManager.inMemory();
    const rawBeforeInstall = sm.appendMessage;
    expect(typeof rawBeforeInstall).toBe("function");

    guardSessionManager(sm, { agentId: "main", sessionKey: "main" });

    // 1. integrity is outermost: sm.appendMessage is no longer the raw.
    const outermost = sm.appendMessage;
    expect(outermost).not.toBe(rawBeforeInstall);
    expect(typeof outermost).toBe("function");

    // 2. protocol inheritance: raw is still reachable via the shared symbol,
    // and it is distinct from the integrity wrapper that now sits at
    // sm.appendMessage (regression guard for the duplicate-symbol fix in this
    // commit — previously the integrity guard wrote to its own symbol which
    // nothing read).
    const { getRawSessionAppendMessage } = await import("./session-tool-result-guard.js");
    const resolvedRaw = getRawSessionAppendMessage(sm);
    expect(resolvedRaw).not.toBe(outermost);
    expect(typeof resolvedRaw).toBe("function");
  });
});

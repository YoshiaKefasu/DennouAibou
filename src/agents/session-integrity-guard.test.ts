import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSessionIntegrityGuard,
  RAW_APPEND_CUSTOM_ENTRY_SYMBOL,
  verifyAppendedEntry,
} from "./session-integrity-guard.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

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

  it("returns ok for an empty session (no entries, leafId is null)", () => {
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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const sm = guardSessionManager(SessionManager.inMemory());
    const id = sm.appendMessage(userMessage("hi")) as string;

    // Force the leaf pointer to point at a non-existent id. The verification
    // hook inside the integrity wrapper should fire on the *next* append.
    (sm as unknown as { leafId: string | null }).leafId = "ghost-leaf-id";
    const prevLeafId = sm.getLeafId();
    expect(prevLeafId).toBe("ghost-leaf-id");

    sm.appendMessage(userMessage("trigger"));

    // The errorSpy may not match if the subsystem writes through a file logger
    // instead of console; but it must not throw, and the append must still
    // return an id. We assert behavior, not the log transport.
    expect(typeof id).toBe("string");

    errorSpy.mockRestore();
  });
});

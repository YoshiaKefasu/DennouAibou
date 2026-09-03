/**
 * Session integrity guard — minimal Phase 1 kernel-side post-append verification.
 *
 * Detects orphan-producing appends at write time so that the SessionManager's
 * in-memory tree state matches the just-persisted entry. Failures are logged
 * with `createSubsystemLogger("sessions/integrity")` for the Phase 2/3 plugin
 * health-check to pick up; nothing is rolled back (post-append by design).
 *
 * Design: `DENNOU_DOCS/SESSION_INTEGRITY_GUARD.md` §3.1, §3.2, §3.3.
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getRawSessionAppendMessage } from "./session-tool-result-guard.js";

const RAW_APPEND_MESSAGE = Symbol("openclaw.session.rawAppendMessage");
const RAW_APPEND_CUSTOM_ENTRY = Symbol("openclaw.session.rawAppendCustomEntry");
const INTEGRITY_GUARD_INSTALLED = Symbol("openclaw.session.integrityGuardInstalled");

type SessionManagerWithRaw = SessionManager & {
  [RAW_APPEND_MESSAGE]?: SessionManager["appendMessage"];
  [RAW_APPEND_CUSTOM_ENTRY]?: SessionManager["appendCustomEntry"];
  [INTEGRITY_GUARD_INSTALLED]?: boolean;
};

const log = createSubsystemLogger("sessions/integrity");

type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];

export const RAW_APPEND_MESSAGE_SYMBOL = RAW_APPEND_MESSAGE;
export const RAW_APPEND_CUSTOM_ENTRY_SYMBOL = RAW_APPEND_CUSTOM_ENTRY;

function isSkipGuardEnabled(): boolean {
  return isTruthyEnvValue(process.env.DENNOU_SKIP_INTEGRITY_GUARD);
}

export type AppendVerification = { ok: true } | { ok: false; reason: string };

/**
 * Verify a just-appended entry by ID. Pure function: reads `getEntry` / `getLeafId`
 * without mutating state. Returns `{ ok: false, reason }` for any failure so the
 * caller can log without inspecting internals.
 */
export function verifyAppendedEntry(
  sessionManager: SessionManager,
  appendedId: string,
): AppendVerification {
  const entry = sessionManager.getEntry(appendedId);
  if (!entry) {
    return { ok: false, reason: `entry not found after append: ${appendedId}` };
  }
  const leafId = sessionManager.getLeafId();
  if (leafId !== null && !sessionManager.getEntry(leafId)) {
    return { ok: false, reason: `leaf id not found: ${leafId}` };
  }
  return { ok: true };
}

function safeSessionFile(sm: SessionManager): string | undefined {
  try {
    return sm.getSessionFile?.();
  } catch {
    return undefined;
  }
}

/**
 * Install the post-append integrity verification wrapper.
 *
 * - Idempotent: a sentinel symbol marks installed instances so re-invocation is a no-op.
 * - Honored-by-kill-switch: returns immediately when `DENNOU_SKIP_INTEGRITY_GUARD=1`.
 * - `[RAW_APPEND_MESSAGE]` is set to the raw underlying appendMessage for protocol
 *   inheritance with the tool-result guard (the tool-result guard sets the same
 *   symbol; both keep the symbol pointing at the raw underlying so consumers
 *   that explicitly want the unguarded path still get it).
 * - The integrity wrapper itself calls the **current** `appendMessage` (the
 *   tool-result wrapper when installed after it) so verification runs through
 *   the downstream chain instead of bypassing it.
 * - Install order: must run **after** `installSessionToolResultGuard` so this
 *   wrapper is the outer "前段" stage. Resulting chain:
 *   `sm.appendMessage -> integrityWrapper -> toolResultWrapper -> rawAppend`,
 *   per DENNOU_DOCS/SESSION_INTEGRITY_GUARD.md §3.2.
 */
export function installSessionIntegrityGuard(sessionManager: SessionManager): void {
  if (isSkipGuardEnabled()) {
    return;
  }
  const sm = sessionManager as SessionManagerWithRaw;
  if (sm[INTEGRITY_GUARD_INSTALLED]) {
    return;
  }
  sm[INTEGRITY_GUARD_INSTALLED] = true;

  // Capture the raw underlying appendMessage for the `[RAW_APPEND_MESSAGE]`
  // symbol. The helper reads the symbol if already set (e.g. tool-result guard
  // installed first), otherwise falls back to the bound raw method. Either way
  // we land on the raw underlying, which is what protocol inheritance expects.
  const rawAppendMessage = getRawSessionAppendMessage(sessionManager);
  sm[RAW_APPEND_MESSAGE] = rawAppendMessage;
  sm[RAW_APPEND_CUSTOM_ENTRY] = sessionManager.appendCustomEntry.bind(sessionManager);

  const rawAppendCustomEntry = sm[RAW_APPEND_CUSTOM_ENTRY];

  // Snapshot the current `appendMessage` (e.g. the tool-result wrapper) at
  // install time so the integrity wrapper calls through it instead of bypassing
  // downstream wrappers. The integrity wrapper is intentionally the outer
  // "前段" stage — it surrounds everything installed before it.
  const wrappedAppendMessage = sessionManager.appendMessage.bind(sessionManager);

  const guardedAppendMessage = (message: AppendMessageArg) => {
    const result = wrappedAppendMessage(message as never);
    if (typeof result === "string") {
      const verification = verifyAppendedEntry(sessionManager, result);
      if (!verification.ok) {
        log.error("session integrity verification failed (appendMessage)", {
          sessionFile: safeSessionFile(sessionManager),
          appendedId: result,
          reason: verification.reason,
        });
      }
    }
    return result;
  };

  const guardedAppendCustomEntry = (customType: string, data?: unknown) => {
    const result = rawAppendCustomEntry(customType, data);
    if (typeof result === "string") {
      const verification = verifyAppendedEntry(sessionManager, result);
      if (!verification.ok) {
        log.error("session integrity verification failed (appendCustomEntry)", {
          sessionFile: safeSessionFile(sessionManager),
          appendedId: result,
          reason: verification.reason,
          customType,
        });
      }
    }
    return result;
  };

  sessionManager.appendMessage = guardedAppendMessage as SessionManager["appendMessage"];
  sessionManager.appendCustomEntry =
    guardedAppendCustomEntry as SessionManager["appendCustomEntry"];
}

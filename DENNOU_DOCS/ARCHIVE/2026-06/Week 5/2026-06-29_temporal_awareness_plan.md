# Temporal Awareness Plan

## Overview

Add lightweight temporal awareness to DennouAibou's agent context so the model can tell when a user returns after a meaningful pause.

The recommended approach is the `magic-context` style marker: prepend a tiny HTML comment before the inbound user message when the gap since the previous message is large enough.

Example:

```text
<!-- +2w 4d -->
[Telegram Alice Mon 2026-06-29 15:37] 久しぶり
```

This is intentionally small and human-readable: the agent gets a simple "how long since last time" hint without rewriting the whole system prompt or stuffing every turn with current-time text.

## Status: 📝 PLAN ONLY

- **Date**: 2026-06-29
- **Implementation**: Not started
- **Recommended path**: Add `magic-context` style elapsed-time markers to inbound user context
- **Scope**: DennouAibou/OpenClaw runtime only; no magic-context dependency should be added
- **Commit type when implemented**: likely `[SOUL]` if this becomes a DennouAibou-local feature

## Motivation

DennouAibou already has a strong long-term partner persona, but it still needs a cleaner sense of elapsed real time between user messages.

The goal is not to make the model constantly aware of wall-clock time. The goal is narrower:

- If the user replies after 5 minutes, behave normally.
- If the user comes back after many hours, understand that the old topic may need a small recap.
- If the user comes back after days or weeks, naturally read the message as "久しぶり" context.

This matters especially for Telegram/Discord style use, where the user may leave the conversation for a long time and then resume with a short phrase like "続き" or "あれどうなった？".

Plain-language version: this is like adding a tiny sticky note before the user's message saying, "this was not five seconds later; this was two weeks later."

## Current Evidence

### Evidence 1 — DennouAibou already formats elapsed time in envelopes

`src/auto-reply/envelope.ts:152-188` builds the inbound envelope. When `includeElapsed` is enabled and both `timestamp` and `previousTimestamp` exist, it computes `elapsedMs`, formats it with `formatTimeAgo(..., { suffix: false })`, and inserts it into the header as `+2m` style text.

What this means: the house already has a small clock on the door. The problem is not "no time support at all"; the problem is whether the clock is reading the right previous event.

### Evidence 2 — the current previous timestamp comes from session `updatedAt`

`src/channels/session-envelope.ts:5-21` resolves inbound envelope context and sets `previousTimestamp` from `readSessionUpdatedAt({ storePath, sessionKey })`.

What this means: the current source is the session's last update time, not a dedicated "previous user message completed/created time". That can be good enough for short elapsed display, but it can be noisy if non-user session updates touch `updatedAt`.

### Evidence 3 — magic-context has the exact marker pattern we want

`packages/plugin/src/hooks/magic-context/temporal-awareness.ts:1-18` explains that temporal awareness prepends HTML comments like `<!-- +Xm -->`, `<!-- +2h 15m -->`, or `<!-- +3d 4h -->` to user messages, derived deterministically from immutable message timestamps.

What this means: magic-context already uses the "tiny sticky note" approach. It is cache-safe because it is based on persisted timestamps, not on "current time right now" changing every run.

### Evidence 4 — magic-context uses a practical threshold and compact formatting

`packages/plugin/src/hooks/magic-context/temporal-awareness.ts:22-68` defines a 5-minute threshold and formats gaps as minutes, hours+minutes, days+hours, or weeks+days.

What this means: it does not spam every quick back-and-forth. It only speaks up when the pause is meaningful.

### Evidence 5 — magic-context also teaches the model how to read the marker

`packages/plugin/src/agents/magic-context-prompt.ts:124` adds guidance that user messages may be preceded by HTML comments indicating elapsed time since the previous message's completion.

What this means: the marker is not just hidden metadata. The model gets one short instruction explaining how to use it.

## Upstream OpenClaw Status

Upstream OpenClaw has envelope elapsed support, but not the full `magic-context` style temporal marker system.

Evidence checked on 2026-06-29:

- GitHub code search for `repo:openclaw/openclaw envelopeElapsed` returned upstream matches in `src/auto-reply/envelope.ts`, config schema/help/labels, tests, and `docs/date-time.md`.
- GitHub code search for `repo:openclaw/openclaw "TEMPORAL_AWARENESS"` returned 0 results.
- GitHub code search for `repo:openclaw/openclaw "<!-- +12m -->"` returned 0 results.

Interpretation:

- Upstream already knows how to show `+2m` style elapsed time inside envelopes.
- Upstream does not appear to have magic-context's explicit temporal-awareness marker system.
- So this should be treated as a DennouAibou-local feature plan unless upstream later adds an equivalent feature.

## Recommended Approach

Use the `magic-context` style marker, but implement it natively in DennouAibou instead of depending on magic-context.

Recommended final shape:

```text
<!-- +2w 4d -->
[Telegram Alice Mon 2026-06-29 15:37] 久しぶり
```

Rules:

1. Add the marker only when the elapsed gap is at least 5 minutes.
2. Measure from the previous message's effective end time to the current user message creation time.
3. Prefer a dedicated previous inbound/user-message timestamp over generic session `updatedAt`.
4. Keep the existing envelope format. The marker should complement the envelope, not replace it.
5. Add one short system-prompt guidance line so the model knows that the HTML comment means elapsed real time.
6. Keep the marker deterministic from stored timestamps to avoid prompt-cache instability.

Why this is better than injecting "current time" every turn:

- It only changes when the user message itself has a meaningful time gap.
- It avoids invalidating cached prompt prefixes on every run.
- It gives the model the exact information it needs: not "what time is it now?", but "how long was the pause?".

Plain-language version: do not put a big ticking clock in the room. Put a small note on the message only when the user was away long enough that it matters.

## Implementation Plan

### Phase 1 — Add a small temporal formatting helper

Create a helper that mirrors the magic-context formatting rules:

- `< 5 minutes` → no marker
- `5 minutes - 1 hour` → `+12m`
- `1 hour - 1 day` → `+2h 15m`
- `1 day - 1 week` → `+3d 4h`
- `>= 1 week` → `+2w 4d`

Expected helper behavior:

```typescript
formatTemporalGapMarker(seconds); // returns "+2w 4d" or null
formatTemporalMarkerPrefix(seconds); // returns "<!-- +2w 4d -->\n" or null
```

Keep it independent and unit-tested. Do not couple it to Telegram, Discord, or any one channel.

Function names can be DennouAibou-local; the formatting logic should mirror magic-context's `formatGap` thresholds and dual-unit style.

### Phase 2 — Use the right previous timestamp

Avoid relying only on session `updatedAt` for temporal awareness.

Preferred data source order:

1. Previous inbound/user message timestamp from transcript/session history if available.
2. Previous assistant completion time if the marker is meant to represent "previous message completion" exactly like magic-context.
3. Session `updatedAt` only as a fallback, and only if documented as a fallback.

This is the important correctness point: `updatedAt` is a broad "session changed" timestamp, while temporal awareness wants "time since the actual previous conversational message".

Implementation note: per-message timestamps may not be available from the session store path that currently powers `readSessionUpdatedAt`. If the accurate source lives in Pi transcript JSONL files, Phase 2 will need a small, carefully bounded filesystem read path, likely through the existing session transcript resolver, rather than assuming the envelope context already has message-level timestamps.

### Phase 3 — Inject marker into inbound prompt text

Add the marker before the inbound envelope/body that reaches the model.

Target output:

```text
<!-- +3d 4h -->
[Telegram Alice Thu 2026-06-25 10:12] 続きお願いします
```

The existing envelope should remain intact because it carries channel, sender, and timestamp context.

### Phase 4 — Add model guidance

Add a short guidance line near the agent/system prompt context rules:

```text
User messages may be preceded by HTML comments like <!-- +12m -->, <!-- +2h 15m -->, or <!-- +3d 4h -->. This means elapsed time since the previous conversational message. Use it for pacing, recaps, and "久しぶり" style context.
```

Keep the wording short. This should teach the model without bloating every turn.

### Phase 5 — Add tests

Minimum tests:

- gap below 5 minutes emits no marker
- 12 minutes emits `<!-- +12m -->`
- 2 hours 15 minutes emits `<!-- +2h 15m -->`
- 3 days 4 hours emits `<!-- +3d 4h -->`
- 2 weeks 4 days emits `<!-- +2w 4d -->`
- negative or missing timestamps emit no marker
- existing envelope output remains unchanged except for the optional marker prefix

If the previous timestamp source changes, add a regression test proving that non-user session updates do not fake a recent user-message gap.

## Risks and Trade-offs

### Risk 1 — double time hints

DennouAibou may show both:

```text
<!-- +2w 4d -->
[Telegram Alice +2w 4d Mon 2026-06-29 ...] message
```

This is redundant. The cleaner target is to keep the absolute timestamp in the envelope and put the elapsed gap in the marker, or keep both only if tests prove the duplication is useful.

Also note that the two formats are not identical. The existing envelope path uses `formatTimeAgo` style output, while the proposed marker uses magic-context-style adaptive dual-unit formatting plus a 5-minute threshold. That difference is intentional, but it should be explicit during implementation so nobody treats them as the same feature.

Recommended default:

- Marker: elapsed conversational gap
- Envelope: channel, sender, absolute timestamp

### Risk 2 — wrong timestamp source

If the marker uses `session.updatedAt`, the model may think the user just returned recently even when the last real user message was much older.

Mitigation: use a dedicated previous conversational-message timestamp. Treat `updatedAt` as fallback only.

### Risk 3 — prompt-cache churn

If the system injects "current time now" every turn, prompt-cache stability gets worse.

Mitigation: compute the marker from persisted message timestamps. The marker becomes part of the user message context and stays stable across retries.

### Risk 4 — over-personalized behavior

The model might overreact to every marker and say "久しぶり" too often.

Mitigation: keep the guidance modest: use the marker for pacing and recap decisions, not as a mandatory greeting trigger.

## Decision

Proceed with a native DennouAibou temporal-awareness feature using magic-context's marker style.

Do not add magic-context as a runtime dependency. Copy the idea, not the package.

Implementation should be small, deterministic, and test-first.

## Verification Checklist

Before implementation commit:

- `pnpm build`
- targeted tests for the temporal formatting helper
- targeted tests for inbound envelope/prompt injection
- regression test for timestamp source correctness
- `@code-reviewer` approval

Before deploy:

- confirm generated prompt text contains the marker after a synthetic long gap
- confirm normal fast replies do not get markers
- confirm Telegram/Discord/WebUI still receive only final replies, not partial debug output
- deploy to KASOU only after approval and normal gateway checks

## Open Questions

1. Should `agents.defaults.envelopeElapsed` control only the existing envelope `+2m`, or should it also control the new temporal marker?
   - Recommended: consider `envelopeElapsed` as a broad prerequisite gate, then add a new DennouAibou-specific config flag only if independent operator control is needed. Envelope formatting and temporal-awareness hints are related, but not identical.
2. Should the marker say `since previous user message` or `since previous message completion`?
   - Recommended: use `since previous conversational message` in docs/guidance, then implement with the most accurate available timestamp source.
3. Should markers be shown for subagents?
   - Recommended: no for now. Start with main agent inbound messages only.

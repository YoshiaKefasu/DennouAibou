# Session reset `off` mode follow-up

Date: 2026-05-12

## What changed

Added support for `session.reset.mode: "off"` so automatic daily and idle resets can be disabled while manual reset commands stay available.

## Why this was needed

OpenClaw upstream now treats `off` as a first-class mode for long-running sessions. Without it, the app kept forcing automatic turnover even when the operator wanted one persistent conversation stream.

## Code changes

### 1) Single source of truth for `SessionResetMode`

`src/config/types.base.ts` keeps the canonical `SessionResetMode` definition.
`src/config/sessions/reset.ts` now imports that type and re-exports it instead of declaring a second copy.

Why:
- avoids drift between the config model and reset logic
- keeps the public `config-runtime` export stable through `src/config/sessions.ts`

### 2) Runtime behavior for `mode: "off"`

`resolveSessionResetPolicy()` now returns:
- `mode: "off"`
- `idleMinutes: undefined`

That matters because `evaluateSessionFreshness()` only expires sessions when daily or idle thresholds are active. With `off`, both thresholds stay inactive, so the session stays fresh until a manual reset.

### 3) Type-specific override coverage

Added a regression test for this precedence path:

- base reset: `mode: "daily"`
- type override: `resetByType.direct.mode = "off"`

This proves type-specific config wins over the base reset policy.

## Review note handled

The code review pointed out that `atHour` is still present in `SessionResetPolicy` even when `mode !== "daily"`.

Current decision:
- keep the field for shape stability
- document that `atHour` only matters in daily mode

That keeps the runtime contract small and avoids a broader type change.

## Validation

Passed:

- `pnpm vitest run src/config/sessions/sessions.test.ts src/config/zod-schema.session.test.ts src/config/schema.base.generated.test.ts`

Result:

- 29 tests passed

## Risk summary

Low risk.

The change is additive, follows upstream semantics, and keeps manual resets intact.

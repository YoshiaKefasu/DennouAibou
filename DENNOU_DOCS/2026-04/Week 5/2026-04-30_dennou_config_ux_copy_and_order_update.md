# [DOCS] DennouAibou Config UX Copy & Ordering Update

## Why this update was needed

Users reported that Dennou prune settings looked duplicated and hard to understand:

- `Dry Run`
- `Keep Last Tools`
- `Min Prunable Tool Chars`
- `Placeholder`

appeared across multiple blocks without clear guidance.

The behavior was technically correct, but UX clarity was weak.

---

## What changed

### 1) Added plain-English help text for Dennou settings

Updated config metadata so each Dennou field now explains:

- what it does
- when to use it
- practical starter ranges (for example, `keepLastTools: 5-10`, `minPrunableToolChars: ~1200`)

Updated files:

- `src/config/schema.help.ts`
- `src/config/schema.labels.ts`

### 2) Added predictable section ordering

Set explicit order hints so Dennou config sections render in this sequence:

1. `toolsPrune` (shared defaults)
2. `activeSessionToolsPrune`
3. `sessionToolsPrune`
4. `pruneProtection`

Updated file:

- `src/config/schema.hints.ts`

### 3) Regenerated base schema

Regenerated config schema output so the UI receives updated labels/help/order.

Updated file:

- `src/config/schema.base.generated.ts`

---

## Validation

Executed and passed:

- `pnpm test src/config/schema.base.generated.test.ts`
  - Test Files: 2 passed
  - Tests: 8 passed
- `pnpm test ui/src/ui/views/config.browser.test.ts`
  - Test Files: 1 passed
  - Tests: 16 passed
- `pnpm test src/config/zod-schema.dennou.test.ts`
  - Test Files: 1 passed
  - Tests: 3 passed

---

## UX intent (operator-facing)

The UI now communicates that these are not random duplicates:

- **Shared defaults** = baseline for both modes
- **Active session prune** = idle-time cleanup for live sessions
- **Session prune (closed)** = cleanup for finished sessions
- **Prune protection** = safety guardrails

This keeps advanced behavior intact while making first-time understanding much easier.

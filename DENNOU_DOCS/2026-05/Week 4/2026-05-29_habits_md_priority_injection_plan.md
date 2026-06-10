# HABITS.md Priority Injection Plan

## Overview

Add `HABITS.md` as the highest-priority workspace bootstrap file, loaded and injected before `AGENTS.md`. This allows users to define agent behavioral habits/rules that override all other context files.

## Status: ✅ IMPLEMENTED & DEPLOYED

- **Commit**: `851cf0bdc96 [SOUL] Add HABITS.md as highest-priority workspace bootstrap file`
- **Code-review fixes**: `f4dbf2c8198 [FIX-SOUL] Address code-review findings for HABITS.md implementation`
- **Tests**: 44/44 PASS
- **Deployed to KASOU**: HTTP 200 on `/` and `/logs`

## Motivation

AGENTS.md is currently the highest-priority file (order 10), but there are use cases where users want an even higher-priority file for behavioral rules, habits, or hard constraints that must not be overridden by AGENTS.md content. HABITS.md serves this purpose.

## Target Injection Order (After Implementation)

| Order | File | Notes |
|-------|------|-------|
| **5** | **HABITS.md** | **NEW — Highest priority** |
| 10 | AGENTS.md | Existing |
| 20 | SOUL.md | Existing |
| 30 | IDENTITY.md | Existing |
| 40 | USER.md | Existing |
| 50 | TOOLS.md | Existing |
| 60 | BOOTSTRAP.md | Existing |
| 70 | MEMORY.md | Existing |
| --- | CACHE BOUNDARY | --- |
| dynamic | HEARTBEAT.md | Existing |

## Files to Modify

### 1. `src/agents/workspace.ts`

**Add constant** (after line 25, near other filename constants):

```typescript
export const DEFAULT_HABITS_FILENAME = "HABITS.md";
```

**Add to type** (`WorkspaceBootstrapFileName` union, line 132-141):

```typescript
export type WorkspaceBootstrapFileName =
  | typeof DEFAULT_HABITS_FILENAME    // NEW
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  // ... rest unchanged
```

**Add to `VALID_BOOTSTRAP_NAMES` Set** (line 169-179) — **BLOCKER from code-reviewer**:

```typescript
const VALID_BOOTSTRAP_NAMES = new Set<WorkspaceBootstrapFileName>([
  DEFAULT_HABITS_FILENAME,    // NEW
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
]);
```

**Add to entries array** (line 490-522, insert FIRST before AGENTS.md):

```typescript
const entries: Array<{
  name: WorkspaceBootstrapFileName;
  filePath: string;
}> = [
  {
    name: DEFAULT_HABITS_FILENAME,           // NEW — highest priority
    filePath: path.join(resolvedDir, DEFAULT_HABITS_FILENAME),
  },
  {
    name: DEFAULT_AGENTS_FILENAME,           // existing
    filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
  },
  // ... rest unchanged
```

**Add to `MINIMAL_BOOTSTRAP_ALLOWLIST`** (line 549):

```typescript
const MINIMAL_BOOTSTRAP_ALLOWLIST: WorkspaceBootstrapFileName[] = [
  DEFAULT_HABITS_FILENAME,    // NEW
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
];
```

**Add to `ensureAgentWorkspace`** (line 378-389) — **BLOCKER from code-reviewer**:

```typescript
// Add HABITS.md template loading
const habitsPath = path.join(dir, DEFAULT_HABITS_FILENAME);
const habitsTemplate = await loadTemplate(DEFAULT_HABITS_FILENAME);
await writeFileIfMissing(habitsPath, habitsTemplate);
```

**Add `habitsPath` to return object** (line 455-464):

```typescript
return {
  agentsPath,
  habitsPath,    // NEW
  soulPath,
  // ... rest unchanged
};
```

**Add `habitsPath` to `templatePaths` array** (line 358):

```typescript
const templatePaths = [
  agentsPath,
  habitsPath,    // NEW
  soulPath,
  // ... rest unchanged
];
```

### 2. `src/agents/system-prompt.ts`

**Add to CONTEXT_FILE_ORDER** (line 32-40, insert BEFORE agents.md):

```typescript
const CONTEXT_FILE_ORDER = new Map<string, number>([
  ["habits.md", 5],     // NEW — highest priority
  ["agents.md", 10],
  ["soul.md", 20],
  ["identity.md", 30],
  ["user.md", 40],
  ["tools.md", 50],
  ["bootstrap.md", 60],
  ["memory.md", 70],
]);
```

**Add SOUL.md-style guidance** in `buildProjectContextSection` (line 90-98):

```typescript
const hasHabitsFile = params.files.some(
  (file) => getContextFileBasename(file.path) === "habits.md",
);
lines.push("The following project context files have been loaded:");
if (hasHabitsFile) {
  lines.push(
    "If HABITS.md is present, treat its entries as hard behavioral rules. They take precedence over AGENTS.md and all other context files.",
  );
}
if (hasSoulFile) {
  lines.push(
    "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
  );
}
```

### 3. `docs/reference/templates/HABITS.md` — **NEW FILE (BLOCKER from code-reviewer)**

Create template file with example content:

```markdown
# HABITS

<!-- 
  This file defines hard behavioral rules for the agent.
  Rules here take precedence over AGENTS.md and all other context files.
  Use this for non-negotiable habits, constraints, or behavioral patterns.
-->

## Example Habits

- Always respond in the same language the user writes in
- Never use emojis unless explicitly asked
- Keep responses concise; avoid unnecessary preamble
- When uncertain, ask before proceeding
- Always verify changes before marking tasks complete
```

## Files NOT Modified

- `bootstrap-files.ts` — No changes needed. It reads whatever `loadWorkspaceBootstrapFiles` returns.
- `pi-embedded-runner/` — No changes needed. It receives `contextFiles` from the bootstrap pipeline.
- Config schema — No changes needed. HABITS.md is a workspace file, not a config key.

## Test Coverage

### New Tests

1. **workspace.test.ts**: Verify `loadWorkspaceBootstrapFiles` loads HABITS.md when present, and it appears FIRST in the result array.
2. **system-prompt.test.ts**: Verify `CONTEXT_FILE_ORDER` sorts HABITS.md before AGENTS.md.
3. **bootstrap files test**: Verify HABITS.md is included in subagent sessions (via MINIMAL_BOOTSTRAP_ALLOWLIST).

### Existing Tests to Update (BLOCKER from code-reviewer)

1. **workspace.test.ts:62-72** — `expectSubagentAllowedBootstrapNames` helper: Add `expect(names).toContain("HABITS.md")`.
2. **workspace.test.ts:249-258** — `filterBootstrapFilesForSession` tests: Add `{ name: "HABITS.md", path: "/w/HABITS.md", content: "", missing: false }` to mock files array.
3. **system-prompt.test.ts:684-714** — Ordering test: Update to expect HABITS.md first, then verify `habitsIndex < agentsIndex < soulIndex < ...`.

### Existing Tests to Verify

- All existing bootstrap tests should pass unchanged (HABITS.md is optional; missing = no effect).

## Deployment Considerations

- **Backward compatible**: HABITS.md is optional. If not present, behavior is identical to current.
- **No config change**: This is a workspace file convention, not a config key.
- **No migration**: Existing workspaces continue to work. Users can add HABITS.md at any time.

## Commit Tag

`[SOUL]` — New DennouAibou-specific feature.

## Risk Assessment

- **LOW**: HABITS.md is optional and additive. No existing behavior changes.
- **MEDIUM**: If a user creates HABITS.md with contradictory rules to AGENTS.md, the HABITS.md rules win. This is the intended behavior but should be documented.
- **Mitigation**: Clear documentation in the workspace template and system prompt guidance.

## Implementation Phases

### Phase 1: Template & Core (estimated ~40 min)
1. Create `docs/reference/templates/HABITS.md` template file
2. Add constant + type + `VALID_BOOTSTRAP_NAMES` in `workspace.ts`
3. Add entries array + `MINIMAL_BOOTSTRAP_ALLOWLIST` in `workspace.ts`
4. Add `ensureAgentWorkspace` updates (template loading, return object, templatePaths)
5. Add sort order in `system-prompt.ts`
6. Add system prompt guidance text
7. Run existing tests to verify no regressions

### Phase 2: Tests (estimated ~25 min)
1. Add HABITS.md loading test
2. Add sort order test
3. Update `expectSubagentAllowedBootstrapNames` helper
4. Update `filterBootstrapFilesForSession` mock files
5. Update ordering test in `system-prompt.test.ts`
6. Add subagent session test

### Phase 3: Deploy (estimated ~10 min)
1. Build
2. Deploy to KASOU
3. Verify `/` and `/logs` return 200
4. Verify no template errors in logs

## Documentation Updates

- Update `DENNOU_RULES.md` to mention HABITS.md as highest-priority workspace file
- Update `AGENTS.md` to reference HABITS.md for behavioral rules
- Add HABITS.md to workspace template documentation
- Update `docs/reference/templates/` directory listing

## Code-Review Findings (Fixed)

**Commit**: `f4dbf2c8198 [FIX-SOUL] Address code-review findings for HABITS.md implementation`

### 1. ✅ Remove export from DEFAULT_HABITS_FILENAME
- **Before**: `export const DEFAULT_HABITS_FILENAME = "HABITS.md";`
- **After**: `const DEFAULT_HABITS_FILENAME = "HABITS.md";`
- **Reason**: Only used internally in `workspace.ts`. No external consumer needs this.

### 2. ✅ Add lowercase key requirement comment to CONTEXT_FILE_ORDER
- **Added**: `// Keys MUST be lowercase — getContextFileBasename() lowercases before lookup.`
- **Reason**: Prevents future contributors from adding mixed-case keys that would silently fall to `Number.MAX_SAFE_INTEGER` sort order.

### 3. ✅ Extract HABITS.md guidance string to constant
- **Added**: `const HABITS_GUIDANCE = "If HABITS.md is present, treat its entries as hard behavioral rules. They take precedence over AGENTS.md and all other stable context files.";`
- **Reason**: Improves discoverability and makes the text easier to maintain.

### 4. ✅ Clarify HABITS.md guidance text
- **Before**: "...all other context files."
- **After**: "...all other stable context files."
- **Reason**: HABITS.md guidance is only injected for stable (non-dynamic) context. The original text implied universal precedence, which was misleading.

### 5. ✅ Add JSDoc for habitsPath in return type
- **Added**: JSDoc comment for `ensureAgentWorkspace` return type and `habitsPath` property.
- **Reason**: Documents when path properties are present vs undefined.

## Open Items (Deferred)

### Potential Future Improvements
1. **Shared priority ordering**: The load order in `WORKSPACE_BOOTSTRAP_ENTRIES` and prompt order in `CONTEXT_FILE_ORDER` are separate. Could be unified into a single source of truth.
2. **`memory.md` in VALID_BOOTSTRAP_NAMES**: Included for case-insensitive FS handling but not in main entries array. Documented inconsistency.
3. **HABITS.md lint rule**: Template says "under 50 rules" but no enforcement. Could add CI check if needed.

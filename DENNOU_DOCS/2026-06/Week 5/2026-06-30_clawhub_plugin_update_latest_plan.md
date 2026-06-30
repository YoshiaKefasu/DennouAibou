# ClawHub Plugin Update Latest Plan

## Status

- **Date**: 2026-06-30
- **Status**: Plan only
- **Scope**: `openclaw plugins update <id-or-npm-spec>` for ClawHub-installed plugins, with `episodic-claw` as the confirmed failing case
- **Goal**: make `openclaw plugins update episodic-claw` download and install the newest compatible ClawHub release instead of re-downloading the already installed exact version
- **Do not do in this plan**: rewrite the full upstream plugin system, migrate to upstream managed plugin index, or change npm / marketplace / git update semantics

Plain-language summary: today the updater is asking ClawHub for the same old issue of a magazine because the saved order slip still says `@0.5.0`. The fix should align DennouAibou more closely with upstream's update model: a normal `update <id>` should follow the latest ClawHub release line, while an explicit `update clawhub:pkg@1.2.3` should stay pinned because the operator asked for that exact issue.

Important scope note: the current CLI routing layer does not yet resolve raw `clawhub:` arguments into `specOverrides`. So preserving explicit ClawHub selectors is part of this plan, not an already-working path.

## What we confirmed

### Evidence 1 — KASOU install record is pinned to an exact ClawHub version

- `openclaw.json:725-737`
  - `plugins.installs.episodic-claw.source = "clawhub"`
  - `spec = "clawhub:episodic-claw@0.5.0"`
  - `version = "0.5.0"`

Meaning: KASOU is not tracking an unversioned ClawHub line right now. The saved install record itself says "use 0.5.0 again".

Story version: the shelf card for `episodic-claw` literally says "bring me issue 0.5.0", so the clerk keeps fetching issue 0.5.0 even if issue 0.5.1 or 0.6.0 exists.

### Evidence 2 — DennouAibou targeted update reuses the recorded install spec

- `src/cli/plugins-update-command.ts:100-126`
  - `runPluginUpdateCommand()` resolves the plugin selection from tracked installs, then hands it to `updateNpmInstalledPlugins()`.
- `src/plugins/update.ts:301-302`
  - `effectiveSpec = record.source === "npm" ? specOverride ?? record.spec : record.spec`
- `src/plugins/update.ts:474-482`
  - ClawHub updates call `installPluginFromClawHub({ spec: effectiveSpec ?? `clawhub:${record.clawhubPackage!}`, ... })`

Meaning: for ClawHub installs, `update <id>` does not compute a new "latest" spec. It simply reuses the old recorded ClawHub spec.

Story version: the updater is not asking "what is the newest release?" first. It just reads the saved order slip and repeats it.

### Evidence 3 — DennouAibou docs already describe the pinned behavior

- `docs/cli/plugins.md:237-244`
  - "When you pass a plugin id, OpenClaw reuses the recorded install spec for that plugin."

Meaning: the current behavior is not accidental drift between docs and code. The current docs already describe this exact behavior.

### Evidence 4 — Upstream latest improved plugin updates, but exact-version ClawHub records still stay pinned

- upstream `docs/cli/plugins.md` latest
  - "Unversioned ClawHub installs keep an unversioned recorded spec so `openclaw plugins update` can follow newer ClawHub releases; explicit version or tag selectors such as `clawhub:pkg@1.2.3` and `clawhub:pkg@beta` remain pinned to that selector."
- upstream `src/plugins/update.ts` latest
  - ClawHub updates still call `installPluginFromClawHub({ spec: effectiveSpec ... })`

Meaning: upstream latest separates unversioned vs pinned ClawHub installs more clearly, but it still keeps explicit exact-version ClawHub specs pinned. So KASOU's current `clawhub:episodic-claw@0.5.0` record would still not move to latest automatically there.

## Root cause

The problem is not only "update downloads the same thing again". There are two layers:

1. **Legacy exact-version ClawHub install record**
   - KASOU currently stores `clawhub:episodic-claw@0.5.0`, so targeted update naturally asks for `0.5.0` again.
2. **No preflight unchanged skip for ClawHub**
   - DennouAibou does not skip early when ClawHub resolves to the same version. So it can still re-download and reinstall the same version instead of exiting early.

The first layer blocks latest-version tracking. The second layer wastes bandwidth and install work.

## Desired behavior

### User-facing target

For a normally installed ClawHub plugin like `episodic-claw`:

```bash
openclaw plugins update episodic-claw
```

should:

1. resolve the tracked plugin id
2. ask ClawHub for the newest compatible release on the normal release line
3. download that newest release when it is newer than the installed version
4. leave the plugin unchanged when already current
5. update the install record so future `update episodic-claw` continues to follow the latest release line

### Explicitly preserved behavior

These should remain pinned on purpose:

```bash
openclaw plugins update clawhub:episodic-claw@0.5.0
openclaw plugins update clawhub:episodic-claw@beta
```

If the operator explicitly passes a version or channel selector, that explicit selector should still win.

## Recommended approach

### Recommendation

Use an **upstream-aligned ClawHub update model with a narrow legacy-record bridge**, not a DennouAibou-only semantic rewrite.

That means:

- keep the upstream meaning of an explicitly supplied selector
- keep upstream-style pinned semantics for explicit exact versions and tags
- treat `openclaw plugins update <id>` as an unversioned/latest-line update intent
- add only the minimum bridge needed so old legacy exact-version install records do not block that upstream-style intent

### Why this is the safest option

It fixes the concrete KASOU problem while preserving the same mental model upstream now documents: id-only updates follow the normal release line, explicit selectors stay pinned. The only fork-local behavior is the bridge that converts old exact-version records into that newer model.

## Implementation plan

### Phase 1 — Add a narrow ClawHub update-spec resolver

Create a helper inside `src/plugins/update.ts` that decides the effective ClawHub update spec for targeted id-based updates.

Inputs:

- install record
- explicit `specOverride` if present
- whether the call is `update <id>` vs explicit spec

Output:

- `installSpec`
- `recordSpec`
- `modeLabel` for logs/debugging (for example `legacy-exact-clawhub`, `explicit-clawhub-selector`, `unversioned-clawhub`)

Rules:

1. If the user passed an explicit spec override, preserve it exactly.
2. If the record is already unversioned like `clawhub:episodic-claw`, keep it unversioned.
3. If the record is a legacy exact version like `clawhub:episodic-claw@0.5.0` and the update was invoked by plugin id only, interpret that id-only update as latest-line intent and switch the install spec to `clawhub:episodic-claw`.
4. If the record is an explicit dist-tag like `@beta`, keep the selector pinned.

### Phase 1.5 — Teach CLI selection to understand raw `clawhub:` specs

Current gap:

- `src/cli/plugins-update-command.ts` routes package-like selectors through npm parsing only
- raw `clawhub:episodic-claw@0.5.0` does not currently become a usable `specOverrides` entry

Required change:

- extend the update selection layer so explicit ClawHub specs resolve back to the tracked plugin id and carry a ClawHub `specOverride`

Without this small CLI-layer fix, these intended operator flows are not actually testable:

```bash
openclaw plugins update clawhub:episodic-claw@0.5.0
openclaw plugins update clawhub:episodic-claw@beta
```

### Phase 2 — Use the resolver in both dry-run and live update paths

Replace the current direct use of `record.spec` for ClawHub updates in `src/plugins/update.ts`:

- dry-run path: `src/plugins/update.ts:374-383`
- live update path: `src/plugins/update.ts:474-482`

with the resolved ClawHub install spec.

This keeps dry-run and real update behavior identical.

### Phase 3 — Add an unchanged preflight for ClawHub

Before doing the real install, compare:

- installed version from `readInstalledPackageVersion()`
- resolved ClawHub target version from the dry-run/probe result

If they match, return `unchanged` early without re-downloading.

This is a **new early-return check** for the ClawHub path. It makes the id-only latest-line behavior feel like a clean updater instead of a forced reinstall loop when nothing new exists.

### Phase 4 — Normalize the saved install record after successful update

When a legacy exact-version ClawHub record is updated through the compatibility path and succeeds:

- save the install record spec as unversioned `clawhub:<package>`
- keep `version`, `integrity`, `resolvedAt`, and ClawHub metadata as usual

This migrates the record once and avoids repeating the old broken path later.

### Phase 5 — Tests

Add focused tests only. No broad plugin-system rewrite tests.

Minimum cases:

1. **Legacy exact ClawHub record by id upgrades to unversioned latest line**
   - record spec `clawhub:episodic-claw@0.5.0`
   - `update episodic-claw`
   - updater should call install with `clawhub:episodic-claw`

2. **Explicit spec override stays pinned**
   - `update clawhub:episodic-claw@0.5.0`
   - updater should keep `@0.5.0`

3. **Beta spec stays pinned**
   - record spec `clawhub:episodic-claw@beta`
   - `update episodic-claw`
   - updater should keep `@beta`

4. **ClawHub unchanged skip**
   - installed version equals resolved target version
   - no reinstall should happen

5. **Successful legacy migration rewrites record spec to unversioned**
   - old record `@0.5.0`
   - after successful latest update, saved record becomes `clawhub:episodic-claw`

6. **Steady state after migration stays on latest line**
   - record spec already normalized to `clawhub:episodic-claw`
   - next `update episodic-claw` should continue following the newest compatible release line

## Risks

### Risk 1 — Breaking intentionally pinned exact-version workflows

If we convert every exact ClawHub spec to unversioned, operators who intentionally pinned a version would lose that behavior.

Mitigation:

- only auto-float the **id-based targeted update path when the operator did not spell a version or tag**
- do not rewrite explicit spec overrides
- do not rewrite `@beta`

### Risk 2 — Divergence from upstream latest docs

Upstream latest says explicit exact-version ClawHub selectors remain pinned, and unversioned ClawHub installs follow newer releases.

Mitigation:

- keep that rule for explicit selectors
- document DennouAibou's bridge as a legacy-record compatibility layer, not a new long-term divergent rule

### Risk 3 — Dry-run and real update drift

If the spec migration logic is applied only to the live path, dry-run would lie.

Mitigation:

- both paths must use the same resolver helper

## Verification checklist

- `openclaw plugins update episodic-claw --dry-run` reports newest available ClawHub version instead of `0.5.0 -> 0.5.0`
- `openclaw plugins update episodic-claw` installs the newer version when available
- second run of the same command reports unchanged without re-downloading
- `plugins.installs.episodic-claw.spec` becomes `clawhub:episodic-claw` after successful migration
- explicit `openclaw plugins update clawhub:episodic-claw@0.5.0` stays pinned
- explicit `openclaw plugins update clawhub:episodic-claw@beta` stays pinned

### Intended behavior summary

- `openclaw plugins update episodic-claw` → latest compatible ClawHub release line
- `openclaw plugins update clawhub:episodic-claw@0.5.0` → exact `0.5.0` stays pinned
- `openclaw plugins update clawhub:episodic-claw@beta` → beta line stays pinned

## Recommended next step

Implement only the targeted ClawHub compatibility shim plus unchanged skip.

Do **not** try to absorb upstream's full plugin index / official catalog / syncOfficialPluginInstalls system in the same patch. That is a bigger migration and should stay separate.

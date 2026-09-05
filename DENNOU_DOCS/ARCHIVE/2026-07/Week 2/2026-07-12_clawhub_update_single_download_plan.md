# ClawHub Plugin Update: Single-Download Repair Plan

## 1. Goal

Fix `openclaw plugins update <plugin-id>` so an update downloads, extracts, and security-scans a ClawHub archive exactly once when a newer version exists.

## 2. Confirmed Problem

KASOU update of `episodic-claw` from `0.5.0` to `0.5.1` resolved the correct latest-line selector, but performed the same expensive archive flow twice:

1. Resolve `clawhub:episodic-claw` to `0.5.1` → download → extract → security scan.
2. Resolve `clawhub:episodic-claw` to `0.5.1` again → download → extract → security scan → install.

The terminal evidence showed two distinct temporary archive directories and two `Downloading plugin episodic-claw@0.5.1 from ClawHub…` messages before the final `Updated episodic-claw: 0.5.0 -> 0.5.1.` result.

This is not an installation failure. The plugin correctly reached `0.5.1`; the duplicate download is avoidable update overhead.

## 3. Code Evidence

1. `src/plugins/update.ts:533-546` invokes `installPluginFromClawHub(... dryRun: true)` before an ordinary ClawHub update to detect an unchanged version.
2. `src/plugins/update.ts:579-587` invokes `installPluginFromClawHub(...)` a second time for the actual installation.
3. `src/plugins/clawhub.ts:294-316` downloads the archive before passing `dryRun` to `installPluginFromArchive`. Therefore dry-run is not metadata-only: it still downloads, extracts, and scans the archive.

The first call is like opening, unpacking, and inspecting a delivery just to check its label, then ordering the same delivery again to keep it.

## 4. Recommended Design

Add a metadata-only ClawHub resolver, for example `resolveClawHubPluginVersion()` in `src/plugins/clawhub.ts`.

It must perform only:

1. Parse the `clawhub:<name>[@selector]` spec.
2. Fetch package detail metadata.
3. Resolve the compatible version from that metadata.
4. Return package name, resolved version, compatibility information, and the existing ClawHub metadata needed by the caller.

It must **not** call `downloadClawHubPackageArchive()` or `installPluginFromArchive()`.

`update.ts` should use this resolver for the unchanged-version early skip:

- Installed version equals resolved version → report `unchanged`; zero archive downloads.
- Installed version differs → invoke `installPluginFromClawHub()` once; one archive download, one extraction, one scan, one installation.
- Metadata resolver failure → report the resolver error directly; do not fall through to a second blind install attempt.

The explicit-selector and legacy exact-version rules already implemented in `resolveClawHubUpdateSpec()` remain unchanged. This plan changes only how the target version is checked before the one real installation.

## 5. Non-goals

- Do not change `openclaw plugins update episodic-claw` latest-line behavior.
- Do not weaken ClawHub archive security scanning for actual installations.
- Do not add a second agent tool or change the plugin install record schema.
- Do not alter npm or marketplace update paths in this repair.

## 6. Implementation Phases

### Phase 1: Extract the metadata resolver

- Extract the parse → package-detail fetch → compatible-version resolution portion of `installPluginFromClawHub()` into a typed metadata-only helper.
- Preserve existing validation for package family and plugin API compatibility.
- Ensure this helper has no archive download, extraction, scan, target-directory, or config-write side effects.

### Phase 2: Replace the ClawHub update probe

- In `src/plugins/update.ts`, replace the non-dry-run update path's `installPluginFromClawHub(... dryRun: true)` probe at lines 533-560 with the metadata-only resolver.
- Compare `currentVersion` and the resolved target version.
- Return the unchanged outcome immediately when equal.
- Otherwise call the existing real installer once at lines 579-587.

### Phase 3: Keep update semantics aligned

- Preserve `resolveClawHubUpdateSpec()` behavior:
  - id-only update of legacy `@version` records follows latest line;
  - explicit version/tag selectors remain exact;
  - successful id-only legacy updates normalize the install record to unversioned `clawhub:<name>`.
- Preserve the existing security scan exactly once for an actual update.

### Phase 4: Test and review

- Add a test that verifies a changed ClawHub version performs one real installer call and no dry-run installer call.
- Add a test that an unchanged version performs zero real installer calls and zero archive downloads.
- Retain coverage for explicit selectors, legacy exact-record normalization, failed metadata resolution, and `--dry-run` command behavior.
- Run targeted plugin update tests, build, then code-reviewer review before any KASOU deployment.

## 7. Verification Criteria

For `openclaw plugins update episodic-claw` with `0.5.0` installed and `0.5.1` latest:

1. Exactly one `Downloading plugin episodic-claw@0.5.1 from ClawHub…` line.
2. Exactly one extraction directory.
3. Exactly one security scan.
4. Final output confirms `0.5.0 -> 0.5.1`.
5. Install record is saved as `clawhub:episodic-claw` after the id-only latest-line update.

For an already-current plugin, output reports `up to date` with no archive download, extraction, or scan.

## 8. Risks and Guards

| Risk                                                                          | Guard                                                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Metadata says a version is compatible but archive validation later rejects it | Keep the existing full validation and security scan in the one real installer call. Metadata preflight is only an early-skip optimization. |
| Metadata request fails transiently                                            | Surface the metadata error; do not silently download/install a version that was not resolved. The operator can retry.                      |
| The helper accidentally grows archive side effects later                      | Test that the metadata resolver never calls archive download/install functions.                                                            |
| Exact selectors accidentally float to latest                                  | Reuse `resolveClawHubUpdateSpec()` output without changing its selector rules.                                                             |

## 9. Decision

Implement this as a DennouAibou local fix to the upstream-origin plugin update code. Commit tag should be `[FIX-UPSTREAM]` because the affected update/install code originated in OpenClaw, even though the single-download behavior is being repaired in DennouAibou.

## 10. Implementation Status

Implemented locally:

- Added `resolveClawHubPluginVersion()` as a metadata-only resolver in `src/plugins/clawhub.ts`.
- Replaced the non-dry-run ClawHub archive probe in `src/plugins/update.ts`.
- Added changed-version, unchanged-version, metadata-error, selector, and legacy-normalization coverage in `src/plugins/update.test.ts`.
- Fixed the three review findings where older tests bypassed the new resolver through the error catch path.

Verification:

- `pnpm exec vitest run src/plugins/update.test.ts`: **24/24 PASS**.
- `git diff --check`: **PASS**.
- Full `pnpm build` is blocked by the Windows wrapper's `/bin/bash` lookup; the A2UI bundle step completed through Git Bash, and the changed TypeScript was compiled by the passing 24/24 Vitest run.
- Code-reviewer final re-review: **APPROVED**.

Deployment remains intentionally deferred until the implementation is committed and the release/deploy step is explicitly started.

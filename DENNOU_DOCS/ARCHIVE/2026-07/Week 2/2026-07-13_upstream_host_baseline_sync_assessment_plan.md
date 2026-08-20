# Upstream Host Baseline Sync Assessment Plan

## 1. Goal

Determine whether DennouAibou can safely move its OpenClaw host baseline forward far enough to support the upstream Codex app-server provider, while creating a repeatable sync process that makes later upstream updates cheaper and less error-prone.

This document is an assessment plan, not authorization to merge, rebase, cherry-pick, install dependencies, or deploy.

## 2. Core Decision

The assessment must produce one of three decisions:

1. **Selective GO** — a cohesive, limited upstream commit stack can supply the required host capabilities.
2. **Baseline GO** — the required commits are too interconnected; moving to a pinned upstream release baseline is safer than maintaining a selective patch stack.
3. **STOP** — either route would create unacceptable regressions or destroy DennouAibou's maintainable boundaries.

No implementation starts until the decision and its evidence receive code-reviewer approval and explicit user approval.

This assessment gates only the native Codex app-server track. A separate bounded track may continue using DennouAibou's existing `openai-codex` OAuth provider and `openai-codex-responses` transport for ordinary request/answer turns, provided it does not import Agent Harness, app-server, or new host contracts.

## 3. Current Reality

- `DENNOU_DOCS/ROADMAP.md:8` records the stable fork baseline as OpenClaw `v2026.4.5`.
- `DENNOU_RULES.md:9-21` requires Dennou-specific Soul code to remain isolated and upstream expansion hooks to remain healthy.
- `DENNOU_RULES.md:23-48` separates direct upstream imports (`[SYNC]`) from Dennou-authored fixes to upstream code (`[FIX-UPSTREAM]`).
- `DENNOU_DOCS/2026-04/Week 5/2026-04-28_versioning_release_identity_policy_v1.md:65-77` requires the old and new upstream baseline to be recorded when syncing.
- The Codex Phase 0 dependency matrix concluded **STOP** because the local host lacks the upstream Agent Harness subsystem, core harness dispatch, and `openai-chatgpt-responses` transport.
- That STOP applies to native Codex app-server migration. It does not invalidate the existing request/answer-only `openai-codex` provider, which already uses the local `openai-codex-responses` transport.
- The current branch has 99 DennouAibou commits after `v2026.4.5`; these include Soul features, upstream fixes, selective syncs, debloat changes, and documentation.
- The `upstream` remote exists, but its local tracking ref was stale during inspection: local `upstream/main` resolved to `156f4c89…`, while GitHub main resolved to `a674ce5e…` on 2026-07-13.
- The configured `upstream` push URL points to the official OpenClaw repository. A sync workflow should treat upstream as fetch-only to reduce accidental-push risk.

The repository is therefore not a clean old release waiting for a normal fast-forward. It is a maintained fork with valuable local history. The plan must preserve that history instead of pretending a wholesale upstream merge is routine.

## 4. Long-term Sync Principles

1. **Pin releases, not moving main.** Assess an immutable upstream tag or commit. Never implement against an unpinned `upstream/main` snapshot.
2. **Prefer upstream commits over copied files.** Preserve original commit ancestry and authorship where possible; avoid anonymous source snapshots.
3. **Keep Soul outside upstream core.** New Dennou behavior stays in isolated modules/hooks. Do not solve sync conflicts by spreading Soul logic into newly imported core files.
4. **Keep upstream fixes visible.** Maintain `[FIX-UPSTREAM]` patches separately from clean `[SYNC]` commits so each patch can later be dropped when upstream supersedes it.
5. **Rehearse outside the active workspace.** Use a disposable clone for conflict simulation. Do not mutate the working tree, create a worktree, or disturb unrelated local changes during assessment.
6. **Sync by subsystem waves.** Each wave must build and test before the next wave begins.
7. **No version-metadata lies.** Do not lower `minHostVersion`, Plugin API compatibility, or dependency floors unless the underlying runtime contract is genuinely present and tested.

## 5. Required Assessment Artifacts

The assessment should produce one primary Markdown report containing:

### Upstream target record

- target release/tag and immutable commit SHA;
- source release date;
- package/runtime versions relevant to the target;
- previous DennouAibou upstream base;
- assessment date and local HEAD.

### Commit dependency matrix

| Upstream commit / PR | Subsystem | Needed for Codex? | Parent dependencies | Local overlap | Conflict type | Tests | Decision |
| -------------------- | --------- | ----------------- | ------------------- | ------------- | ------------- | ----- | -------- |

### Local patch ledger

| Local commit | Tag | Upstream-owned files touched | Still needed upstream? | Conflict risk | Action |
| ------------ | --- | ---------------------------- | ---------------------- | ------------- | ------ |

Actions are limited to: keep, port after sync, replace with upstream, or retire after verified equivalence. Retirement remains a later implementation action: code-reviewer must approve the equivalence evidence first, and every deletion requires explicit user approval.

### Rehearsal report

- exact commits applied and order;
- clean applications versus conflicts;
- files and semantic areas affected;
- tests/builds run per wave;
- regressions and unresolved decisions;
- estimated implementation and rollback cost based on measured rehearsal results, not guesses.

## 6. Phase 0: Remote and Baseline Safety

- Verify `origin` and `upstream` URLs.
- Fetch upstream tags and commits before reading the local tracking ref.
- Pin one immutable upstream release or tag as the assessment target; use current main only for gap research, not as the implementation base. If no stable release meets the required Codex host/Plugin API floor, document the beta candidate and its tradeoffs; do not adopt a beta baseline without explicit user approval.
- Record the target SHA in the assessment report.
- Propose making the `upstream` remote fetch-only before implementation. Do not change remote configuration during documentation-only assessment.
- Verify `v2026.4.5` and the actual merge-base used by the fork.
- Record local HEAD and confirm the working tree contains unrelated files that must remain untouched.

Exit gate: the target is immutable, source refs are fresh, and no command in later phases can accidentally push to upstream.

## 7. Phase 1: Build the Upstream Commit Graph

Start from the minimum Codex host requirements already discovered:

- Agent Harness types, registry, selection, lifecycle, policy, and support;
- embedded runner dispatch through the harness selection path;
- Plugin SDK `agent-harness-runtime` surface;
- `registerAgentHarness` registry wiring;
- `openai-chatgpt-responses` Model API and transport;
- context-engine, compaction, tool-result, hook, auth, runtime-artifact, and shutdown contracts consumed by the harness;
- Codex plugin runtime and platform binary packaging.

For every required symbol, find the upstream introducing commit and recursively include its real prerequisites. Use commit/PR history, not only the final file state.

Classify each commit:

- **Required** — Codex cannot compile or execute without it.
- **Prerequisite** — not Codex-specific, but required by a Required commit.
- **Equivalent local implementation** — functionality already exists locally under a different shape; requires semantic comparison.
- **Optional** — UI, supervision, migration, media, web search, or operator surfaces outside the first Codex goal.
- **Reject** — unrelated product changes that should not enter the sync stack.

Exit gate: each required commit has a closed dependency chain and source evidence. No missing dependency may be replaced with an untested stub.

## 8. Phase 2: Map DennouAibou Ownership and Collision Risk

For every file touched by the candidate upstream stack:

1. Identify local commits that changed it after `v2026.4.5`.
2. Classify each local change as `[SOUL]`, `[FIX-SOUL]`, `[FIX-UPSTREAM]`, `[SYNC]`, or `[DEBLOAT]`.
3. Identify behavior that must survive the sync.
4. Identify upstream fixes that make a local patch obsolete.
5. Identify tests and reports that encode the current behavior.

High-risk collision areas require explicit review even if Git reports no textual conflict:

- gateway/auth/WebSocket lifecycle;
- model fallback and transcript persistence;
- session reset, replay limits, and compaction;
- Dennou prune and temporal-awareness hooks;
- liveness watchdog and heartbeat scheduler;
- provider model normalization and Gemini/OpenAI transports;
- plugin loading, plugin update, and public Plugin SDK contracts;
- KASOU build/deployment artifacts.

Exit gate: every overlapping local behavior has a keep/replace/port decision and at least one verification method.

## 9. Phase 3: Disposable-Clone Rehearsal

Perform the assessment in a disposable clone created outside the active workspace. The rehearsal must not push, deploy, modify KASOU, rewrite main history, or delete files from the real repository.

Two rehearsals are required:

### Rehearsal A: Selective commit stack

- Apply only the closed Required + Prerequisite commit graph.
- Preserve upstream commit identity/order where practical.
- Record every textual conflict and every manual semantic adaptation.
- Do not hide failures by copying final upstream files over conflicted local files.

### Rehearsal B: Pinned baseline integration

- Integrate the pinned upstream release as the candidate new host baseline in the disposable clone.
- Reapply or port the local patch ledger in dependency order.
- Measure whether this route produces fewer long-lived deviations than Rehearsal A.

The assessment compares the two rehearsals using measured evidence:

- number of candidate upstream commits;
- files and subsystems touched;
- local overlapping commits;
- textual conflicts and semantic conflicts;
- public Plugin SDK/API changes;
- new runtime and platform dependencies;
- failed tests attributable to the candidate sync;
- number of permanent Dennou-only patches left on upstream-owned files.
- estimated ongoing maintenance cost for the next upstream release cycle;
- effort required to restore intentional `[DEBLOAT]` removals without reintroducing their load paths.

The smallest diff is not automatically the safest route. Prefer the route with fewer permanent semantic forks and a clearer future update path.

## 10. Phase 4: Verification Waves

Apply and verify in dependency order inside the rehearsal clone.

### Wave A: Build and public contracts

- config/model API types;
- Plugin SDK exports and generated API/hash artifacts;
- package/workspace dependency integrity;
- build and public contract tests.

### Wave B: Generic Agent Harness host

- harness types, registry, selection, lifecycle, fallback OpenClaw harness;
- existing Pi runner behavior through the new generic dispatch;
- hook, tool, context-engine, compaction, and transcript behavior;
- no Codex plugin yet.

### Wave C: OpenAI transport changes

- `openai-chatgpt-responses` model API and request/stream routing;
- existing OpenAI API-key and `openai-codex` behavior;
- fallback, reasoning, usage, image, and prompt-cache behavior.

### Wave D: Codex plugin

- app-server process lifecycle;
- paginated live catalog;
- synthetic auth separation;
- basic native Codex turn;
- platform executable packaging.

### Wave E: Optional surfaces

Session supervision, operator commands, media, web search, migration, and UI changes remain excluded unless separately approved.

Exit gate: Wave E must have its own scoped plan and explicit user approval before any optional surface enters the implementation sequence.

Every wave requires focused tests, a build, and code-reviewer approval before the next wave. Broad failures must be separated into caused-by-sync versus pre-existing evidence; they cannot be waved away as unrelated without comparison against the unchanged baseline.

## 11. Phase 5: Decision Gate

### Selective GO

Choose only when:

- the required commit graph is closed and cohesive;
- the generic host waves pass without replacing large local subsystems;
- remaining Dennou patches on upstream-owned files are few, documented, and independently tested;
- a later upstream release can reuse the same commit/patch ledger.

### Baseline GO

Choose when:

- selective commits depend on broad upstream refactors anyway;
- pinned-baseline rehearsal has fewer semantic conflicts and permanent patches;
- all critical Dennou behavior survives the rehearsal;
- rollback to the previous Dennou release artifact remains tested.

### STOP

Stop when:

- the sync requires deleting or silently weakening Dennou-owned features;
- critical behavior lacks regression tests or cannot be verified;
- upstream and local architectures cannot coexist without permanent duplicated execution paths;
- either rehearsal leaves an unmaintainable patch surface;
- KASOU packaging/runtime constraints cannot be satisfied safely.

The decision report must recommend one route. It must not conclude "either is fine."

## 12. If GO: Implementation Rules

- Implement only one approved wave at a time.
- Preserve clean upstream imports as `[SYNC]` commits.
- Put conflict adaptations or Dennou fixes to upstream-owned code in separate `[FIX-UPSTREAM]` commits.
- Keep new Dennou-only compatibility glue isolated and separately tagged `[SOUL]`.
- Never combine Soul behavior, upstream sync, generated artifacts, and deployment changes in one commit.
- Append the upstream old/new base, imported commit range, unresolved local patches, tests, and review result to the assessment report after every wave.
- Do not update KASOU until all approved waves are complete and the final code-reviewer gate is APPROVED.

## 13. Future Update Workflow

After the first successful baseline move, every later upstream assessment should reuse the same lightweight process:

1. Fetch tags from the fetch-only upstream remote.
2. Select a stable upstream release and record its immutable SHA.
3. Compare the recorded current base to the candidate base.
4. Check whether each retained `[FIX-UPSTREAM]` patch's intent and observable behavior are now present upstream; textual similarity alone is not equivalence.
5. Generate the subsystem/commit matrix for new changes.
6. Rehearse in a disposable clone.
7. Apply in waves only after approval.
8. Update the upstream base record and release notes.

Maintain one upstream patch ledger rather than rediscovering local deviations during every release. Each retained patch should record:

- local commit SHA;
- upstream-origin file/symbol;
- why the patch still exists;
- related upstream issue/PR when available;
- tests that protect it;
- status: local-only, proposed upstream, accepted upstream, or safe to retire.

Do not automate the whole workflow before it succeeds manually once. After two successful assessment/sync cycles, a small reporting script may automate fetching metadata, changed-file lists, and matrix scaffolding. Conflict decisions and semantic equivalence remain human-reviewed.

## 14. Rollback

Assessment rollback is simply deleting the disposable clone; the real repository and KASOU remain unchanged.

If a later approved implementation proceeds:

1. Build a complete Dennou release artifact before KASOU deployment.
2. Preserve the previous known-good artifact and config backup.
3. Deploy the candidate once.
4. Verify gateway, Control UI, channels, CLI, agent turns, session replay, pruning, memory, and required providers.
5. If a critical gate fails, restore the previous artifact and config without rewriting Git history.

The later implementation plan must choose the mechanical rollback method for each approved wave: artifact/config re-deployment for runtime rollback and `git revert` for landed source changes. `reset --hard`, force-push, and broad restore operations are not rollback methods.

Deletion of obsolete code, patches, credentials, or deployment paths remains a separate approval-gated cleanup after the new baseline is stable.

## 15. Assessment Acceptance Criteria

- Upstream remote/source freshness and immutable target pin are documented.
- Official upstream push is disabled or otherwise made impossible before implementation commands begin.
- Every required Codex host symbol maps to an introducing upstream commit and closed prerequisite chain.
- Every overlapping Dennou change has a keep/replace/port decision.
- Selective and baseline rehearsals both have measured results.
- Each verification wave has tests, build evidence, and review findings.
- The recommended route leaves a smaller, explicit, reusable patch ledger.
- Rollback is artifact-based and does not require history rewriting.
- The final decision receives code-reviewer approval and explicit user approval.

## 16. Recommendation

Run this assessment before any Codex Phase 1 implementation. Given the current gap between the `v2026.4.5` fork and the 2026.7.2 Plugin API/harness architecture, **Baseline GO is currently a hypothesis, not a decision**. The hypothesis comes from the Codex Phase 0 breadth evidence: roughly 25 production Agent Harness files, about 55 consumed harness-runtime symbols, and a core dispatch rewrite. The commit graph and both measured rehearsals must confirm or override it. Until then, the only approved action is assessment and documentation.

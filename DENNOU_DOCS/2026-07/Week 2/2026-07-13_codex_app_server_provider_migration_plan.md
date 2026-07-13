# Codex App-Server Provider Migration Plan

## 1. Goal

Adopt upstream OpenClaw's Codex app-server provider so DennouAibou discovers the Codex models actually available to the signed-in account instead of extending a manually maintained model-name list.

The migration must preserve the current `openai-codex` OAuth provider until the new `codex` provider passes real KASOU catalog and inference checks.

The plan also preserves a smaller independent path for the current requirement: continue using the existing `openai-codex` OAuth provider for ordinary request/answer turns, with bounded provider-local model compatibility and no app-server or Agent Harness features.

## 2. Current Reality

DennouAibou currently exposes Codex through the OpenAI extension's `openai-codex` provider:

- `extensions/openai/openclaw.plugin.json:2-5` declares `openai` and `openai-codex` under one plugin.
- `extensions/openai/openai-codex-catalog.ts:3-10` creates an empty static catalog using the ChatGPT backend and `openai-codex-responses` transport.
- `extensions/openai/openai-codex-provider.ts:39-83` defines the primary GPT-5.4/5.4 Mini IDs and the GPT-5.3 Codex/Spark template and compatibility sets.
- `extensions/openai/openai-codex-provider.ts:113-175` synthesizes runtime model definitions from older templates when those model IDs are requested.

This works for known models, but the code predicts availability from names and templates. It does not ask the user's Codex account which models are currently enabled.

The upstream main branch now has a separate `extensions/codex/` plugin. DennouAibou currently has no `extensions/codex/` directory.

## 3. Upstream Evidence

1. Upstream `extensions/codex/provider.ts` calls Codex app-server `model/list`, follows pagination, filters hidden rows, and builds the provider catalog from the returned account-visible models. If live discovery fails, it uses an offline fallback catalog.
2. Upstream `extensions/codex/provider-catalog.ts` currently includes fallback rows such as GPT-5.6 Sol, GPT-5.6 Luna, GPT-5.5, and GPT-5.4 Mini. These fallback names are not proof that every account can invoke them; live `model/list` remains authoritative.
3. Official Codex app-server documentation defines `model/list` results with model ID, display name, supported reasoning efforts, default effort, input modalities, default status, and upgrade metadata.
4. Upstream `extensions/codex/package.json` depends on `@openai/codex` `0.144.1`, requires platform-specific Codex packages, declares plugin API compatibility `>=2026.7.2`, and requires host version `>=2026.5.1-beta.1`.

The practical difference is like replacing a handwritten restaurant menu with the kitchen's live menu. A copied model name can exist on paper while the signed-in account still cannot order it; `model/list` reports what that account can really use.

## 4. Options

### Option A: Add more IDs to `openai-codex`

Add only verified upstream model IDs to the current forward-compat resolver, keep them configured-only at first, and continue using the existing OAuth and `openai-codex-responses` transport.

- Cost: low.
- Risk: low to medium when IDs and metadata are pinned, catalog exposure is delayed, and no entitlement is claimed before a live OAuth turn.
- Limitation: it cannot provide native app-server threads, live `model/list`, session supervision, or app-server reasoning/default metadata.
- Decision: **recommended for the current request/answer-only requirement** under Track B and Section 16 gates.

### Option B: Backport upstream Codex app-server provider alongside `openai-codex`

Bring in the upstream `codex` provider and its required public Plugin SDK/runtime seams. Keep `openai-codex` enabled during validation.

- Cost: medium to high.
- Risk: medium, controlled by parallel rollout.
- Benefit: models and reasoning capabilities follow the account's live Codex catalog.
- Decision: desired long-term Track A architecture, but currently STOP pending a compatible host-baseline assessment.

### Option C: Immediately replace `openai-codex`

Delete or redirect the current provider as soon as the upstream plugin builds.

- Cost: high because config, auth profiles, model refs, fallbacks, and tests all change at once.
- Risk: high; rollback becomes harder and current working OAuth traffic can regress.
- Decision: reject for the first release.

## 5. Scope and Non-goals

Sections 5 through 13 describe Track A, the native Codex app-server migration. Track B's smaller request/answer-only scope is defined separately in Section 16.

In scope:

- Codex app-server startup and communication required for provider inference.
- Live paginated `model/list` catalog discovery.
- Offline fallback catalog.
- Account-visible reasoning-effort metadata.
- A distinct `codex/<model-id>` provider namespace during rollout.
- Focused onboarding/config and model-picker exposure needed to use the provider.

Not in the first migration:

- Codex session supervision, remote paired-computer browsing, archive/continue commands, or transcript mirroring.
- Automatic deletion of `openai-codex` auth profiles or model configuration.
- The upstream Codex migration provider (`buildCodexMigrationProvider`). Existing `openai-codex/...` entries are not auto-migrated in the first release; Phase 6 owns an explicit doctor/migration path.
- Advertising unverified upstream model IDs or guessed account entitlement through the old provider.
- Google Gemini CLI changes. `gemini-3.5-flash` remains a separate, smaller upstream-sync task.

This separation follows YAGNI: first deliver account-backed model discovery and inference. Add Codex supervision only after the provider itself is stable and there is a concrete need for session management.

## 6. Minimum Viable Architecture

The smallest useful unit is not catalog code alone. Upstream `extensions/codex/index.ts` registers both `buildCodexProvider()` and `createCodexAppServerAgentHarness()`.

The first DennouAibou version therefore needs:

1. Codex process/app-server startup and request transport.
2. The model-list client and paginated live catalog discovery.
3. The provider definition and synthetic auth marker.
4. The agent harness that sends model turns through Codex app-server.
5. Only the binding state required for normal model turns and safe cleanup.

All direct `./src/app-server/` imports used by upstream `harness.ts` are mandatory Phase 0 inventory items, including turn attempts, side questions, compaction, session binding, shared-client lifecycle, auth binding, and runtime artifacts. They are execution dependencies, not optional supervision features.

It does not initially need:

- `codex_threads` tools;
- remote node session browsing;
- archive/continue operator commands;
- media-understanding and web-search provider surfaces;
- native Codex session supervision and transcript mirroring;
- migration of existing chats to native Codex bindings.

If the harness cannot be separated from those optional surfaces without copying large private subsystems, stop and choose the full upstream plugin compatibility route instead of creating a long-lived partial fork.

## 7. Compatibility Gate

DennouAibou must not claim compatibility by only changing a version string. Before importing runtime code, compare every Codex production import against the local public Plugin SDK and runtime contracts.

The version gap is explicit: DennouAibou's host baseline is `2026.4.6`, while the reviewed upstream Codex package declares host `>=2026.5.1-beta.1` and Plugin API `>=2026.7.2`. Package metadata must not be lowered to bypass that gap.

Initial source inspection already establishes:

- `resolveSyntheticAuth` exists locally in `src/plugins/types.ts` and provider runtime resolution.
- `registerAgentHarness` and the upstream `AgentHarness` contract do not exist locally.
- The upstream `openai-chatgpt-responses` API identifier is not recognized in the local source; local Codex currently uses `openai-codex-responses`.
- `registerMigrationProvider` is not locally available and is intentionally deferred with the migration provider, not silently omitted.

Required checks include:

- `registerAgentHarness` and the full harness contract, including auth bootstrap/binding, runtime artifacts, context-engine/compaction capabilities, reset, and disposal semantics;
- provider catalog and synthetic-auth hooks;
- correct routing for upstream `openai-chatgpt-responses`, either by backporting that transport contract or by a proven mapping to an existing equivalent transport without changing Codex semantics;
- app-server process spawn, WebSocket/JSON-RPC, timeout, and shutdown behavior;
- runtime state/store APIs needed by harness bindings;
- config access and plugin enablement behavior;
- platform-package resolution for Linux x64 on KASOU and Windows for local tests;
- current OpenAI OAuth/profile coexistence rules.

Gate result:

- **GO**: every required upstream import resolves against the local public Plugin SDK/runtime without a version-string bypass, or can be backported as a small, generic, tested addition.
- **STOP**: required seams depend on broad post-2026.4.6 plugin/runtime refactors. In that case, first plan a bounded host-baseline sync; do not patch private core imports into the extension.

## 8. Implementation Phases

### Phase 0: Pin and inventory upstream source

- Record the exact upstream OpenClaw commit and `@openai/codex` version used for the backport.
- List every production file required by provider discovery, app-server transport, harness turns, and binding cleanup.
- Treat every app-server module imported by upstream `harness.ts` as mandatory until the dependency matrix proves otherwise; do not classify run-attempt, side-question, compact, session-binding, shared-client, auth-binding, or runtime-artifact modules as supervision-only.
- Build a dependency matrix: upstream file → imported Plugin SDK seam → local availability → required backport.
- Exclude supervision, CLI session management, media, web search, and operator tools from the initial inventory unless the harness directly requires them.

Exit gate: code-reviewer approves the dependency matrix and confirms that no private cross-extension imports are planned.

### Phase 1: Backport generic host contracts

- Add only missing generic Plugin SDK/runtime seams required by Codex provider and harness code.
- Backport the generic agent-harness registration and lifecycle contract before copying provider registration code.
- Verify the local `resolveSyntheticAuth` seam satisfies the upstream Codex marker contract; extend it only if a concrete type/runtime mismatch is found.
- Backport or explicitly map `openai-chatgpt-responses` only after request/response, OAuth, streaming usage, and reasoning behavior are shown equivalent.
- Preserve extension boundaries: Codex production code imports `openclaw/plugin-sdk/*`, not local `src/**` internals.
- Add contract tests for each new public seam.
- Regenerate Plugin SDK API/hash artifacts when the public SDK surface changes.

Exit gate: existing provider plugins still load, Plugin SDK contract checks pass, and no Codex-specific branching is added to unrelated core paths.

### Phase 2: Add Codex runtime dependency and platform packaging

- Add the upstream-compatible `@openai/codex` dependency using pnpm; do not hand-edit a guessed version.
- Confirm the required Linux x64 package is included in KASOU deployment artifacts.
- Verify the selected Linux x64 binary actually starts on KASOU's Debian/glibc environment; package presence alone is not sufficient.
- Keep Windows-compatible package resolution for local build/test use.
- Add an explicit startup error for a missing or incompatible Codex binary instead of silently returning an empty catalog.

Exit gate: local and Linux smoke checks can start app-server, send a ping/request, and shut it down without orphaning a process.

### Phase 3: Add the parallel `codex` provider

- Add `extensions/codex/` with the minimum viable provider + harness surface.
- Register provider ID `codex`; do not rename or overwrite `openai-codex`.
- Use `resolveSyntheticAuth` to return the upstream Codex app-server marker (`source: codex-app-server`, token mode). This path remains separate from stored `openai-codex` OAuth profiles.
- Do not expose `openai-codex` profile-store entries to `codex` catalog or harness resolution, and do not expose the Codex synthetic marker to the old transport.
- Use paginated `model/list` as the authoritative catalog.
- Keep an offline fallback catalog only for discovery failure; do not treat fallback rows as entitlement proof.
- Preserve model-provided reasoning efforts, input modalities, default status, and context metadata.

Exit gate: model picker can show both `openai-codex/...` and `codex/...`, and provider resolution never confuses their auth/transport paths.

### Phase 4: Real-account validation on KASOU

- Install/deploy only after local tests and code-reviewer approval.
- Query the live Codex catalog using the actual signed-in KASOU account.
- Record which model IDs are returned; do not assume every upstream fallback model is available.
- Run one minimal text turn on the returned default model.
- Run image-input and each advertised reasoning effort only when the live catalog says they are supported.
- Verify process cleanup after gateway restart and after a failed turn.

Exit gate: catalog, one real turn, usage/rate-limit reading where supported, restart, and fallback behavior all pass.

### Phase 5: Controlled adoption

- Keep the existing default model unchanged during an observation period.
- Add a deliberate opt-in model alias/config for `codex/<live-default>`.
- Observe authentication refresh, timeout, fallback, transcript persistence, and gateway resource use.
- Promote `codex` to the preferred Codex route only after the observation period passes.

Exit gate: user explicitly approves changing any default/fallback model route.

### Phase 6: Decide the old provider's future

- If the new provider is stable, mark `openai-codex` as compatibility-only first.
- Provide a doctor/migration path for explicit old model refs and auth profiles.
- Remove the old provider only in a later release with a tested rollback and documented migration.

No automatic deletion is allowed in this phase without separate user approval.

## 9. Required Tests

### Compatibility and catalog

- Live discovery collects all pages and filters hidden models.
- Discovery timeout/failure uses the fallback catalog without crashing gateway startup.
- A live empty catalog is distinguished from a request failure.
- Account-returned reasoning efforts and modalities survive catalog conversion.
- Unknown future model IDs returned by app-server remain usable without a core hardcoded allowlist.

### Provider separation

- `codex/<id>` uses app-server harness and synthetic app-server auth.
- `openai-codex/<id>` continues using the existing ChatGPT OAuth transport.
- Auth profiles and model refs cannot cross between the two providers accidentally.
- With both providers registered, stored `openai-codex` OAuth profiles are invisible to `codex` catalog/harness auth resolution, while the `codex-app-server` synthetic marker is invisible to `openai-codex` transport resolution.
- Existing OpenAI API-key and `openai-codex` tests remain green.

### Process lifecycle

- Cold startup, request timeout, malformed app-server response, child crash, gateway shutdown, and gateway restart.
- No orphan Codex process after failed startup or shutdown.
- After a simulated gateway restart, an OS-level process check (`pgrep` or platform equivalent) confirms that no Codex app-server process from the previous gateway remains.
- Concurrent catalog and turn requests follow the upstream connection-sharing rules.

### Real validation

- A model returned by KASOU `model/list` completes a small text turn.
- A nonexistent hardcoded model is not presented as account-confirmed.
- Advertised reasoning levels map correctly; unsupported levels are rejected or safely downgraded according to upstream behavior.

## 10. Risks and Guards

| Risk | Guard |
| --- | --- |
| New models appear in fallback but are unavailable to the account | Treat live `model/list` as authoritative and clearly label fallback-only discovery. |
| Provider-only copy shows models but cannot execute turns | Treat provider + app-server harness as one minimum unit and require a real turn test. |
| Host/plugin API version mismatch | Complete the compatibility matrix first; never bypass min-host/plugin-API checks by changing metadata alone. |
| Codex child process survives gateway shutdown | Port upstream shutdown supervision and add orphan-process regression tests. |
| Existing `openai-codex` users regress | Run both providers in parallel and leave defaults unchanged until explicit approval. |
| Partial fork becomes permanent maintenance debt | Pin upstream source, minimize deviations, and stop if optional subsystems cannot be cleanly separated. |
| New public Plugin SDK seams regress other plugins | Keep seams generic, additive, documented, and contract-tested. |

## 11. Rollback

The first rollout is additive, so rollback is intentionally simple:

1. Disable the `codex` plugin/provider entry.
2. Restore the previous `openai-codex/...` model selection.
3. Stop the Codex app-server child and verify no process remains.
4. Leave existing `openai-codex` credentials and configuration untouched.
5. Revert only the Codex feature commits if the provider cannot be stabilized.

Do not delete the existing provider or credentials during the initial rollout; that would turn a simple switch-back into data recovery.

## 12. Acceptance Criteria

- Dependency matrix and scope receive code-reviewer approval before implementation.
- Required generic Plugin SDK seams pass contract tests.
- Codex app-server starts and stops cleanly on local and KASOU Linux environments.
- The model list comes from the signed-in account and supports pagination.
- One account-listed model completes a real turn.
- No model is called supported solely because it exists in the fallback catalog.
- Current `openai-codex` behavior remains available and unchanged.
- No default/fallback route changes without explicit user approval.

## 13. Commit Classification

- Direct upstream files imported without Dennou-specific changes: `[SYNC]`.
- DennouAibou fixes to upstream-origin host/provider code: `[FIX-UPSTREAM]`.
- New DennouAibou-only compatibility glue, if unavoidable: `[SOUL]`, kept in a separate commit.
- Plan and implementation report updates: `[DOCS]`.

## 14. Recommendation

The work is now split into two tracks with different goals.

### Track A: Native Codex app-server

**Phase 0 result: STOP.** Phase 0 dependency analysis (Section 15) confirmed that the upstream Codex app-server harness requires the entire `src/agents/harness/` subsystem (~25 production files; 39 total including tests), a rewrite of the core agent execution dispatch path (`src/agents/embedded-agent-runner/run.ts` → `selectAgentHarness()`), and a new `ModelApi` variant (`openai-chatgpt-responses`) with transport-layer implementation. These are not bounded generic backports; they are broad post-2026.4.6 core refactors that trigger the plan's STOP condition.

The next Track A action is the separate bounded upstream host-baseline sync assessment. It evaluates moving DennouAibou from the 2026.4.6 host to a compatible pinned baseline rather than backporting the harness subsystem piecemeal.

### Track B: Existing OAuth request/answer provider

**Recommended for the current user requirement.** DennouAibou already has browser OAuth, token refresh, the `openai-codex-responses` transport, ChatGPT backend routing, dynamic model resolution, replay policy, and normal response streaming. Track B keeps that architecture and updates only provider-local model compatibility.

Track B is not a replacement for native app-server turns. It intentionally provides only ordinary model request/answer behavior through the existing generic inference loop. It excludes Codex session supervision, app-server threads, migration, native Codex commands, additional provider tools, and app-server lifecycle management.

Do not advertise a new model solely because its ID appears upstream. New IDs first remain configured-only forward-compat entries. Catalog exposure requires a successful OAuth-backed live turn for the actual account and explicit user approval.

## 15. Phase 0 Dependency Matrix (corrected 2026-07-13)

### Pinned Upstream Source

- **Upstream commit**: `a674ce5e0d1ab0774546086fa7b2730516eca176` (upstream/main, verified 2026-07-13)
- **`@openai/codex` version**: `0.144.1` (`extensions/codex/package.json` + `src/app-server/version.ts`)
- **Upstream `openclaw` version**: `2026.7.2` (`extensions/codex/package.json` → `openclaw.build.openclawVersion`)
- **Upstream `minHostVersion`**: `>=2026.5.1-beta.1`
- **Upstream `pluginApi`**: `>=2026.7.2`
- **Local host baseline**: `2026.4.6` (DennouAibou `src/agents/pi-embedded-runner/`, no `src/agents/harness/` directory)
- **Local commit inspected**: `09da80d7d7e`

### Verified Local Facts

| Fact | Verified | Evidence |
|---|---|---|
| `resolveSyntheticAuth` exists | **Yes** | `src/plugins/types.ts:1517` — optional method on `ProviderPlugin`; called in `src/agents/models-config.providers.implicit.ts:188` and `src/plugins/provider-runtime.ts:789` |
| `registerAgentHarness` / `AgentHarness` absent | **Confirmed** | `src/agents/harness/` directory does not exist. Zero matches across `src/` for `AgentHarness` type or `registerAgentHarness`. `src/plugins/types.ts` and `src/plugins/api-builder.ts` have no harness-related code |
| `openai-chatgpt-responses` absent locally | **Confirmed** | `src/config/types.models.ts:8` lists `MODEL_APIS` with `openai-codex-responses` but NOT `openai-chatgpt-responses`. `src/agents/provider-transport-stream.ts:14` has `openai-codex-responses` in `SUPPORTED_TRANSPORT_APIS`. No file in the repo mentions `openai-chatgpt-responses` |
| `openai-codex-responses` present locally | **Confirmed** | Used in ~80+ locations across `src/`, `extensions/openai/openai-codex-catalog.ts:8` |
| `registerMigrationProvider` absent | **Confirmed** | Zero matches. Upstream `src/plugins/types.ts` has it |
| `registerCodexAppServerExtensionFactory` absent | **Confirmed** | Zero matches. Upstream `src/plugins/types.ts` has it |
| `registerCompactionProvider` absent | **Confirmed** | Zero matches |
| `registerAgentToolResultMiddleware` absent | **Confirmed** | Zero matches |
| `smol-toml` absent locally | **Confirmed** | Not in `package.json` dependencies. Upstream `extensions/codex/src/app-server/config.ts` imports `parse as parseToml` from `smol-toml` |
| `typebox` absent locally | **Confirmed** | Not in `package.json` dependencies. Upstream `extensions/codex/src/app-server/protocol-validators.ts` imports `Compile` from `typebox/compile` |
| `ws` present locally | **Confirmed** | `package.json`: `^8.20.0`. Upstream requires `8.21.0`. Minor version range — likely compatible but must verify |
| `zod` present locally | **Confirmed** | `package.json`: `^4.3.6`. Upstream requires `4.4.3`. Minor version range — likely compatible but must verify |

### Critical Upstream-vs-Local Discovery

**Transport API mismatch (hard blocker).** Upstream `provider-catalog.ts` now emits `api: "openai-chatgpt-responses"` in `buildCodexModelDefinition()` and `buildCodexProviderConfig()`. Local 2026.4.6:

- `src/config/types.models.ts` MODEL_APIS: does NOT include `openai-chatgpt-responses`
- `src/agents/provider-transport-stream.ts` SUPPORTED_TRANSPORT_APIS: does NOT include `openai-chatgpt-responses`
- `src/agents/provider-transport-stream.ts` SIMPLE_TRANSPORT_API_ALIAS: no entry for `openai-chatgpt-responses`

The local host would reject the model at configuration time. This requires BOTH (1) a `ModelApi` union/schema update to add `openai-chatgpt-responses`, AND (2) an actual transport implementation that handles the new API variant. An alias-by-name mapping is insufficient — the new API variant has different wire semantics than `openai-codex-responses`.

**Entire harness subsystem absent locally.** `src/agents/harness/` does not exist in local 2026.4.6. Upstream has ~25 production files (39 total including tests) implementing `AgentHarness` type, registry, selection, lifecycle, policy, support, builtin-openclaw harness, result classification, context-engine lifecycle, compaction recovery, native hook relay, tool surface bridge, tool result middleware, user input bridge, hook context/helpers/history, and codex app-server extensions.

**Core execution path rewired.** Upstream `src/agents/embedded-agent-runner/run.ts` calls `selectAgentHarness()` from `src/agents/harness/selection.ts` as the primary dispatch mechanism. Local 2026.4.6 has no such routing. The harness selection system introduces `AgentHarnessPolicy`, `resolveAgentHarnessPolicy`, `selectAgentHarness`, `selectAgentHarnessForPreparedModelProviders`, `agentHarnessBuildsOpenClawTools`, `agentHarnessExposesOpenClawTools`, and tool-policy wrappers — none of which exist locally.

**Surgical hook assessment: NOT viable.** The harness dispatch is deeply integrated into the core execution path. Upstream `src/agents/embedded-agent-runner/run.ts` directly calls `selectAgentHarness()` to select and invoke the harness. Local `src/agents/pi-embedded-runner/run/attempt.ts` (the local equivalent execution file path) has no harness references — it goes directly to Pi transport. Two source references confirm this:
1. `src/agents/embedded-agent-runner/run.ts` — `let agentHarness = selectAgentHarness({...})` at the core dispatch point
2. `src/agents/harness/selection.ts` — exports `selectAgentHarness`, `runAgentHarnessAttempt`, `resolveAgentHarnessPreparedAuthSupport`, `agentHarnessBuildsOpenClawTools`, `agentHarnessExposesOpenClawTools` — the entire selection/policy/support system

There is no surgical hook point that would allow registering a Codex harness without backporting the full selection infrastructure.

### Harness Execution Classification

`run-attempt.ts`, `side-question.ts`, and `compact.ts` are **runtime-mandatory on first turn**. They are loaded via dynamic `import()` from `harness.ts`, not statically imported by `harness.ts`. Their own transitive imports must compile once loaded. The harness.ts dynamic import sites:

```
await import("./src/app-server/run-attempt.js");
await import("./src/app-server/side-question.js");
await import("./src/app-server/compact.js");
await import("./src/app-server/auth-binding.js");
await import("./src/app-server/runtime-artifact.js");
await import("./src/app-server/session-binding.js");
await import("./src/app-server/shared-client.js");
```

These files and ALL their transitive imports are mandatory for turns to execute.

### Tier 1: Core Infrastructure Required by Host

These `openclaw/plugin-sdk/*` and `src/*` modules are imported by upstream Codex extension code. If any is absent or has different exports, the extension will not compile.

| SDK seam / core module | Upstream usage | Local status | Gap |
|---|---|---|---|
| `openclaw/plugin-sdk/plugin-entry` (`definePluginEntry`, `OpenClawPluginApi`) | `index.ts`, `provider.ts` | **Present** | `OpenClawPluginApi` is missing `registerAgentHarness` |
| `openclaw/plugin-sdk/agent-harness-runtime` (full barrel) | `run-attempt.ts`, `side-question.ts`, `compact.ts`, `harness.ts`, `session-binding.ts` | **Entirely absent** — `src/agents/harness/` directory does not exist | CRITICAL: entire subsystem (~25 production files; 39 total including tests) must be backported |
| `src/agents/harness/*` (~25 production files; 39 total including tests: types, registry, selection, lifecycle, policy, support, builtin-openclaw, errors, result-classification, runtime-artifact, context-engine-lifecycle, compaction, native-hook-relay, tool-surface-bridge, tool-result-middleware, user-input-bridge, hook-context/helpers/history, lifecycle-hook-helpers, codex-app-server-extensions) | Core execution path | **Entirely absent** | Must be backported wholesale |
| `openclaw/plugin-sdk/agent-runtime` (`resolveDefaultAgentDir`, `ensureAuthProfileStore`, `resolveProviderIdForAuth`, `resolveSessionAgentIds`, etc.) | `auth-bridge.ts`, `session-binding.ts`, `shared-client.ts` | **Present** | Verify export compatibility |
| `openclaw/plugin-sdk/config-contracts` (`OpenClawConfig`) | Pervasive | **Present** | OK |
| `openclaw/plugin-sdk/plugin-config-runtime` | `index.ts`, `provider.ts` | **Present** | OK |
| `openclaw/plugin-sdk/config-mutation` | `index.ts` | **Present** | OK |
| `openclaw/plugin-sdk/provider-model-shared` (`ModelProviderConfig`, `ModelDefinitionConfig`, `ProviderPlugin`) | `provider.ts`, `provider-catalog.ts` | **Present** | OK, but `ModelApi` type union differs |
| `openclaw/plugin-sdk/expect-runtime` | `provider.ts`, `managed-binary.ts` | **Present** | OK |
| `openclaw/plugin-sdk/security-runtime` (`withTimeout`) | `timeout.ts` | **Present** | OK |
| `openclaw/plugin-sdk/windows-spawn` | `config.ts`, `transport-stdio.ts` | **Present** | OK |
| `openclaw/plugin-sdk/string-coerce-runtime` | `config.ts`, `models.ts` | **Present** | OK |
| `openclaw/plugin-sdk/number-runtime` | `config.ts` | **Present** | OK |
| `openclaw/plugin-sdk/routing` | `config.ts` | **Present** | OK |
| `openclaw/plugin-sdk/text-utility-runtime` | `client.ts` | **Present** | OK |
| `openclaw/plugin-sdk/core` | `provider.ts` | **Present** | OK |
| `openclaw/plugin-sdk/exec-approvals-runtime` | `run-attempt.ts` | **Present** | OK |
| `openclaw/plugin-sdk/session-store-runtime` | `session-binding.ts` | **Present** | OK |
| `openclaw/plugin-sdk/plugin-state-runtime` | `session-binding-store.ts` | **Present** | OK |
| `openclaw/plugin-sdk/diagnostic-runtime` | `run-attempt.ts` | **Present** | OK |
| `openclaw/plugin-sdk/provider-usage` | `rate-limits.ts` | **Present** | OK |
| `openclaw/plugin-sdk/extension-shared` | `shared-client.ts` | **Present** | OK |
| `ModelApi` type union | Upstream emits `openai-chatgpt-responses` | **Absent** | Must add `openai-chatgpt-responses` to `MODEL_APIS` + transport routing AND implement transport |
| `PluginAgentHarnessRegistration` type | `src/plugins/registry-types.ts` | **Absent** | Must backport |
| `AgentHarness` type | `src/agents/harness/types.ts` | **Absent** | Must backport |

### Tier 2: Extension Files (all absent locally)

All files live under `extensions/codex/` which does not exist locally.

#### A. Mandatory for trimmed minimal provider+harness entry

These files are needed for a trimmed `index.ts` that only registers provider + harness:

| File | Purpose | Key imports |
|---|---|---|
| `extensions/codex/harness.ts` | `createCodexAppServerAgentHarness()`: `supports()`, `runAttempt()`, `runSideQuestion()`, `compact()`, `reset()`, `dispose()`, `authBootstrap`, `authBinding.fingerprint`, `runtimeArtifact.validate` | Type-only imports from `agent-harness-runtime`; dynamic imports of `run-attempt.js`, `side-question.js`, `compact.js`, `session-binding.js`, `shared-client.js`, `auth-binding.js`, `runtime-artifact.js` |
| `extensions/codex/provider.ts` | `buildCodexProvider()`: catalog, dynamic model, thinking, synthetic auth, usage snapshot | `provider-catalog.js`, `prompt-overlay.js`, `config.js`, `models.js`, `rate-limits.js` |
| `extensions/codex/provider-catalog.ts` | `buildCodexModelDefinition()`, `buildCodexProviderConfig()`, `FALLBACK_CODEX_MODELS`, `CODEX_APP_SERVER_AUTH_MARKER` | Type imports from `provider-model-shared`; `models.js` |
| `extensions/codex/prompt-overlay.ts` | GPT-5 system prompt contribution | `provider-model-shared` |
| `extensions/codex/src/app-server/config.ts` | Zod config schema, runtime options, start options, approval/sandbox policy | **`smol-toml`** (mandatory new dep) |
| `extensions/codex/src/app-server/models.ts` | `listCodexAppServerModels()` paginated catalog | `shared-client.js`, `protocol-validators.js`, `protocol.js` |
| `extensions/codex/src/app-server/client.ts` | `CodexAppServerClient` JSON-RPC transport | `agent-harness-runtime` (`embeddedAgentLog`, `OPENCLAW_VERSION`), `config.js`, `protocol.js`, `transport-stdio.js`, `transport-websocket.js`, `transport.js`, `version.js` |
| `extensions/codex/src/app-server/shared-client.ts` | Singleton client management, auth bootstrap, process lifecycle | `agent-runtime`, `auth-bridge.js`, `client.js`, `config.js`, `managed-binary.js`, `timeout.js` |
| `extensions/codex/src/app-server/auth-bridge.ts` | Auth profile resolution, OAuth/API-key bridging | `agent-runtime` (6+ symbols) |
| `extensions/codex/src/app-server/session-binding.ts` | Thread binding store, identity, generation tracking | `agent-harness-runtime` (`embeddedAgentLog`), `agent-runtime` (6+ symbols), `plugin-state-runtime`, `session-store-runtime`, `config-contracts`, zod |
| `extensions/codex/src/app-server/session-binding-store.ts` | Lazy store facade | `plugin-state-runtime` |
| `extensions/codex/src/app-server/session-binding-meta.ts` | Namespace/max-entries constants | None |
| `extensions/codex/src/app-server/transport-stdio.ts` | Stdio child process transport | `windows-spawn`, `config.js`, `transport.js` |
| `extensions/codex/src/app-server/transport-websocket.ts` | WebSocket transport | `ws` |
| `extensions/codex/src/app-server/transport.ts` | Transport abstraction | Types only |
| `extensions/codex/src/app-server/managed-binary.ts` | `@openai/codex` binary resolution | `version.js` |
| `extensions/codex/src/app-server/version.ts` | `MIN_CODEX_APP_SERVER_VERSION`, `MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION` | None |
| `extensions/codex/src/app-server/timeout.ts` | `withTimeout` wrapper | `security-runtime` |
| `extensions/codex/src/app-server/protocol.ts` | RPC types, JSON-RPC message shapes | Types only |
| `extensions/codex/src/app-server/protocol-validators.ts` | AJV validators for protocol messages | **`typebox`** (mandatory new dep), `protocol-generated/json/*.json` |
| `extensions/codex/src/app-server/protocol-generated/` | Generated JSON schemas directory | N/A |
| `extensions/codex/src/app-server/request.ts` | Typed JSON-RPC request helper | Types only |
| `extensions/codex/src/app-server/rate-limits.ts` | Rate limit snapshot building | `protocol.js`, `provider-usage`, `number-runtime`, `string-coerce-runtime` |

#### B. Runtime-mandatory on first turn (loaded via dynamic import from harness.ts)

These files are loaded lazily when the harness is first invoked. Their transitive imports must compile.

| File | Purpose | Key static imports |
|---|---|---|
| `extensions/codex/src/app-server/run-attempt.ts` | `runCodexAppServerAttempt()`: 30+ static imports including `agent-harness-runtime` barrel (30+ symbols), approval-bridge, auth-bridge, auth-binding, binding-connection, client, client-runtime, config, context-engine-projection, dynamic-tools, elicitation-bridge, event-projector, image-payload-sanitizer, native-subagent-monitor, plugin-thread-config, profiler-flag, provider-capabilities, rate-limit-cache, rate-limits, sandbox-exec-server, sandbox-guard, session-binding, thread-lifecycle, trajectory, vision-tools, web-search, user-input-bridge, attempt-steering, attempt-notifications, startup-binding |
| `extensions/codex/src/app-server/side-question.ts` | `runCodexAppServerSideQuestion()`: ~25 static imports including same `agent-harness-runtime` symbols, app-server-policy, approval-bridge, auth-bridge, client, client-runtime, config, dynamic-tools, elicitation-bridge, event-projector, provider-capabilities, rate-limit-cache, rate-limits, sandbox-guard, session-binding, vision-tools, web-search |
| `extensions/codex/src/app-server/compact.ts` | `maybeCompactCodexAppServerSession()`: `agent-harness-runtime` symbols, attempt-notifications, binding-connection, client, notification-correlation, protocol, sandbox-guard, session-binding, shared-client |
| `extensions/codex/src/app-server/auth-binding.ts` | Auth fingerprint | Types |
| `extensions/codex/src/app-server/runtime-artifact.ts` | Runtime artifact validation | Types |
| `extensions/codex/src/app-server/binding-connection.ts` | App-server connection resolution | `client-runtime.js`, `shared-client.js`, `session-binding.js`, `session-binding-store.js`, `config.js`, `models.js` |
| `extensions/codex/src/app-server/client-runtime.ts` | Client runtime init | `shared-client.js`, `config.js` |
| `extensions/codex/src/app-server/app-server-policy.ts` | Model provider policy | `config.js`, `models.js` |
| `extensions/codex/src/app-server/plugin-thread-config.ts` | Thread config | `config.js`, `protocol.js` |
| `extensions/codex/src/app-server/plugin-app-cache-key.ts` | Cache key | Types |
| `extensions/codex/src/app-server/thread-lifecycle.ts` | Thread lifecycle | `binding-connection.js`, `client.js`, `session-binding.js`, `session-binding-store.js` |
| `extensions/codex/src/app-server/attempt-notifications.ts` | Notification reading | `client.js`, `notification-correlation.js`, `protocol.js` |
| `extensions/codex/src/app-server/notification-correlation.ts` | Notification correlation | Types |
| `extensions/codex/src/app-server/attempt-steering.ts` | Steering queue | Types |
| `extensions/codex/src/app-server/startup-binding.ts` | Startup binding rotation | `session-binding.js`, `session-binding-store.js`, `config.js`, `auth-bridge.js` |
| `extensions/codex/src/app-server/sandbox-guard.ts` | Sandbox execution block | `config.js`, `protocol.js` |
| `extensions/codex/src/app-server/sandbox-exec-server.ts` | Sandbox exec server | `config.js`, `transport-stdio.js`, `managed-binary.js` |
| `extensions/codex/src/app-server/provider-capabilities.ts` | Provider web search support | Types |
| `extensions/codex/src/app-server/rate-limit-cache.ts` | Rate limit caching | `rate-limits.js`, `session-binding.js` |
| `extensions/codex/src/app-server/profiler-flag.ts` | Profiler flag | None |
| `extensions/codex/src/app-server/computer-use-cache.ts` | Computer use cache | Types |
| `extensions/codex/src/app-server/dynamic-tools.ts` | Dynamic tool bridge | `config.js`, `protocol.js` |
| `extensions/codex/src/app-server/elicitation-bridge.ts` | MCP elicitation | `config.js`, `protocol.js` |
| `extensions/codex/src/app-server/event-projector.ts` | Lifecycle projector | `session-binding.js`, `session-binding-store.js` |
| `extensions/codex/src/app-server/vision-tools.ts` | Vision tool filter | Types |
| `extensions/codex/src/app-server/image-payload-sanitizer.ts` | Image sanitization | Types |
| `extensions/codex/src/app-server/trajectory.ts` | Trajectory recording | `session-binding.js`, `session-binding-store.js` |
| `extensions/codex/src/app-server/native-subagent-monitor.ts` | Subagent monitor | Types |
| `extensions/codex/src/app-server/user-input-bridge.ts` | User input bridge | Types |
| `extensions/codex/src/app-server/web-search.ts` | Web search plan | Types |
| `extensions/codex/src/app-server/capabilities.ts` | Control method constants | None |
| `extensions/codex/src/app-server/context-engine-projection.ts` | Context engine projection | `agent-harness-runtime` symbols |
| `extensions/codex/src/app-server/bounded-turn.ts` | Bounded turn helper | Types |

#### C. Mandatory only if copying upstream index.ts as-is (not trimmed)

These are registered in the full upstream `index.ts` but omitted from a trimmed provider+harness entry:

| File | Purpose | Registration method |
|---|---|---|
| `extensions/codex/cli-metadata.ts` | `/codex` CLI descriptor | `registerCodexCliMetadata(api)` |
| `extensions/codex/media-understanding-provider.ts` | Image description through Codex | `api.registerMediaUnderstandingProvider(...)` |
| `extensions/codex/web-search-provider.ts` | Web search through Codex | `api.registerWebSearchProvider(...)` |
| `extensions/codex/src/migration/provider.ts` + `apply.ts` + `plan.ts` + `source.ts` | Migration provider | `api.registerMigrationProvider(...)` — **deferred to Phase 6** |
| `extensions/codex/src/commands.ts` | `/codex` CLI command | `api.registerCommand(...)` |
| `extensions/codex/src/node-cli-sessions.ts` | CLI session browsing | `api.registerNodeHostCommand(...)` |
| `extensions/codex/src/session-catalog.ts` | Session catalog | `api.registerSessionCatalog(...)` |
| `extensions/codex/src/conversation-binding.ts` | Inbound claim handling | `api.registerHook(...)` |
| `extensions/codex/src/native-thread-tool.ts` | `codex_threads` tool | `api.registerTool(...)` |
| `extensions/codex/src/supervision-tools.ts` | Supervision compatibility tools | `api.registerTool(...)` |
| `extensions/codex/src/web-search-provider.shared.ts` + `runtime.ts` | Web search runtime | `api.registerWebSearchProvider(...)` |
| `extensions/codex/src/session-cli.ts` | Session CLI commands | `api.registerCommand(...)` |
| `extensions/codex/src/command-plugins-management.ts` | Plugin management types | Types only |
| `extensions/codex/src/app-server/transcript-mirror.ts` | Transcript mirroring | `api.registerHook(...)` |
| `extensions/codex/src/app-server/plugin-inventory.ts` | Marketplace inventory | `api.registerService(...)` |

#### D. Deferred/Optional (not in minimum viable scope)

- `extensions/codex/src/app-server/computer-use.ts` — advanced feature
- `extensions/codex/src/app-server/rate-limits.ts` — already counted in Tier 2A

### Agent-Harness-Runtime Symbols Consumed by Mandatory Codex Code

The `openclaw/plugin-sdk/agent-harness-runtime` barrel exports a broad runtime surface. Only the following are consumed by mandatory Codex extension files. Unrelated barrel exports (session catalog, operator CLI, media, migration, tools, etc.) are NOT counted.

**Consumed by `harness.ts` (type imports only):**
- `AgentHarness`, `AgentHarnessCompactParams`, `AgentHarnessCompactResult`, `ContextEngineHostCapability`

**Consumed by `run-attempt.ts` (30+ symbols):**
- Types: `AgentHarnessRuntimeArtifactBinding`, `FastModeAutoProgressState`, `EmbeddedRunAttemptParams`, `EmbeddedRunAttemptResult`, `NativeHookRelayEvent`, `NativeHookRelayRegistrationHandle`
- Values: `assembleHarnessContextEngine`, `assertContextEngineHostSupport`, `bootstrapHarnessContextEngine`, `buildHarnessContextEngineRuntimeContext`, `buildHarnessContextEngineRuntimeContextFromUsage`, `CODEX_APP_SERVER_CONTEXT_ENGINE_HOST`, `clearActiveEmbeddedRun`, `embeddedAgentLog`, `emitAgentEvent`, `finalizeHarnessContextEngineTurn`, `FAST_MODE_AUTO_PROGRESS_KIND`, `formatFastModeAutoProgressText`, `formatErrorMessage`, `getAgentHarnessHookRunner`, `getBeforeToolCallPolicyDiagnosticState`, `isHostScopedAgentToolActive`, `isActiveHarnessContextEngine`, `loadCodexBundleMcpThreadConfig`, `resolveAgentHarnessBeforePromptBuildResult`, `resolveAgentRunAbortLifecycleFields`, `resolveContextEngineOwnerPluginId`, `resolveSandboxContext`, `resolveSessionAgentIds`, `resolveUserPath`, `awaitAgentEndSideEffects`, `runAgentEndSideEffects`, `runAgentHarnessLlmInputHook`, `runAgentHarnessLlmOutputHook`, `runHarnessContextEngineMaintenance`, `resolveFastModeForElapsed`, `setActiveEmbeddedRun`, `supportsModelTools`, `runAgentCleanupStep`

**Consumed by `side-question.ts` (10 values + 6 types):**
- Values: `buildAgentHookContextChannelFields`, `embeddedAgentLog`, `formatErrorMessage`, `resolveAgentDir`, `resolveAttemptSpawnWorkspaceDir`, `resolveModelAuthMode`, `resolveSandboxContext`, `resolveSessionAgentIds`, `registerNativeHookRelay`, `supportsModelTools`
- Types: `AnyAgentTool`, `AgentHarnessSideQuestionParams`, `AgentHarnessSideQuestionResult`, `EmbeddedRunAttemptParams`, `NativeHookRelayEvent`, `NativeHookRelayRegistrationHandle`

**Consumed by `compact.ts` (2 values + 2 types):**
- Values: `embeddedAgentLog`, `resolveCompactionTimeoutMs`
- Types: `CompactEmbeddedAgentSessionParams`, `EmbeddedAgentCompactResult`

**Consumed by `session-binding.ts` (~2 symbols):**
- `embeddedAgentLog`

**Consumed by `client.ts` (~2 symbols):**
- `embeddedAgentLog`, `OPENCLAW_VERSION`

**Total distinct symbols consumed by mandatory Codex code: ~55.** The remaining barrel exports (session catalog, operator CLI, media, migration, tools, supervision, etc.) are NOT consumed by mandatory files.

### OpenClawPluginApi Methods Required for Trimmed Basic Turns

For a trimmed entry that registers only provider + harness (no media, no web-search, no migration, no commands, no session catalog, no supervision, no thread tool):

| Method | Required? | Rationale |
|---|---|---|
| `registerProvider` | **Already exists** | Provider registration |
| `registerAgentHarness` | **NEW — must backport** | Harness registration. Wired through `src/plugins/registry-registrars.ts` → `src/plugins/registry-types.ts` (`PluginAgentHarnessRegistration`). Stored in registry state. Retrieved by `selectAgentHarness()` in core execution. |
| `registerMediaUnderstandingProvider` | No (trimmed entry omits) | Deferred |
| `registerWebSearchProvider` | No (trimmed entry omits) | Deferred |
| `registerMigrationProvider` | No (deferred to Phase 6) | Deferred |
| `registerTool` | No (trimmed entry omits) | Deferred |
| `registerCommand` | No (trimmed entry omits) | Deferred |
| `registerNodeHostCommand` | No (trimmed entry omits) | Deferred |
| `registerNodeInvokePolicy` | No (trimmed entry omits) | Deferred |
| `registerSessionCatalog` | No (trimmed entry omits) | Deferred |
| `registerCliMetadata` | No (trimmed entry omits) | Deferred |
| `registerToolMetadata` | No (trimmed entry omits) | Deferred |
| `registerHook` | No (trimmed entry omits) | Deferred |

**For trimmed basic turns: exactly 1 new `OpenClawPluginApi` method is required: `registerAgentHarness`.** All other missing methods (`registerCodexAppServerExtensionFactory`, `registerCompactionProvider`, `registerAgentToolResultMiddleware`, `registerMigrationProvider`) are NOT needed for the trimmed entry.

### External Runtime Dependencies

| Package | Upstream version | Local version | Status | Required for trimmed basic turns? |
|---|---|---|---|---|
| `@openai/codex` | `0.144.1` | **Not installed** | Must add | Yes — provides the JavaScript wrapper plus platform-resolved prebuilt executable package |
| `@openai/codex-linux-x64` | (platform) | **Not installed** | Must add for KASOU | Yes — platform executable for Debian/glibc |
| `smol-toml` | `1.7.0` | **Not installed** | Must add | Yes — imported by `config.ts` which is mandatory |
| `typebox` | `1.3.3` | **Not installed** | Must add | Yes — imported by `protocol-validators.ts` which is mandatory |
| `ws` | `8.21.0` | `^8.20.0` | Present | Yes — version range likely compatible, must verify |
| `zod` | `4.4.3` | `^4.3.6` | Present | Yes — version range likely compatible, must verify |
| `ajv` | (transitive) | Present | OK | Yes — protocol validators |

### Summary Counts

| Category | Count |
|---|---|
| Core harness subsystem files to backport (`src/agents/harness/*`) | ~25 production files (39 total including tests) |
| Extension files: mandatory for trimmed entry (Tier 2A) | ~25 files |
| Extension files: runtime-mandatory on first turn (Tier 2B) | ~30 files |
| Extension files: mandatory only with full upstream index.ts (Tier 2C) | ~15 files |
| `openclaw/plugin-sdk/*` seams to verify/modify | ~25 (20 present+OK, 5 absent/critical) |
| `agent-harness-runtime` symbols consumed by mandatory Codex code | ~55 |
| `OpenClawPluginApi` methods to add for trimmed basic turns | 1 (`registerAgentHarness`) |
| New `ModelApi` variants to add | 1 (`openai-chatgpt-responses`) |
| External deps to add | 4 (`@openai/codex` + platform, `smol-toml`, `typebox`) |
| Existing deps to verify version compat | 2 (`ws`, `zod`) |
| Optional/deferred subsystems | ~15 files |

### Mandatory Direct Dependencies for Trimmed Basic Turns (compile)

These are the minimum packages/modules that must resolve for the Codex plugin to compile and execute basic turns:

1. `@openai/codex` `0.144.1` + platform executable package (e.g., `@openai/codex-linux-x64`)
2. `smol-toml` `1.7.0` (new)
3. `typebox` `1.3.3` (new)
4. `ws` `^8.20.0` (existing, verify compat with `8.21.0`)
5. `zod` `^4.3.6` (existing, verify compat with `4.4.3`)
6. `ajv` (existing)
7. `openclaw/plugin-sdk/agent-harness-runtime` — entire barrel (~50+ exports, ~45 consumed)
8. `src/agents/harness/*` — entire subsystem (~25 production files; 39 total including tests)
9. `openclaw/plugin-sdk/agent-runtime` — existing, verify exports
10. `openclaw/plugin-sdk/diagnostic-runtime` — existing, verify exports
11. `ModelApi` union update — add `openai-chatgpt-responses` + transport implementation

### GO/STOP Recommendation

**STOP.**

The plan's STOP condition is triggered: the Codex harness requires changes to **core agent execution** that go far beyond additive plugin registration.

**Evidence (5 independent findings):**

1. **Entire harness subsystem absent locally.** `src/agents/harness/` does not exist in local 2026.4.6. Upstream has ~25 production files (39 total including tests) implementing `AgentHarness` type, registry, selection, lifecycle, policy, support, builtin-openclaw harness, result classification, context-engine lifecycle, compaction recovery, native hook relay, tool surface bridge, tool result middleware, user input bridge, hook context/helpers/history, and codex app-server extensions. This is not a thin stub — it is a complete rewrite of how agent turns are dispatched.

2. **Core execution path rewired.** Upstream `src/agents/embedded-agent-runner/run.ts` calls `selectAgentHarness()` from `src/agents/harness/selection.ts`. Local 2026.4.6 `src/agents/pi-embedded-runner/run/attempt.ts` has no such routing. The harness selection system introduces `AgentHarnessPolicy`, `resolveAgentHarnessPolicy`, `selectAgentHarness`, `selectAgentHarnessForPreparedModelProviders`, `agentHarnessBuildsOpenClawTools`, `agentHarnessExposesOpenClawTools`, and tool-policy wrappers — none of which exist locally. Two source references confirm no surgical hook is possible: (1) `src/agents/embedded-agent-runner/run.ts` line `let agentHarness = selectAgentHarness({...})`, (2) `src/agents/harness/selection.ts` exports the full selection/policy/support system.

3. **Transport API incompatibility.** Upstream `provider-catalog.ts` emits `api: "openai-chatgpt-responses"`. Local `MODEL_APIS` does not include this variant, and `provider-transport-stream.ts` has no transport for it. This requires BOTH a `ModelApi` union/schema update AND an actual transport implementation — not just an alias-by-name mapping.

4. **Missing `OpenClawPluginApi` method.** `registerAgentHarness` must be added to `OpenClawPluginApi` and wired through `src/plugins/registry-registrars.ts` → `src/plugins/registry-types.ts` (`PluginAgentHarnessRegistration`). The registry stores harnesses and `selectAgentHarness()` retrieves them.

5. **`@openai/codex` binary runtime.** The harness depends on `@openai/codex` `0.144.1` as a JavaScript wrapper plus platform-resolved prebuilt executable package. Binary compatibility with the KASOU Debian/glibc environment is unverified (requires OS/arch/glibc/libstdc++ checks, not N-API).

**Next action:** Conduct a bounded upstream host-baseline sync assessment to evaluate the cost of upgrading DennouAibou's host from 2026.4.6 to ≥2026.7.2.

## 16. Track B Implementation Plan: OAuth Request/Answer Only

### 16.1 Existing evidence

- `extensions/openai/openai-codex-provider.ts` already performs browser OAuth login, stores the `openai-codex` profile, and refreshes OAuth credentials.
- The provider normalizes compatible models to `api: "openai-codex-responses"` and `https://chatgpt.com/backend-api`.
- `src/agents/provider-transport-stream.ts` routes `openai-codex-responses` through the normal OpenAI Responses stream implementation.
- The existing OpenAI Responses transport converts supported image blocks to `input_image`, sends configured OpenClaw tools in the request, and projects returned `function_call` items back into the generic tool loop.
- Native Codex web search remains disabled unless `tools.web.search.openaiCodex.enabled` is explicitly `true`.

These facts mean plain request/answer turns do not require the upstream Agent Harness or Codex app-server.

### 16.2 Scope

Track B may change only the existing OpenAI provider package and its focused tests unless a missing generic contract is proven first.

Included:

- provider-local model-ID recognition;
- conservative forward-compatible model definitions;
- existing OAuth login and refresh behavior;
- existing `openai-codex-responses` transport;
- ordinary text and supported image request/response streaming through the generic inference loop;
- image input only when the upstream model metadata and local transport already support it.
- existing OpenClaw common-tool calling through the generic Responses tool loop when those tools are enabled for the agent.

Excluded:

- `extensions/codex/`;
- `openai-chatgpt-responses`;
- Agent Harness or core dispatch changes;
- Codex app-server binaries, threads, supervision, commands, migration, tools, media, or web-search providers;
- dependency additions;
- default-model or fallback changes;
- KASOU deployment before final approval.

OpenClaw's generic agent tools remain available under their existing configuration and approval rules. Track B adds no Codex-provider-specific tools.

### 16.3 Phase B0: Pin and classify upstream model changes

1. Pin the current upstream OpenClaw commit SHA used to compare `extensions/openai/`.
2. Compare upstream model IDs and metadata against the existing `openai-codex` resolver.
3. For every candidate, record:
   - exact upstream model ID;
   - input capabilities;
   - context and output limits;
   - reasoning support;
   - transport/API assumptions;
   - whether the account must advertise or merely accept the model.
4. Classify each candidate as already supported, safe configured-only backport, blocked by another transport, or deferred.

Exit gate: no implementation until the candidate list contains no invented IDs, guessed entitlement, or missing metadata.

#### Approved Track B candidate limits

Track B uses each model's verified maximum native context, not OpenClaw's conservative runtime default. To make that maximum available to prompt assembly, both `contextWindow` and `contextTokens` use the approved maximum unless a live provider response proves a lower account-specific limit.

| Model ID | Input | `contextWindow` | `contextTokens` | `maxTokens` |
|---|---|---:|---:|---:|
| `gpt-5.5` | text, image | 400,000 | 400,000 | 128,000 |
| `gpt-5.5-pro` | text, image | 1,050,000 | 1,050,000 | 128,000 |
| `gpt-5.6-sol` | text, image | 1,050,000 | 1,050,000 | 128,000 |
| `gpt-5.6-terra` | text, image | 1,050,000 | 1,050,000 | 128,000 |
| `gpt-5.6-luna` | text, image | 1,050,000 | 1,050,000 | 128,000 |

The short `gpt-5.6` alias is not a Track B ChatGPT OAuth candidate because upstream classifies it as Platform-only. Track B uses the explicit Sol, Terra, or Luna ID and never silently substitutes one variant for another.

For maximum-context values, canonical OpenAI model documentation takes precedence over conservative OpenClaw runtime defaults. The table was checked against the canonical OpenAI model pages on 2026-07-13, including `developers.openai.com/api/docs/models/gpt-5.5-pro` and `developers.openai.com/api/docs/models/gpt-5.6-luna`. The implementation report must record the exact OpenAI source and inspection date used for every limit.

### 16.4 Phase B1: Configured-only forward compatibility

For safe candidates:

1. Extend `resolveCodexForwardCompatModel()` using existing provider-local helpers.
2. Preserve the requested model ID in the emitted model definition.
3. Keep `api: "openai-codex-responses"`, provider `openai-codex`, and the existing ChatGPT backend URL.
4. Preserve the approved maximum-context table above. Clone an existing local template only for transport-compatible fields that are not model limits, and keep the model configured-only.
5. Do not add the candidate to `augmentModelCatalog()` yet.

Exit gate: focused tests prove the new ID reaches the existing transport without changing OAuth profiles, defaults, fallbacks, or unrelated providers.

### 16.5 Phase B2: Request/answer contract verification

Tests must prove:

- OAuth login and refresh output still use provider `openai-codex`;
- model normalization still selects `openai-codex-responses` and the ChatGPT backend URL;
- the request uses the ordinary Responses payload path;
- a streamed final text response is returned;
- a model marked with image input converts one representative image to `input_image`, while a text-only model does not claim image support;
- one harmless configured OpenClaw tool completes the existing `function_call` → tool result → final response round trip;
- no app-server, session-supervision, migration, or native Codex command is invoked;
- provider-native web search remains disabled by default;
- unknown or unavailable models return a visible provider error instead of silently changing model family.

Required gates: focused provider/transport tests, `git diff --check`, build, and code-reviewer APPROVED.

### 16.6 Phase B3: Optional live OAuth verification

Live verification requires explicit user approval and a non-production test window.

1. Select one configured-only candidate.
2. Send one minimal text request using the existing OAuth profile.
3. When the candidate metadata includes image input, send one small image-understanding request.
4. Run one harmless existing OpenClaw tool call under the normal tool approval policy.
5. Confirm the requested model ID, response text, finish state, tool round trip, and token/usage fields in logs.
6. Confirm no app-server process, native Codex session, or provider-specific tool was started.

Failure leaves the candidate configured-only or removes it with a file-scoped revert. It does not trigger a fallback to guessed model aliases.

### 16.7 Phase B4: Optional catalog exposure

Only after Phase B3 succeeds may a candidate be added to `augmentModelCatalog()`. Catalog exposure requires:

- successful live account access;
- verified model metadata;
- focused catalog tests;
- explicit user approval.

Account entitlement can change. A catalog entry describes known compatibility, not guaranteed access for every account.

### 16.8 Rollback and acceptance

Rollback is file-scoped: remove the new forward-compat entries and their tests while leaving existing OAuth credentials and supported models untouched.

Track B is accepted only when:

- existing Codex OAuth models still pass regression tests;
- new candidates preserve their exact requested IDs;
- text, supported image input, and generic tool-call streaming work through `openai-codex-responses`;
- no extra Codex runtime surface is introduced;
- code-reviewer returns APPROVED;
- no KASOU or default-model change occurs without explicit user approval.

### 16.9 Implementation status — 2026-07-13

Track B configured-only forward compatibility is implemented in the existing
OpenAI provider:

- `extensions/openai/openai-codex-provider.ts`
- `extensions/openai/openai-codex-provider.test.ts`

Implemented IDs:

- `gpt-5.5`: text + image, 400,000 context, 128,000 max output;
- `gpt-5.5-pro`: text + image, 1,050,000 context, 128,000 max output;
- `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`: text + image, 1,050,000
  context, 128,000 max output.

The implementation preserves the exact requested ID, `openai-codex` provider,
`openai-codex-responses` API, and ChatGPT backend URL. The short `gpt-5.6`
alias remains unsupported. `gpt-5.3-codex-spark` remains text-only. New IDs
are not exposed through `augmentModelCatalog()` yet.

The existing `gpt-5.4` default now also uses `contextTokens: 1,050,000`,
matching its `contextWindow` maximum when no explicit config override exists.
`gpt-5.4-mini` remains at 272,000 and `gpt-5.3-codex-spark` remains at
128,000.

Verification completed:

- focused Codex provider tests: 18/18 passed;
- focused OpenAI provider regression tests: 28/28 passed after the GPT-5.4
  default-context update;
- existing OpenAI Responses transport/provider code and tests were inspected
  for the relevant image and generic function-call paths; no core transport
  changes were needed. The broader project test wrapper also exercised
  unrelated agent suites and timed out with pre-existing failures, so it is
  not recorded as a clean full-suite pass;
- `git diff --check`: passed;
- build-equivalent pipeline: passed using the existing Git Bash A2UI workaround;
- final implementation review: APPROVED.

Not done: live OAuth verification, catalog exposure, commit/push, and KASOU
deployment. The next authorized step is one live request/answer test per
candidate, including a supported image and one harmless generic OpenClaw tool
call, before catalog exposure.

# Handover: DI conversion of the Bun hoisted-failure ledger (batch ending 2026-09-19)

Commit: `e14d396d02` — "FIX: inject runtime/env/channel dependencies for 7 hoisted ledger tests"
Ledger state after this batch: `test/bun-tier-hoisted-known-failing.txt` = **113 entries** (was 120).

Requested scope was 10 entries; **7 were completed**. The remaining 3 were not
started because the safe candidates left are heavier or need non-DI decisions.
Nothing was pushed, KASOU/SSH/Gateway were not touched, `.session-restore/` is unchanged,
and the uncommitted WIP (`src/config/validation.channel-metadata.test.ts`,
`src/config/validation.ts`, `.pi/subagents.json`) was left untouched.

## Completed (all pass on BOTH runners: 50 tests, 0 failures)

| File | Production seam |
| --- | --- |
| `src/infra/outbound/format.test.ts` | `OutboundFormatDeps.getChannelPlugin` in `src/infra/outbound/format.ts` |
| `src/agents/pi-tools.read.workspace-root-guard.test.ts` | `WrapToolWorkspaceRootGuardDeps.assertSandboxPath` in `src/agents/pi-tools.read.ts` |
| `src/auto-reply/reply/session-updates.lifecycle.test.ts` | `SessionUpdatesDeps.getGlobalHookRunner` in `src/auto-reply/reply/session-updates.ts` |
| `src/commands/doctor-security.test.ts` | `DoctorSecurityDeps` (`note`, `listChannelPlugins`, `loadExecApprovals`) |
| `src/gateway/server-session-key.test.ts` | `ResolveSessionKeyForRunDeps` (`loadConfig`, `loadCombinedSessionStoreForGateway`) |
| `src/gateway/sessions-resolve.test.ts` | `SessionsResolveDeps` (session store + gateway session helpers) |
| `src/gateway/server-methods/config.test.ts` | `setConfigOpenFileRunnerForTests` seam for `config.openFile` |

Verification commands used per file (and for the whole set):

```bash
bun test --isolate --pass-with-no-tests --timeout 60000 <files>
pnpm exec vitest run --config vitest.config.ts <files>
pnpm exec tsgo --noEmit            # only the pre-existing WIP error remains
pnpm exec oxfmt --check <changed files>
```

## Findings the next batch must know

1. **The ledger is Bun-measured, not Bun-only.** At least two entries also fail on
   Vitest for reasons unrelated to module mocking:
   - `src/infra/exec-approvals-store.test.ts`: expectations still use the pre-rebrand
     `<home>/.openclaw/exec-approvals.json`, while `resolveExecApprovalsPath()` resolves
     `<state dir>/.dennou-aibou/exec-approvals.json`. Fixing it needs the socket seam
     (`vi.mock("./jsonl-socket.js")`) **plus** corrected path expectations.
   - `src/commands/doctor/shared/allowlist-policy-repair.test.ts`: matrix
     `dmAllowFromMode` is `topOrNested` in this fork, so the test's "nested path"
     expectation is stale (`channels.matrix.allowFrom` is produced). Needs a
     `readChannelAllowFromStore` + env seam **and** a corrected expectation.
2. **Two entries assert real behaviour drift, not mockability**:
   - `src/infra/net/fetch-guard.ssrf.test.ts`: expects a pinned dispatcher when DNS
     pinning is disabled; the current `fetch-guard` no longer sets one.
   - `src/plugin-sdk/browser-maintenance.test.ts`: `src/plugin-sdk/browser-maintenance.ts`
     is now a debloat stub that throws `"browser extension removed"`, but the test still
     asserts delegation to the removed extension.
3. **Windows-hostile expectations exist in this ledger.** Two of the seven converted files
   only pass on Windows after making the expectation platform-correct (POSIX `file://`
   container remap is rejected as a Windows network path; `createConfigIO().configPath`
   resolves `/tmp/...` to `D:\tmp\...`). Expect the same pattern elsewhere — treat a
   Bun-Vitest mismatch and a Windows-posix mismatch as separate causes.
4. **Bun partially applies `vi.mock`.** The recurring signature is
   `Export named 'X' not found in module '...'` or a hang at import time
   (`bun test` exits 124 without output), because the replaced module loses exports that
   transitive importers need. Examples: `src/infra/outbound/channel-resolution.test.ts`
   (`getActivePluginChannelRegistry` from `src/plugins/runtime.ts`) and
   `src/infra/outbound/message.test.ts` (`resolveAgentConfig` from `src/agents/agent-scope.ts`).
   Both are otherwise good DI candidates but need 3+ seams each.
5. **Scoping commands.** `pnpm test <path>` runs the whole project (observed 269 files,
   ~2 min); use `pnpm exec vitest run --config vitest.config.ts <file>` for one-file runs.

## Remaining candidates, easiest first

1. `src/gateway/server-methods/config.test.ts` — DONE (kept here for reference).
2. `src/infra/outbound/channel-resolution.test.ts` (210 lines) — seams for
   `getChannelPlugin`, active-registry access, `applyPluginAutoEnable`,
   `resolveRuntimePluginRegistry`, `normalizeMessageChannel`/`isDeliverableMessageChannel`.
3. `src/infra/outbound/message.test.ts` (139 lines) — seams for channel-plugin lookup,
   `resolveOutboundTarget`, `deliverOutboundPayloads`.
4. `src/agents/models-config.write-serialization.test.ts` (91 lines) — seam for
   `planOpenClawModelsJson`; note the test also does `vi.spyOn(node:fs/promises, "writeFile")`,
   whose Bun support must be confirmed.
5. `src/infra/exec-approvals-store.test.ts` (421 lines) — see finding 1.
6. `src/commands/doctor/shared/allowlist-policy-repair.test.ts` (36 lines) — see finding 1.
7. `src/media-understanding/image.test.ts` (329 lines) — needs seams for `complete`,
   `ensureOpenClawModelsJson`, `model-auth` helpers and `pi-model-discovery-runtime`.
8. `src/infra/provider-usage.auth.normalizes-keys.test.ts` (650 lines) — env/fs-heavy DI.
9. resetModules family (`src/gateway/client.test.ts`, `src/gateway/gateway-misc.test.ts`,
   `src/gateway/server-methods/send.test.ts`, `src/commands/gateway-status.test.ts`,
   `src/commands/models/list.*`, `src/commands/onboard-non-interactive.*`,
   `src/media-understanding/apply*.test.ts`, `src/plugins/conversation-binding.test.ts`,
   `src/config/io.write-config.test.ts`) — each needs a seam that removes the need for a
   fresh module instance; several are 200-900 lines.
10. `src/agents/bash-tools.exec.pty-cleanup.test.ts` / `.pty-fallback-failure.test.ts` —
    mock `@lydell/node-pty` and `src/process/supervisor/index.js`; the seams would have to be
    threaded through transitive modules, not just `createExecTool`.

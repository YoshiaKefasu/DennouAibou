# Handover: bun-di-10l-fourth — COMPLETED

Batch resumed and finished on 2026-09-19.

## Result

- My commit: `9415783d9c` — "FIX: inject reply/registry/outbound dependencies for 8 hoisted ledger tests" (12 files).
- Two of my conversions were swept into another executor's commit `de27718ec9` (models-config.write-serialization, infra/outbound/channel-resolution) because they were sitting in the shared working tree.
- Combined 10 ledger entries removed; ledger is now 89 files (was 113 at batch start; co-executors removed 6 of their own entries alongside).
- No push performed. `.session-restore/` untouched. KASOU/SSH/Gateway untouched. `src/config/validation.channel-metadata.*` and `.pi/subagents.json` untouched.

## The 10 converted entries (all pass Bun + Vitest)

| Entry | Conversion style |
| --- | --- |
| src/agents/models-config.write-serialization.test.ts | `ensureOpenClawModelsJson` gains `deps.planOpenClawModelsJson` (in de27718ec9) |
| src/agents/subagent-registry.announce-loop-guard.test.ts | existing `registry.__testing.setDepsForTest` seam, static import |
| src/auto-reply/reply.block-streaming.test.ts | `getReplyFromConfig` gains `GetReplyDeps`; full (non-partial) mocks for agent-scope/model-selection |
| src/auto-reply/reply/commands-subagents/action-agents.test.ts | `handleSubagentsAgentsAction(ctx, deps)` seam |
| src/auto-reply/reply/commands-system-prompt.test.ts | `resolveCommandsSystemPromptBundle(params, deps)` seam |
| src/commands/models/list.list-command.forward-compat.test.ts | doMock→vi.mock + completed mocks; fixed leaked `process.exitCode` restore (`?? 0`) so Bun exits 0 |
| src/commands/models/list.status.test.ts | doMock→vi.mock, full config factory (Bun cannot resolve partial self-import) |
| src/gateway/gateway-misc.test.ts | removed redundant doMock/resetModules |
| src/infra/outbound/channel-resolution.test.ts | production deps seam (in de27718ec9); test passes unchanged |
| src/infra/outbound/message.test.ts | completed agent-scope/plugins-runtime mock exports |

Verification: 66 tests pass on both `bun test --isolate` and Vitest; Bun exit code 0 per file.

## Known residual

- `pnpm exec tsgo --noEmit` still reports one error in `src/config/validation.channel-metadata.test.ts` — pre-existing WIP owned by another executor (forbidden to touch). My batch contributes 0 tsgo errors.
- Dropped candidates (fail, reverted): subagent-registry.persistence.resume (SQLite EBUSY — task/task-flow store cleanup would be needed), subagent-spawn pair (real graph cycle spawn↔sessions-spawn-tool in Bun), subagent-registry.test (hangs), auto-reply/status.test (Bun pagination drift), io.write-config (Vitest pre-existing drift), echo-transcript/vision-skip (partial self-import hangs), gateway-status/send + onboard-non-interactive (hook hangs).
- `.pi/di-ledger-batch10-handover.md` and `.pi/subagents.json` were left as-is (other executor's).

Resume name (no longer needed): `bun-di-10l-fourth`.
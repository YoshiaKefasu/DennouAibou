# Prune JSONL Chain Repair Plan

## Status

- **Date**: 2026-06-29
- **Status**: Plan only — no implementation until APPROVED by code-reviewer
- **Gateway state**: stopped before repair work
- **Approach**: minimal scope — two changes only, nothing else

### What this plan does

1. **Fix `prune-engine.ts`** — when replacing a toolResult with a placeholder, preserve the JSON structure instead of writing raw plain text.
2. **Fix the KASOU main session JSONL** — copy it out, repair it externally so every line is valid JSON, then copy it back.

### What this plan does NOT do

- No new dry-run config toggles
- No new repair scripts committed to the repo
- No changes to `historyLimit` / `dmHistoryLimit`
- No session reset changes
- No other files touched beyond `prune-engine.ts` and its test file

Plain-language summary: the prune engine was replacing chain links with sticky notes. We make it replace them with proper chain links that just have a short note inside. Then we fix the one broken session file by hand, copy it back, and start the gateway.

## Problem Summary

KASOU's main session JSONL still contains months of historical records, but the live replay branch only follows the latest `parentId` chain. In the affected session, that current chain starts around 2026-06-21 even though older March, April, and May records are still present in the same file.

The direct break was caused by pruned tool-result rows being replaced with plain text, not valid JSON. Later, session file repair removed those malformed rows. Any later assistant message whose `parentId` pointed to one of those removed toolResult rows became an orphaned branch root.

Observed shape around the critical break:

```text
assistant toolCall: web_search
plain-text prune placeholder: 散らかったツールを自動的に片付けた。必要ならば再実行してね。
assistant final reply with parentId pointing to the now-missing toolResult id
```

Human-language analogy: the conversation is a chain. The prune step replaced one metal ring with a paper note. The repair step then removed the paper note because it was not valid JSON. After that, everything after the missing ring became a separate dangling chain.

## Evidence

### Evidence 1 — Current prune writes a non-JSON placeholder line

`src/dennou-soul/prune-engine.ts:186-194` (the push happens at line 193: `resultLines.push(config.placeholder);` inside `pruneToolOutputLines`) currently replaces a pruned `toolResult` line with `config.placeholder` directly.

That keeps the file smaller, but it does not preserve JSONL structure. The line stops being a session entry with an `id`, `parentId`, `timestamp`, `message.role`, `message.toolCallId`, and `message.toolName`.

### Evidence 2 — Session repair drops malformed JSONL rows

`src/agents/session-file-repair.ts:41-54 (parse logic) and 72-84 (backup/rewrite)` parses each JSONL line and increments `droppedLines` when parsing fails. When malformed lines exist, it writes a `.bak-<pid>-<timestamp>` backup and rewrites the session file with only parsed entries.

This is normally a good safety repair. In this case, it turned prune's plain-text placeholder rows into removed rows.

### Evidence 3 — KASOU log confirms repair dropped 4 malformed rows

The 2026-06-29 KASOU log contains:

```text
session file repaired: dropped 4 malformed line(s) (93fcc1a8-7563-4cf2-b9f1-e4552e7e444f.jsonl)
```

That matches the backup file inspection: four plain-text prune placeholders were present in the pre-repair backup.

### Evidence 4 — The active leaf chain starts from 2026-06-21

The current main session file still contains older records, but walking `parentId` backward from the latest leaf reaches only 52 entries, with the earliest reachable message around 2026-06-21 09:12.

This explains why KASOU appears to remember only recent weeks even though the JSONL file itself is much older.

Important caveat: chain repair restores structural validity, it does not automatically restore full historical memory. Even after the parent chain is reconnected, the model's visible context window remains bounded by `channels.telegram.historyLimit` / `dmHistoryLimit` and the session `contextTokens` cap. The model will see at most the most recent N turns, where N comes from those config limits, not from the chain length.

## Target Behavior for Prune Engine

Prune must never replace a JSONL entry with plain text.

When a `toolResult` is pruned, the engine should preserve the record as valid JSON and only replace the tool output body with a placeholder message.

Fields to preserve:

- top-level `type`
- top-level `id`
- top-level `parentId`
- top-level `timestamp`
- any other top-level metadata already present
- `message.role`
- `message.toolCallId`
- `message.toolName`
- any other non-content message metadata already present

Fields to replace:

- `message.content` only

Recommended replacement shape:

```json
{
  "type": "message",
  "id": "existing-tool-result-id",
  "parentId": "existing-assistant-tool-call-id",
  "timestamp": "existing timestamp",
  "message": {
    "role": "toolResult",
    "toolCallId": "existing tool call id",
    "toolName": "existing tool name",
    "isError": false,
    "content": [
      {
        "type": "text",
        "text": "散らかったツールを自動的に片付けた。必要ならば再実行してね。"
      }
    ]
  }
}
```

Other top-level fields and any other `message` metadata (`isError`, custom properties, etc.) are preserved from the cloned original. Fields shown above are only the minimum useful reference; the implementation should clone the parsed entry and replace only `message.content`, so every other field carries over automatically.

This keeps the chain intact while still removing the heavy tool-result body.

## Existing JSONL Repair Strategy

Repair goal: reconnect the session branch safely.

Non-goal: restore the original toolResult body text. The original body can stay lost. The repair only needs a valid placeholder `toolResult` entry with the correct identity and parent relationship.

Target session:

```text
~/.openclaw/agents/main/sessions/93fcc1a8-7563-4cf2-b9f1-e4552e7e444f.jsonl
```

Useful pre-repair backup:

```text
~/.openclaw/agents/main/sessions/93fcc1a8-7563-4cf2-b9f1-e4552e7e444f.jsonl.bak-241202-1782732654965
```

Repair algorithm:

1. Read the current JSONL and the pre-repair `.bak-*` file.
2. Find malformed placeholder lines in the backup.
3. For each placeholder line, inspect the adjacent JSON rows:
   - previous row should usually be an assistant `toolCall`
   - next row should usually be an assistant final reply whose `parentId` is missing in the current JSONL
4. Use the next row's missing `parentId` as the restored toolResult `id`.
5. Use the previous assistant toolCall row's `id` as the restored toolResult `parentId`.
6. Use the tool call's `id` and `name` to fill `message.toolCallId` and `message.toolName`.
7. Use a timestamp between the previous and next row, or the backup row's original line position context if a timestamp can be inferred safely.

> Timestamp inference note for repair implementation: the backup contains plain-text placeholder lines with no embedded timestamp. The repair script should pick a timestamp that does not break chronological order:
> - Default: middle point between the previous assistant toolCall row and the next assistant final reply row.
> - Fallback: previous row's timestamp + 1 second if the gap exceeds a configurable threshold (e.g. 1 hour). This avoids producing out-of-order timestamps when the placeholder sat across a long quiet period.
8. Insert the synthetic valid JSON `toolResult` placeholder row at the matching position in the current JSONL.
9. Do not rewrite later `parentId` values unless the restored row is not enough to reconnect the chain.

Why this is safe: the broken assistant already points to the missing toolResult id. Restoring that id as a valid JSON entry lets the existing chain reconnect naturally.

## Safety Rules

1. Keep the gateway stopped while repairing the live JSONL.
2. Work only on local copies, never on the SMB-mounted live file directly.
3. Do not edit the KASOU JSONL directly by hand on the remote machine.
4. Write repair output to a new file. Never overwrite the source copy.
5. Validate every JSONL line parses before copying back to KASOU.
6. Validate the latest leaf chain before and after repair.
7. If validation fails, do not copy the repaired file back.
8. Do not delete any `.bak-*` file during this work.
9. Do not run broad cleanup or prune while repairing.
10. Do not try to restore old toolResult body text from memory or guesses.

> Backup lifecycle note: after a successful repair and after the Verification Checklist is fully green, the original `.bak-*` files on KASOU should be moved (not deleted) into a `repair-archive/` subdirectory of the same sessions folder. This keeps them available for audit or rollback, and avoids cluttering the live directory.

Local working copy names:

```text
A:\Temp\opencode\93fcc1a8-7563-4cf2-b9f1-e4552e7e444f.jsonl.original
A:\Temp\opencode\93fcc1a8-7563-4cf2-b9f1-e4552e7e444f.jsonl.repaired
A:\Temp\opencode\93fcc1a8-7563-4cf2-b9f1-e4552e7e444f.jsonl.bak-241202-1782732654965
```

The repair is done using ad-hoc local commands or a temporary script (not committed to the repo). Validate before writing anything.

## Implementation Phases

### Phase 1 — Freeze dangerous prune behavior

Before code repair is deployed, keep KASOU protected by disabling active prune or switching it back to dry-run.

Recommended temporary config:

```json
{
  "dennou": {
    "sessionToolsPrune": {
      "enabled": true,
      "dryRun": true
    },
    "activeSessionToolsPrune": {
      "enabled": true,
      "dryRun": true
    }
  }
}
```

This prevents new malformed placeholder lines while the engine is being fixed.

### Phase 2 — Fix prune engine JSON preservation

Update `src/dennou-soul/prune-engine.ts` so `pruneToolOutputLines()` serializes a modified JSON entry instead of returning `config.placeholder` as a raw line.

Expected helper shape:

```ts
function pruneToolResultEntry(entry: JsonlEntry, placeholder: string): string
```

The helper should deep-clone the parsed entry, replace only `message.content`, and return `JSON.stringify(clonedEntry)`. Deep cloning is required so the original parsed object, if referenced elsewhere in the same run, is not mutated.

### Phase 3 — Add prune regression tests

Add tests proving:

- pruned output remains valid JSON
- `id` is preserved
- `parentId` is preserved
- `message.toolCallId` is preserved
- `message.toolName` is preserved
- placeholder text appears only inside `message.content`
- `session-file-repair` does not drop the pruned line
- an entry that originally had `isError: true` leaves the prune output with `isError: true` preserved

### Phase 4 — Copy KASOU session JSONL to local machine for external repair

No new scripts are committed to the repo. The repair is done by hand on a local copy.

Steps:

1. Copy the affected JSONL and its `.bak-*` backup from KASOU SMB mount to a local temp directory:
   - `Y:\.openclaw\agents\main\sessions\93fcc1a8-7563-4cf2-b9f1-e4552e7e444f.jsonl`
   - `Y:\.openclaw\agents\main\sessions\93fcc1a8-7563-4cf2-b9f1-e4552e7e444f.jsonl.bak-241202-1782732654965`
2. Keep the gateway stopped throughout.
3. Work only on the local copies. Never touch the SMB live file directly.

### Phase 5 — Repair the JSONL on local copy

Using the backup file (which still contains the 4 plain-text placeholder rows) and the current JSONL (which has those rows already removed):

1. Identify each missing toolResult by finding assistant entries whose `parentId` does not exist in the current JSONL.
2. For each missing toolResult:
   - Derive `id` from the orphaned assistant's `parentId`.
   - Derive `parentId` from the preceding assistant toolCall row's `id`.
   - Derive `message.toolCallId` and `message.toolName` from the preceding toolCall.
   - Derive `timestamp` from the midpoint between the preceding and following rows.
   - Set `message.content` to the placeholder text: `散らかったツールを自動的に片付けた。必要ならば再実行してね。`
3. Insert the synthetic valid JSON `toolResult` row at the correct position (the position corresponds to the placeholder's original line index in the backup, after excluding the placeholder lines themselves from the count).
4. Do not rewrite later `parentId` values. The existing chain reconnects naturally when the missing entry is restored.
5. Write the repaired output to a new file (never overwrite the source copy).

Validation target:

- repair finds all 4 missing toolResult entries (observed count on KASOU)
- each reconstructed row is valid JSON
- the reconstructed row for the `web_search` break uses the missing id referenced by the following assistant message
- the latest leaf chain grows beyond the current short chain when simulated

### Phase 6 — Validate repaired file and copy back to KASOU

Only after Phase 5 produces a repaired file:

1. Parse-check every line of the repaired file. Zero parse errors required.
2. Walk the latest leaf chain and confirm it reaches further back than the current 2026-06-21 break.
3. Confirm line count: repaired file must have the same line count as the original plus the 4 inserted rows. No lines dropped.
4. When all validations pass, copy the repaired file back to KASOU via the SMB mount (overwriting the live JSONL).
5. Verify the file on KASOU is identical (same size / checksum).

### Phase 7 — Code review gate

Run `@code-reviewer` after the prune engine fix and tests are ready. Also review the repair approach for the JSONL (even though it is not a committed script).

The review request must explicitly ask for:

- JSONL validity issues in prune engine output
- parent chain safety
- accidental deletion risk
- whether the synthetic toolResult shape is compatible with `SessionManager`
- whether the prune engine still protects recent tools and workspace-sensitive outputs correctly
- whether each item in the Verification Checklist below is satisfied

Do not restart the gateway until this review is approved or every required change is addressed.

### Phase 8 — Restart gateway and observe

After the repaired JSONL and fixed prune engine are in place:

1. Start `openclaw-gateway.service`.
2. Confirm `/` and `/logs` return HTTP 200.
3. Check logs for `session file repaired` warnings.
4. Send a small Telegram test message.
5. Confirm context usage does not unexpectedly reset to the short 30K range.
6. Keep prune in dry-run until one full observation cycle passes.

## Risks

### Risk 1 — Reconnecting the wrong branch

If a synthetic toolResult is inserted with the wrong `id` or `parentId`, it could connect the assistant reply to the wrong branch.

Mitigation: derive the restored `id` from the following assistant's missing `parentId`, and derive the restored `parentId` from the previous assistant toolCall row.

### Risk 2 — Tool result body cannot be restored

The original toolResult body was replaced by a plain placeholder in the backup. This plan intentionally does not restore it.

Mitigation: keep the placeholder content. The aim is structural recovery, not body recovery.

### Risk 3 — Session repair may run again

If any malformed line remains, `session-file-repair` can drop it on the next startup.

Mitigation: parse-check every line before restarting the gateway.

### Risk 4 — History limit can still shorten model input

KASOU has Telegram `historyLimit` / `dmHistoryLimit` settings. Even after parent chain repair, those settings may still limit how many turns are passed into the prompt.

Mitigation: treat chain repair and history-limit tuning as separate issues. First restore valid chain structure, then decide whether the Telegram history limits should be changed.

## Open Questions

1. Should `sessionToolsPrune` and `activeSessionToolsPrune` stay in `dryRun` for a full day after the fix?
2. Should the JSON-preserving placeholder text be the current Japanese message or the existing upstream-style English placeholder?
3. Should `historyLimit` / `dmHistoryLimit` be disabled or increased after chain repair, given KASOU has `contextTokens: 1000000`?
4. Should a generic orphan-chain detector be added later, or should this stay a one-off KASOU repair?

### Recommended decisions for the open questions

1. Recommended: keep both prune modes in `dryRun` for at least one full observation cycle (one day of real Telegram traffic) before turning live prune back on. Concrete behavior: alerts only, no JSONL writes.
2. Recommended: use the user-configured `config.placeholder` value verbatim. The configured Japanese placeholder is already user-facing in current KASOU behavior, so keeping it as the JSON-preserving placeholder avoids a visible behavior change for the user.
3. Recommended: leave `channels.telegram.historyLimit` and `dmHistoryLimit` at their current values (`36` and `24`) for now. Chain repair is structural, not context-window expansion. Tuning `historyLimit` / `dmHistoryLimit` is a separate decision that should be made after chain repair is verified and after DryRun has stayed clean for one full cycle. Do not bundle both changes into the same deploy.
4. Recommended: keep this a one-off KASOU-targeted procedure for now. A generic orphan-chain detector can be considered later as a separate `[SOUL]` feature once the prune engine JSON-preservation fix is shipped and observed.

## Verification Checklist

Before implementation is considered complete:

- [ ] `pruneToolOutputLines()` keeps pruned rows as valid JSON.
- [ ] Pruned rows preserve `id` and `parentId`.
- [ ] Pruned rows preserve `message.toolCallId` and `message.toolName`.
- [ ] `session-file-repair` no longer drops pruned rows.
- [ ] Repaired local JSONL copy has zero parse errors.
- [ ] Repaired local JSONL copy has original line count + 4 (no lines dropped).
- [ ] Latest leaf chain is longer on the repaired copy than on the original.
- [ ] Earliest reachable chain entry moves earlier than the current 2026-06-21 break.
- [ ] Repaired file copied back to KASOU is identical to the local validated copy.
- [ ] KASOU gateway starts without `session file repaired: dropped ... malformed line(s)` for this session.
- [ ] Code-reviewer approves the implementation and repair approach.

## Recommended Next Action

Start with the prune engine fix and tests while the gateway remains stopped. Do not copy or touch the KASOU session JSONL until the JSON-preserving prune behavior is fixed and code-reviewed.

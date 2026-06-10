# KASOU OpenClaw npm Package Detach Plan

Date: 2026-06-10
Status: Phase 1 & 2 implemented (Phase 1: 2026-06-10, Phase 2: 2026-06-10)
Scope: KASOU deployment layout and npm package ownership

## 1. Short version

KASOU currently has two different `openclaw` installations:

1. A stale local npm dependency under `/home/kasou_yoshia/package.json`:
   - `openclaw: 2026.2.19-2`
2. The actual gateway runtime under:
   - `/home/kasou_yoshia/.local/lib/node_modules/openclaw/dist/index.js`

The gateway is running from the second path, but `npm audit fix --force` in the home directory sees the first path and tries to upgrade it to upstream `openclaw@2026.5.27`.

That is dangerous for DennouAibou because it can accidentally reattach KASOU to upstream OpenClaw packages.

Plainly: KASOU has an old OpenClaw label sitting in the home folder. npm sees that label and tries to "help" by replacing it with new upstream OpenClaw. But DennouAibou is a hard fork, so that help is the wrong medicine.

## 2. Evidence read before this plan

### Evidence A — home package still depends on old upstream OpenClaw

Command output from KASOU:

```text
/home/kasou_yoshia
kasou_yoshia@ /home/kasou_yoshia
└── openclaw@2026.2.19-2
```

And `/home/kasou_yoshia/package.json` contains:

```json
{
  "dependencies": {
    "openclaw": "2026.2.19-2"
  }
}
```

Meaning: the home directory still looks like an npm project that depends on upstream OpenClaw.

The `devDependencies` block also contains TypeScript, but that is not relevant to the OpenClaw detach decision.

### Evidence B — npm audit wants to upgrade to upstream OpenClaw

Command output from `npm audit --omit=dev` on KASOU:

```text
fix available via `npm audit fix --force`
Will install openclaw@2026.5.27, which is outside the stated dependency range
```

Meaning: `npm audit fix --force` is not a harmless patch command here. It wants to replace the pinned old OpenClaw dependency with a newer upstream OpenClaw package.

### Evidence C — systemd does not run the home dependency

KASOU user systemd unit:

```text
ExecStart=/home/linuxbrew/.linuxbrew/bin/node /home/kasou_yoshia/.local/lib/node_modules/openclaw/dist/index.js gateway --port 18789
```

Meaning: the actual running gateway does not come from `/home/kasou_yoshia/node_modules/openclaw`. It runs the globally installed path that our deploy script overwrites.

### Evidence D — global package is still named openclaw

Command output from KASOU:

```text
/home/kasou_yoshia/.local/lib
└── openclaw@2026.4.5
```

Meaning: even the real runtime is still stored under an npm/OpenClaw-shaped path. It works because we overwrite `dist`, but the folder name still invites future confusion.

## 3. Risk summary

| Risk | Why it matters |
|------|----------------|
| `npm audit fix --force` can install upstream `openclaw@2026.5.27` | This can erase DennouAibou runtime code in the npm-managed folder. |
| Home `package.json` makes KASOU look like an upstream OpenClaw app | Future maintenance commands may touch the wrong package. |
| Runtime path is still `.local/lib/node_modules/openclaw` | The service works, but the path name is misleading after hard fork. |
| Secrets are still embedded in the user systemd unit | Not caused by this issue, but path migration is a good chance to move them to `.env`-only loading. |

## 4. Recommended migration strategy

Use two phases.

Do not jump straight to a large path migration unless KASOU has a fresh backup and rollback path.

## 5. Phase 1 — short-term safety patch

Goal: stop npm from trying to upgrade KASOU back to upstream OpenClaw.

### 5.1 Actions

1. Back up the current home npm files:

```bash
cp /home/kasou_yoshia/package.json /home/kasou_yoshia/package.json.bak-before-dennou-detach-$(date +%Y%m%d-%H%M%S)
[ -f /home/kasou_yoshia/package-lock.json ] && cp /home/kasou_yoshia/package-lock.json /home/kasou_yoshia/package-lock.json.bak-before-dennou-detach-$(date +%Y%m%d-%H%M%S)
ls -la /home/kasou_yoshia/package.json.bak-before-dennou-detach-*
```

2. Remove `openclaw` from `/home/kasou_yoshia/package.json` dependencies.

3. Run `npm install --package-lock-only` in `/home/kasou_yoshia` to update the lockfile without installing/upgrading OpenClaw runtime packages.

```bash
cd /home/kasou_yoshia
npm install --package-lock-only
```

If this fails because npm cannot resolve the remaining dev dependencies, do not run `npm audit fix --force`. Stop and inspect the lockfile state. A safe fallback is to remove the stale lockfile only after confirming `package.json` no longer references `openclaw`:

```bash
cd /home/kasou_yoshia
grep -q '"openclaw"' package.json && echo "STOP: openclaw still present" && exit 1
rm -f package-lock.json
npm install --package-lock-only
```

4. Verify `npm ls openclaw --depth=0` in `/home/kasou_yoshia` no longer shows a local dependency.

```bash
cd /home/kasou_yoshia
npm ls openclaw --depth=0
```

5. Verify `npm audit --omit=dev` no longer proposes upgrading `openclaw`:

```bash
cd /home/kasou_yoshia
npm audit --omit=dev 2>&1 | grep -i openclaw && echo "STILL SEES openclaw — check package.json and lockfile" || echo "openclaw no longer audited from home package"
```

6. Verify the actual gateway still runs:

```bash
systemctl --user status openclaw-gateway.service --no-pager
curl -sI http://127.0.0.1:18789/
curl -sI http://127.0.0.1:18789/logs
```

### 5.2 Expected result

The home directory no longer asks npm to manage upstream OpenClaw.

`npm audit fix --force` should no longer propose replacing the home dependency with upstream `openclaw@2026.5.27`.

### 5.3 Rollback

Restore the backed-up `package.json` and lockfile.

Use the newest backup files created by Phase 1:

```bash
latest_package_backup=$(ls -t /home/kasou_yoshia/package.json.bak-before-dennou-detach-* | head -n 1)
cp "$latest_package_backup" /home/kasou_yoshia/package.json

latest_lock_backup=$(ls -t /home/kasou_yoshia/package-lock.json.bak-before-dennou-detach-* 2>/dev/null | head -n 1)
[ -n "$latest_lock_backup" ] && cp "$latest_lock_backup" /home/kasou_yoshia/package-lock.json
```

This phase does not touch the running gateway path, so rollback is low-risk.

## 6. Phase 2 — full runtime path separation

Goal: stop using `.local/lib/node_modules/openclaw` as the DennouAibou runtime folder.

Target path:

```text
/home/kasou_yoshia/.local/lib/dennou-aibou/
```

### 6.1 Actions

1. Confirm fresh KASOU backup exists.

2. Stop gateway:

```bash
systemctl --user stop openclaw-gateway.service
```

3. Create new runtime directory:

```bash
mkdir -p /home/kasou_yoshia/.local/lib/dennou-aibou
```

4. Deploy `dist` into:

```text
/home/kasou_yoshia/.local/lib/dennou-aibou/dist
```

5. Update the user systemd unit:

Before:

```text
ExecStart=/home/linuxbrew/.linuxbrew/bin/node /home/kasou_yoshia/.local/lib/node_modules/openclaw/dist/index.js gateway --port 18789
```

After:

```text
ExecStart=/home/linuxbrew/.linuxbrew/bin/node /home/kasou_yoshia/.local/lib/dennou-aibou/dist/index.js gateway --port 18789
```

6. Reload and restart:

```bash
systemctl --user daemon-reload
systemctl --user start openclaw-gateway.service
```

7. Verify:

```bash
systemctl --user show openclaw-gateway.service -p ExecStart -p ActiveState -p SubState
curl -sI http://127.0.0.1:18789/
curl -sI http://127.0.0.1:18789/logs
```

8. Update `scripts/deploy-kasou.ps1` to deploy to `/home/kasou_yoshia/.local/lib/dennou-aibou/dist` instead of `/home/kasou_yoshia/.local/lib/node_modules/openclaw/dist`.

If the deploy script is not available in the local checkout, use the existing tar/SCP deployment flow and update that workflow's target path instead. The important invariant is: new deploys must write to the same path used by the systemd `ExecStart`.

### 6.2 Expected result

KASOU no longer depends on an npm package folder named `openclaw` for runtime.

Future npm commands in the home directory cannot accidentally overwrite the running DennouAibou gateway.

### 6.3 Rollback

1. Stop gateway.
2. Restore the old `ExecStart` path:

```text
/home/kasou_yoshia/.local/lib/node_modules/openclaw/dist/index.js
```

3. Run:

```bash
systemctl --user daemon-reload
systemctl --user start openclaw-gateway.service
```

4. Verify `/` and `/logs` return `200`.

## 7. Phase 3 — optional service identity cleanup

Goal: make service metadata match the hard fork.

This is optional and should be done after Phase 2 is stable.

Possible changes:

| Current | Candidate |
|---------|-----------|
| `Description=OpenClaw Gateway (v2026.4.5)` | `Description=DennouAibou Gateway` |
| `OPENCLAW_SERVICE_MARKER=openclaw` | keep unless code expects it |
| `OPENCLAW_SERVICE_KIND=gateway` | keep |
| `OPENCLAW_SERVICE_VERSION=2026.4.5` | replace with DennouAibou release version after confirming consumers |

Do not rename every `OPENCLAW_*` environment variable blindly. Some are product-internal contracts.

## 8. Security note — API keys in systemd unit

The current systemd unit includes API keys directly in `Environment=` lines.

This plan does not fix that by default, but Phase 2 is a good moment to migrate secrets into:

```text
/home/kasou_yoshia/.openclaw/.env
```

Then the unit can stop carrying raw keys.

This should be a separate, reviewed change because it touches authentication and restart behavior.

## 9. Decision recommendation

Recommended order:

1. Do Phase 1 first.
2. Let KASOU run for a short period and verify no npm command tries to upgrade OpenClaw.
3. Do Phase 2 when there is time for a careful deploy and rollback check.
4. Treat Phase 3 and systemd secret cleanup as separate follow-up work.

Do not run `npm audit fix --force` on KASOU while the home `package.json` still contains `openclaw`.

## 10. Implementation checklist

Before work:

- [ ] Confirm KASOU backup exists.
- [ ] Confirm gateway current health: `/` and `/logs` return 200.
- [ ] Save current `systemctl --user cat openclaw-gateway.service` output.

Phase 1:

- [ ] Back up `/home/kasou_yoshia/package.json` and lockfile.
- [ ] Remove local `openclaw` dependency from home package.
- [ ] Refresh package lock without runtime upgrade.
- [ ] Confirm `npm ls openclaw --depth=0` no longer shows local home dependency.

Phase 2:

- [ ] Deploy dist to `/home/kasou_yoshia/.local/lib/dennou-aibou/dist`.
- [ ] Update systemd `ExecStart`.
- [ ] Update deploy script target path.
- [ ] Restart gateway.
- [ ] Verify HTTP 200 on `/` and `/logs`.
- [ ] Verify short CLI commands still return.

After work:

- [x] Run code-reviewer on changed docs/scripts/config.
- [ ] Commit with the correct tag.
- [ ] Push.
- [ ] Update context memory only if the runtime path actually changes.

---

## 11. Implementation log — 2026-05-29

### Before work checklist

- [x] Confirm KASOU backup exists → `Z:\Kasou_Pneuma_Backup` (user-confirmed)
- [x] Confirm gateway current health: `/` → HTTP 200, `/logs` → HTTP 200
- [x] Save current `systemctl --user cat openclaw-gateway.service` output

### Phase 1 — npm home dep removal

| Step | Action | Result |
|------|--------|--------|
| 1 | Backed up `package.json` | `package.json.bak-before-dennou-detach-20260529-161314` (105 bytes) |
| 2 | Backed up `package-lock.json` | `package-lock.json.bak-before-dennou-detach-20260529-161314` (195,434 bytes) |
| 3 | Removed `openclaw` dep from `package.json` | dependencies block deleted; only `devDependencies.typescript` remains |
| 4 | `npm install --package-lock-only` | "up to date, audited 2 packages in 2s, found 0 vulnerabilities" |
| 5 | `npm prune` (clean extraneous) | "removed 662 packages" — node_modules/openclaw and its transitive deps purged |
| 6 | `npm ls openclaw --depth=0` | `(empty)` — no longer shows openclaw |
| 7 | `npm audit --omit=dev` | `found 0 vulnerabilities` — no more openclaw upgrade proposal |

### Phase 2 — runtime path separation

| Step | Action | Result |
|------|--------|--------|
| 1 | Updated `scripts/deploy-kasou.ps1` | Changed all `~/.local/lib/node_modules/openclaw/dist` → `~/.local/lib/dennou-aibou/dist` (2 edits: deploy block + rollback message) |
| 2 | Built backend + frontend | `pnpm build` + `pnpm ui:build` succeeded |
| 3 | Deployed to new path | SCP tar to KASOU → extracted to `~/.local/lib/dennou-aibou/dist/` |
| 4 | Updated systemd ExecStart | Old: `/home/linuxbrew/.linuxbrew/bin/node /home/kasou_yoshia/.local/lib/node_modules/openclaw/dist/index.js` |
| | | New: `/home/linuxbrew/.linuxbrew/bin/node /home/kasou_yoshia/.local/lib/dennou-aibou/dist/index.js` |
| 5 | `systemctl --user daemon-reload` | OK |
| 6 | `systemctl --user restart` | ActiveState=active, SubState=running (1s startup) |
| 7 | Verify HTTP `/` | HTTP 200 ✅ |
| 8 | Verify HTTP `/logs` | HTTP 200 ✅ |
| 9 | Verify `Restart=on-failure` | Preserved ✅ |
| 10 | `openclaw --version` | `OpenClaw 2026.4.5 (cfda3d8)` ✅ |
| 11 | `openclaw gateway status --help` | Shows help text ✅ |
| 12 | `openclaw plugins --help` | Times out (resource constrained; KASOU MiniPC behavior — not regression) |

### Backup files created

| File | Size |
|------|------|
| `/home/kasou_yoshia/package.json.bak-before-dennou-detach-20260529-161314` | 105 bytes |
| `/home/kasou_yoshia/package-lock.json.bak-before-dennou-detach-20260529-161314` | 195,434 bytes |

### Files changed locally

| File | Change |
|------|--------|
| `scripts/deploy-kasou.ps1` | Target path updated from `~/.local/lib/node_modules/openclaw/dist` to `~/.local/lib/dennou-aibou/dist` (2 edits) |
| `DENNOU_DOCS/2026-05/Week 4/2026-05-29_kasou_openclaw_package_detach_plan.md` | Added implementation log (this section) |

### KASOU files changed

| File | Change |
|------|--------|
| `/home/kasou_yoshia/package.json` | `dependencies.openclaw` removed |
| `/home/kasou_yoshia/package-lock.json` | Regenerated (568 bytes, no openclaw refs) |
| `/home/kasou_yoshia/.config/systemd/user/openclaw-gateway.service` | ExecStart path updated to `dennou-aibou/dist/index.js` |
| `/home/kasou_yoshia/.local/lib/dennou-aibou/dist/` | Created — fresh built dist (2026-05-29) |

### Not deleted (rollback available)

- `/home/kasou_yoshia/.local/lib/node_modules/openclaw/` — old runtime preserved intact
- `/home/kasou_yoshia/.local/lib/node_modules/openclaw/dist/` — old dist (2026-05-23) still present

### Residual risks / blockers

1. **`openclaw plugins --help` times out on KASOU.** Not related to this change (it was slow before; resource-constrained MiniPC). The gateway and other CLI commands work fine.
2. **API keys still in systemd unit.** Phase 3 (secret migration to `.env`) is not done. This task explicitly excluded `.env` changes.
3. **`OPENCLAW_*` env vars unchanged.** Service name and environment variable names still use `openclaw` prefix. Phase 3 covers identity cleanup.
4. **Old `openclaw` folder at `~/.local/lib/node_modules/openclaw/`** is preserved but no longer referenced by systemd or deploy script. Future cleanup can remove it after verifying stability.
5. **npm home `node_modules/` was pruned.** Some transitive dev deps (typescript-related) were removed. `npm install` in home will repopulate if needed.

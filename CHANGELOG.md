# Changelog

DennouAibou is a fork based on OpenClaw v2026.4.5.
For upstream history see https://github.com/openclaw/openclaw.

## dennou-v0.6.0 (2026-05-18)

### Upstream Patches (cherry-pick v2026.4.5 → v2026.4.8)

- **Heartbeat / session stability**
  - fix(agents): heartbeat always targets main session — prevent routing to active subagent sessions
  - fix(heartbeat): add subagent guard to resolveHeartbeatSession production code
  - fix: respect disabled heartbeat guidance — omit system prompt section when heartbeat is disabled
  - fix: tighten TUI phase handling and heartbeat session guards
- **SSE history race fixes**
  - fix(gateway): eliminate SSE history double-read race — derive sanitized and raw views from single snapshot
  - fix: seed SSE history state from one snapshot
  - fix(gateway): seq-based cursor pagination + sanitize SSE fast path
- **Logging, security, performance**
  - fix(logging): correct levelToMinLevel mapping for tslog v4
  - fix(agents): replace `.*` with `\S*` in interpreter heuristic to prevent ReDoS
  - fix: approval boundary bypass
  - fix: multiple dangerous build tool environment variables leak
- **Pi Embedded Runner**
  - fix: compaction after tool use abortion cause agent infinite loop calls
  - fix(agents): backfill missing sessionKey in embedded PI runner — prevent undefined key in model selection / live-switch

### DennouAibou-Specific Features

- **Event-loop health monitor (Liveness Watchdog)**
  - New `src/dennou-soul/liveness-watchdog.ts`
  - 5-minute setInterval self-monitoring via process.hrtime.bigint
  - Auto-recovery: systemctl --user restart on timer starvation detection
  - Dual-layer with KASOU cron watchdog (systemd timer, 5-min, log mtime check)
- **Heartbeat-runner watchdog backport**
  - Upstream PR #31226: remove `.unref()` + add setInterval watchdog
  - Watchdog-triggered heartbeats logged with `reason: "watchdog"` for distinguishability

### Session & Config

- Session reset `off` support — fully disables resetByType / resetByChannel
- DennouAibou config tab (Config → DennouAibou)
  - 3-layer prune settings: shared toolsPrune / closed-session sessionToolsPrune / active-session activeSessionToolsPrune
  - English help copy
- Build order enforcement: `pnpm build` → `pnpm ui:build`
- Schema generation fix: corrected import path in `scripts/generate-base-config-schema.ts`

### Prune

- Dry-run log flood suppression: file-level summary only, no per-line logs
- Fix doubled sessions directory path (sessions/sessions → sessions)
- Workspace-path protection hardening: raw JSONL text also checked

### Deployment

- `dennou-v0.5.1` GitHub Release (source tarball)
- KASOU deploy procedure established: stop → overlay dist → restart → HTTP health check
- A2UI prebuilt bundle fallback when sources unavailable

## dennou-v0.5.1 (2026-04-30)

### Upstream Backports

- **Log rotation fix** (`[FIX-UPSTREAM]`)
  - resolveActiveLogFile() ensures correct dated file rollover after midnight
  - Config reloads also create the correct date file
- **Discord stale-socket false positive fix** (`[FIX-UPSTREAM]`)
  - lastTransportActivityAt separates transport-level activity from app events
  - Carbon gateway: 60s isConnected polling lifecycle
  - Slack stale-socket test snapshot fix
  - readiness.test.ts: restored stale-socket → ready state transition tests

### DennouAibou-Specific Features

- **Config UI: DennouAibou settings tab**
  - Category tab under /config page
  - Settings: dennou.toolsPrune.*, dennou.sessionToolsPrune.*, dennou.activeSessionToolsPrune.*, dennou.pruneProtection.*
  - WebSocket runtime schema delivery

### Build & Deploy

- Pinned gitnexus@1.6.3 (avoid RC versions)
- Deployment checklist established: verify schema.dennou presence → check Control UI assets
- KASOU deploy procedure documented

## dennou-v0.4.30 (2026-04-30)

Base: OpenClaw v2026.4.5

### Initial DennouAibou Features

- **Session prune Dennou framework**
  - 3-layer prune config: toolsPrune (shared) / sessionToolsPrune (closed) / activeSessionToolsPrune (active)
  - minPrunableToolChars, keepLastTools, dryRun
  - Workspace path protection preserves conversation context
  - Active sessions: 30-min idle detection, keep last 10 tools
  - Closed sessions: dryRun mode (default)
- **Pi compaction customization**
  - Configurable timeout compaction threshold (`resolveTimeoutCompactionPromptUsageThreshold`)
  - reserveTokens respected
  - safeguard summary cap aligned with keepRecentTokens
- **[DEBLOAT]** Removed unused bundles
  - Bedrock, Swift
  - Unused plugin facade type shims
  - Test/doc alignment

### Project Infrastructure

- DENNOU_RULES.md established (commit tag taxonomy, deploy procedure, doc rules)
- DENNOU_DOCS/ archive started
- graphify + codesight indexing
- README cleanup

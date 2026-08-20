# Changelog

DennouAibou is a fork based on OpenClaw v2026.4.5.
For upstream history see https://github.com/openclaw/openclaw.

## Unreleased

### Provider Debloat [DEBLOAT]

- Removed 41 unused provider extensions (35 model providers + 6 sub-providers: TTS, web search, media generation, and LLM proxy). Only Google and OpenAI remain as model providers, with Deepgram/Brave/Exa kept for audio and web search.
- Removed the Ollama local-embedding path; memory search now uses the remaining built-in embedding backends.
- Cleaned up dead provider contract tests and updated the docs to match the kept provider set.

### Google Gemini Provider Sync

- Synced the bounded Google model-provider core from upstream commit `8a2da4b1bf1555fe0bfaf705eb57300c673c81be` without importing newer host, OAuth, or Plugin SDK architecture.
- Added forward-compatible recognition for `gemini-3.5-flash`, current Gemini 3 Flash families, official `*-latest` aliases, and Gemma 4 models.
- Aligned canonical IDs with current Google naming: `gemini-3.1-pro-preview`, `gemini-3.5-flash`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite`, and `gemma-4-26b-a4b-it` pass through unchanged.
- Preserved the Gemini CLI 3.1 mapping guard: persisted `gemini-3.1-flash-preview` requests select the 3.1 CLI template before current fallback templates.
- Kept Google REST normalization separate from Gemini CLI resolution; deprecated aliases normalize one-way to current canonical IDs without routing current IDs to another family.
- Split legacy compatibility templates from current 3/3.5/Gemma templates so new models do not inherit stale 3.1 metadata.
- Focused verification: 53 tests passed; build-equivalent pipeline passed; code-reviewer approved. Not deployed to KASOU.
- Existing OpenAI/Codex provider sync remains deferred because current upstream behavior requires `openai-chatgpt-responses` and newer Plugin SDK/Agent Harness seams.

### OpenAI Codex Provider

- Added configured-only Track B forward compatibility for `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` through the existing OpenAI Codex OAuth and `openai-codex-responses` path. Catalog exposure and live OAuth verification remain deferred.
- Raised the existing GPT-5.4 default `contextTokens` to its verified maximum of 1,050,000 when no explicit override is configured; GPT-5.4 Mini and GPT-5.3 Codex Spark defaults remain unchanged.

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
- **Session transcript stability**
  - fix(followup,reply): stop model-fallback retries duplicating session entries (Closes #83404)

### Upstream Features (selected)

- **Prompt override & heartbeat controls**
  - feat(agents): add agent-level prompt override for heartbeat instructions
  - feat(agents): add `heartbeat.every` agent-level config for per-agent heartbeat frequency
  - Config via `agents.defaults.heartbeat.prompt` in `openclaw.json`
- **Prompt-cache runtime context**
  - feat: expose prompt-cache runtime context to context engines
  - Current-turn prompt-cache usage aligned with active attempt instead of stale prior-turn state

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
  - Settings: dennou.toolsPrune._, dennou.sessionToolsPrune._, dennou.activeSessionToolsPrune._, dennou.pruneProtection._
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
- codesight indexing
- README cleanup

---
title: "Prompt Caching"
summary: "Prompt caching knobs, merge order, provider behavior, and tuning patterns"
read_when:
  - You want to reduce prompt token costs with cache retention
  - You need per-agent cache behavior in multi-agent setups
  - You are tuning heartbeat and cache-ttl pruning together
---

# Prompt caching

Prompt caching means the model provider can reuse unchanged prompt prefixes (usually system/developer instructions and other stable context) across turns instead of re-processing them every time. DennouAibou normalizes provider usage into `cacheRead` and `cacheWrite` where the upstream API exposes those counters directly.

Status surfaces can also recover cache counters from the most recent transcript
usage log when the live session snapshot is missing them, so `/status` can keep
showing a cache line after partial session metadata loss. Existing nonzero live
cache values still take precedence over transcript fallback values.

Why this matters: lower token cost, faster responses, and more predictable performance for long-running sessions. Without caching, repeated prompts pay the full prompt cost on every turn even when most input did not change.

This page covers all cache-related knobs that affect prompt reuse and token cost.

Provider references:

- OpenAI prompt caching: [https://developers.openai.com/api/docs/guides/prompt-caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- OpenAI API headers and request IDs: [https://developers.openai.com/api/reference/overview](https://developers.openai.com/api/reference/overview)

## Primary knobs

### `cacheRetention` (global default, model, and per-agent)

Set cache retention as a global default for all models:

```yaml
agents:
  defaults:
    params:
      cacheRetention: "long" # none | short | long
```

Override per-model:

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "short" # none | short | long
```

Per-agent override:

```yaml
agents:
  list:
    - id: "alerts"
      params:
        cacheRetention: "none"
```

Config merge order:

1. `agents.defaults.params` (global default — applies to all models)
2. `agents.defaults.models["provider/model"].params` (per-model override)
3. `agents.list[].params` (matching agent id; overrides by key)

### `contextPruning.mode: "cache-ttl"`

Prunes old tool-result context after cache TTL windows so post-idle requests do not re-cache oversized history.

```yaml
agents:
  defaults:
    contextPruning:
      mode: "cache-ttl"
      ttl: "1h"
```

See [Session Pruning](/concepts/session-pruning) for full behavior.

### Heartbeat keep-warm

Heartbeat can keep cache windows warm and reduce repeated cache writes after idle gaps.

```yaml
agents:
  defaults:
    heartbeat:
      every: "55m"
```

Per-agent heartbeat is supported at `agents.list[].heartbeat`.

## Provider behavior

### OpenAI (direct API)

- Prompt caching is automatic on supported recent models. DennouAibou does not need to inject block-level cache markers.
- DennouAibou uses `prompt_cache_key` to keep cache routing stable across turns and uses `prompt_cache_retention: "24h"` only when `cacheRetention: "long"` is selected on direct OpenAI hosts.
- OpenAI responses expose cached prompt tokens via `usage.prompt_tokens_details.cached_tokens` (or `input_tokens_details.cached_tokens` on Responses API events). DennouAibou maps that to `cacheRead`.
- OpenAI does not expose a separate cache-write token counter, so `cacheWrite` stays `0` on OpenAI paths even when the provider is warming a cache.
- OpenAI returns useful tracing and rate-limit headers such as `x-request-id`, `openai-processing-ms`, and `x-ratelimit-*`, but cache-hit accounting should come from the usage payload, not from headers.
- In practice, OpenAI often behaves like an initial-prefix cache rather than Anthropic-style moving full-history reuse. Stable long-prefix text turns can land near a `4864` cached-token plateau in current live probes, while tool-heavy or MCP-style transcripts often plateau near `4608` cached tokens even on exact repeats.

### Amazon Bedrock

- Anthropic Claude model refs (`amazon-bedrock/*anthropic.claude*`) support explicit `cacheRetention` pass-through.
- Non-Anthropic Bedrock models are forced to `cacheRetention: "none"` at runtime.

### Other providers

If the provider does not support this cache mode, `cacheRetention` has no effect.

### Google Gemini direct API

- Direct Gemini transport (`api: "google-generative-ai"`) reports cache hits
  through upstream `cachedContentTokenCount`; DennouAibou maps that to `cacheRead`.
- When `cacheRetention` is set on a direct Gemini model, DennouAibou automatically
  creates, reuses, and refreshes `cachedContents` resources for system prompts
  on Google AI Studio runs. This means you no longer need to pre-create a
  cached-content handle manually.
- You can still pass a pre-existing Gemini cached-content handle through as
  `params.cachedContent` (or legacy `params.cached_content`) on the configured
  model.
- This is separate from Anthropic/OpenAI prompt-prefix caching. For Gemini,
  DennouAibou manages a provider-native `cachedContents` resource rather than
  injecting cache markers into the request.

### Gemini CLI JSON usage

- Gemini CLI JSON output can also surface cache hits through `stats.cached`;
  DennouAibou maps that to `cacheRead`.
- If the CLI omits a direct `stats.input` value, DennouAibou derives input tokens
  from `stats.input_tokens - stats.cached`.
- This is usage normalization only. It does not mean DennouAibou is creating
  Anthropic/OpenAI-style prompt-cache markers for Gemini CLI.

## System-prompt cache boundary

DennouAibou splits the system prompt into a **stable prefix** and a **volatile
suffix** separated by an internal cache-prefix boundary. Content above the
boundary (tool definitions, skills metadata, workspace files, and other
relatively static context) is ordered so it stays byte-identical across turns.
Content below the boundary (for example `HEARTBEAT.md`, runtime timestamps, and
other per-turn metadata) is allowed to change without invalidating the cached
prefix.

Key design choices:

- Stable workspace project-context files are ordered before `HEARTBEAT.md` so
  heartbeat churn does not bust the stable prefix.
- The boundary is applied across Anthropic-family, OpenAI-family, Google, and
  CLI transport shaping so all supported providers benefit from the same prefix
  stability.
- Codex Responses requests are routed through boundary-aware cache shaping so
  cache reuse stays aligned with what providers actually receive.
- System-prompt fingerprints are normalized (whitespace, line endings,
  hook-added context, runtime capability ordering) so semantically unchanged
  prompts share KV/cache across turns.

If you see unexpected `cacheWrite` spikes after a config or workspace change,
check whether the change lands above or below the cache boundary. Moving
volatile content below the boundary (or stabilizing it) often resolves the
issue.

## DennouAibou cache-stability guards

DennouAibou also keeps several cache-sensitive payload shapes deterministic before
the request reaches the provider:

- Bundle MCP tool catalogs are sorted deterministically before tool
  registration, so `listTools()` order changes do not churn the tools block and
  bust prompt-cache prefixes.
- Legacy sessions with persisted image blocks keep the **3 most recent
  completed turns** intact; older already-processed image blocks may be
  replaced with a marker so image-heavy follow-ups do not keep re-sending large
  stale payloads.

## Tuning patterns

### Mixed traffic (recommended default)

Keep a long-lived baseline on your main agent, disable caching on bursty notifier agents:

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
  list:
    - id: "research"
      default: true
      heartbeat:
        every: "55m"
    - id: "alerts"
      params:
        cacheRetention: "none"
```

### Cost-first baseline

- Set baseline `cacheRetention: "short"`.
- Enable `contextPruning.mode: "cache-ttl"`.
- Keep heartbeat below your TTL only for agents that benefit from warm caches.

## Cache diagnostics

DennouAibou exposes dedicated cache-trace diagnostics for embedded agent runs.

For normal user-facing diagnostics, `/status` and other usage summaries can use
the latest transcript usage entry as a fallback source for `cacheRead` /
`cacheWrite` when the live session entry does not have those counters.

## Live regression tests

DennouAibou keeps one combined live cache regression gate for repeated prefixes, tool turns, image turns, MCP-style tool transcripts, and a no-cache control.

- `src/agents/live-cache-regression.live.test.ts`
- `src/agents/live-cache-regression-baseline.ts`

Run the narrow live gate with:

```sh
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CACHE_TEST=1 pnpm test:live:cache
```

The baseline file stores the most recent observed live numbers plus the provider-specific regression floors used by the test.
The runner also uses fresh per-run session IDs and prompt namespaces so previous cache state does not pollute the current regression sample.

These tests intentionally do not use identical success criteria across providers.

### OpenAI live expectations

- Expect `cacheRead` only. `cacheWrite` remains `0`.
- Treat repeated-turn cache reuse as a provider-specific plateau, not as Anthropic-style moving full-history reuse.
- Current live assertions use conservative floor checks derived from observed live behavior on `gpt-5.4-mini`:
  - stable prefix: `cacheRead >= 4608`, hit rate `>= 0.90`
  - tool transcript: `cacheRead >= 4096`, hit rate `>= 0.85`
  - image transcript: `cacheRead >= 3840`, hit rate `>= 0.82`
  - MCP-style transcript: `cacheRead >= 4096`, hit rate `>= 0.85`

Fresh combined live verification on 2026-04-04 landed at:

- stable prefix: `cacheRead=4864`, hit rate `0.966`
- tool transcript: `cacheRead=4608`, hit rate `0.896`
- image transcript: `cacheRead=4864`, hit rate `0.954`
- MCP-style transcript: `cacheRead=4608`, hit rate `0.891`

Recent local wall-clock time for the combined gate was about `88s`.

Why the assertions differ:

- Anthropic exposes explicit cache breakpoints and moving conversation-history reuse.
- OpenAI prompt caching is still exact-prefix sensitive, but the effective reusable prefix in live Responses traffic can plateau earlier than the full prompt.
- Because of that, comparing Anthropic and OpenAI by a single cross-provider percentage threshold creates false regressions.

### `diagnostics.cacheTrace` config

```yaml
diagnostics:
  cacheTrace:
    enabled: true
    filePath: "~/.openclaw/logs/cache-trace.jsonl" # optional
    includeMessages: false # default true
    includePrompt: false # default true
    includeSystem: false # default true
```

Defaults:

- `filePath`: `$OPENCLAW_STATE_DIR/logs/cache-trace.jsonl`
- `includeMessages`: `true`
- `includePrompt`: `true`
- `includeSystem`: `true`

### Env toggles (one-off debugging)

- `OPENCLAW_CACHE_TRACE=1` enables cache tracing.
- `OPENCLAW_CACHE_TRACE_FILE=/path/to/cache-trace.jsonl` overrides output path.
- `OPENCLAW_CACHE_TRACE_MESSAGES=0|1` toggles full message payload capture.
- `OPENCLAW_CACHE_TRACE_PROMPT=0|1` toggles prompt text capture.
- `OPENCLAW_CACHE_TRACE_SYSTEM=0|1` toggles system prompt capture.

### What to inspect

- Cache trace events are JSONL and include staged snapshots like `session:loaded`, `prompt:before`, `stream:context`, and `session:after`.
- Per-turn cache token impact is visible in normal usage surfaces via `cacheRead` and `cacheWrite` (for example `/usage full` and session usage summaries).
- For OpenAI, expect `cacheRead` on cache hits and `cacheWrite` to remain `0`; OpenAI does not publish a separate cache-write token field.
- If you need request tracing, log request IDs and rate-limit headers separately from cache metrics. DennouAibou's current cache-trace output is focused on prompt/session shape and normalized token usage rather than raw provider response headers.

## Quick troubleshooting

- High `cacheWrite` on most turns: check for volatile system-prompt inputs and verify model/provider supports your cache settings.
- Low OpenAI `cacheRead`: verify the stable prefix is at the front, the repeated prefix is at least 1024 tokens, and the same `prompt_cache_key` is reused for turns that should share a cache.
- No effect from `cacheRetention`: confirm model key matches `agents.defaults.models["provider/model"]`.
- Bedrock Nova/Mistral requests with cache settings: expected runtime force to `none`.

Related docs:

- [Token Use and Costs](/reference/token-use)
- [Session Pruning](/concepts/session-pruning)
- [Gateway Configuration Reference](/gateway/configuration-reference)

---
summary: "Model provider overview with example configs + CLI flows"
read_when:
  - You need a provider-by-provider model setup reference
  - You want example configs or CLI onboarding commands for model providers
title: "Model Providers"
---

# Model providers

This page covers **LLM/model providers** (not chat channels like WhatsApp/Telegram).
For model selection rules, see [/concepts/models](/concepts/models).

## Quick rules

- Model refs use `provider/model` (example: `openai/gpt-5.4`).
- If you set `agents.defaults.models`, it becomes the allowlist.
- CLI helpers: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.
- Fallback runtime rules, cooldown probes, and session-override persistence are
  documented in [/concepts/model-failover](/concepts/model-failover).
- `models.providers.*.models[].contextWindow` is native model metadata;
  `models.providers.*.models[].contextTokens` is the effective runtime cap.
- Provider plugins can inject model catalogs via `registerProvider({ catalog })`;
  OpenClaw merges that output into `models.providers` before writing
  `models.json`.
- Provider manifests can declare `providerAuthEnvVars` so generic env-based
  auth probes do not need to load plugin runtime. The remaining core env-var
  map is now just for non-plugin/core providers and a few generic-precedence
  cases.
- Provider plugins can also own provider runtime behavior via
  `normalizeModelId`, `normalizeTransport`, `normalizeConfig`,
  `applyNativeStreamingUsageCompat`, `resolveConfigApiKey`,
  `resolveSyntheticAuth`, `shouldDeferSyntheticProfileAuth`,
  `resolveDynamicModel`, `prepareDynamicModel`,
  `normalizeResolvedModel`, `contributeResolvedModelCompat`,
  `capabilities`, `normalizeToolSchemas`,
  `inspectToolSchemas`, `resolveReasoningOutputMode`,
  `prepareExtraParams`, `createStreamFn`, `wrapStreamFn`,
  `resolveTransportTurnState`, `resolveWebSocketSessionPolicy`,
  `createEmbeddingProvider`, `formatApiKey`, `refreshOAuth`,
  `buildAuthDoctorHint`,
  `matchesContextOverflowError`, `classifyFailoverReason`,
  `isCacheTtlEligible`, `buildMissingAuthMessage`, `suppressBuiltInModel`,
  `augmentModelCatalog`, `isBinaryThinking`, `supportsXHighThinking`,
  `resolveDefaultThinkingLevel`, `applyConfigDefaults`, `isModernModelRef`,
  `prepareRuntimeAuth`, `resolveUsageAuth`, `fetchUsageSnapshot`, and
  `onModelSelected`.
- Note: provider runtime `capabilities` is shared runner metadata (provider
  family, transcript/tooling quirks, transport/cache hints). It is not the
  same as the [public capability model](/plugins/architecture#public-capability-model)
  which describes what a plugin registers (text inference, speech, etc.).

## Plugin-owned provider behavior

Provider plugins can now own most provider-specific logic while OpenClaw keeps
the generic inference loop.

Typical split:

- `auth[].run` / `auth[].runNonInteractive`: provider owns onboarding/login
  flows for `openclaw onboard`, `openclaw models auth`, and headless setup
- `wizard.setup` / `wizard.modelPicker`: provider owns auth-choice labels,
  legacy aliases, onboarding allowlist hints, and setup entries in onboarding/model pickers
- `catalog`: provider appears in `models.providers`
- `normalizeModelId`: provider normalizes legacy/preview model ids before
  lookup or canonicalization
- `normalizeTransport`: provider normalizes transport-family `api` / `baseUrl`
  before generic model assembly; OpenClaw checks the matched provider first,
  then other hook-capable provider plugins until one actually changes the
  transport
- `normalizeConfig`: provider normalizes `models.providers.<id>` config before
  runtime uses it; OpenClaw checks the matched provider first, then other
  hook-capable provider plugins until one actually changes the config. If no
  provider hook rewrites the config, bundled Google-family helpers still
  normalize supported Google provider entries.
- `applyNativeStreamingUsageCompat`: provider applies endpoint-driven native streaming-usage compat rewrites for config providers
- `resolveConfigApiKey`: provider resolves env-marker auth for config providers
  without forcing full runtime auth loading. `amazon-bedrock` also has a
  built-in AWS env-marker resolver here, even though Bedrock runtime auth uses
  the AWS SDK default chain.
- `resolveSyntheticAuth`: provider can expose local/self-hosted or other
  config-backed auth availability without persisting plaintext secrets
- `shouldDeferSyntheticProfileAuth`: provider can mark stored synthetic profile
  placeholders as lower precedence than env/config-backed auth
- `resolveDynamicModel`: provider accepts model ids not present in the local
  static catalog yet
- `prepareDynamicModel`: provider needs a metadata refresh before retrying
  dynamic resolution
- `normalizeResolvedModel`: provider needs transport or base URL rewrites
- `contributeResolvedModelCompat`: provider contributes compat flags for its
  vendor models even when they arrive through another compatible transport
- `capabilities`: provider publishes transcript/tooling/provider-family quirks
- `normalizeToolSchemas`: provider cleans tool schemas before the embedded
  runner sees them
- `inspectToolSchemas`: provider surfaces transport-specific schema warnings
  after normalization
- `resolveReasoningOutputMode`: provider chooses native vs tagged
  reasoning-output contracts
- `prepareExtraParams`: provider defaults or normalizes per-model request params
- `createStreamFn`: provider replaces the normal stream path with a fully
  custom transport
- `wrapStreamFn`: provider applies request headers/body/model compat wrappers
- `resolveTransportTurnState`: provider supplies per-turn native transport
  headers or metadata
- `resolveWebSocketSessionPolicy`: provider supplies native WebSocket session
  headers or session cool-down policy
- `createEmbeddingProvider`: provider owns memory embedding behavior when it
  belongs with the provider plugin instead of the core embedding switchboard
- `formatApiKey`: provider formats stored auth profiles into the runtime
  `apiKey` string expected by the transport
- `refreshOAuth`: provider owns OAuth refresh when the shared `pi-ai`
  refreshers are not enough
- `buildAuthDoctorHint`: provider appends repair guidance when OAuth refresh
  fails
- `matchesContextOverflowError`: provider recognizes provider-specific
  context-window overflow errors that generic heuristics would miss
- `classifyFailoverReason`: provider maps provider-specific raw transport/API
  errors to failover reasons such as rate limit or overload
- `isCacheTtlEligible`: provider decides which upstream model ids support prompt-cache TTL
- `buildMissingAuthMessage`: provider replaces the generic auth-store error
  with a provider-specific recovery hint
- `suppressBuiltInModel`: provider hides stale upstream rows and can return a
  vendor-owned error for direct resolution failures
- `augmentModelCatalog`: provider appends synthetic/final catalog rows after
  discovery and config merging
- `isBinaryThinking`: provider owns binary on/off thinking UX
- `supportsXHighThinking`: provider opts selected models into `xhigh`
- `resolveDefaultThinkingLevel`: provider owns default `/think` policy for a
  model family
- `applyConfigDefaults`: provider applies provider-specific global defaults
  during config materialization based on auth mode, env, or model family
- `isModernModelRef`: provider owns live/smoke preferred-model matching
- `prepareRuntimeAuth`: provider turns a configured credential into a short
  lived runtime token
- `resolveUsageAuth`: provider resolves usage/quota credentials for `/usage`
  and related status/reporting surfaces
- `fetchUsageSnapshot`: provider owns the usage endpoint fetch/parsing while
  core still owns the summary shell and formatting
- `onModelSelected`: provider runs post-selection side effects such as
  telemetry or provider-owned session bookkeeping

Current bundled examples:

- `amazon-bedrock`: provider-owned context-overflow matching and failover
  reason classification for Bedrock-specific throttle/not-ready errors, plus
  the shared `anthropic-by-model` replay family for Claude-only replay-policy
  guards on Anthropic traffic
- `openai`: GPT-5.4 forward-compat fallback, direct OpenAI transport
  normalization, Codex-aware missing-auth hints, Spark suppression, synthetic
  OpenAI/Codex catalog rows, thinking/live-model policy, usage-token alias
  normalization (`input` / `output` and `prompt` / `completion` families), the
  shared `openai-responses-defaults` stream family for native OpenAI/Codex
  wrappers, provider-family metadata, bundled image-generation provider
  registration for `gpt-image-1`, and bundled video-generation provider
  registration for `sora-2`
- `google`: Gemini 3.1 forward-compat fallback, native Gemini replay
  validation, bootstrap replay sanitation, tagged reasoning-output mode,
  modern-model matching, bundled image-generation provider registration for
  Gemini image-preview models, and bundled video-generation provider
  registration for Veo models

The bundled `openai` plugin now owns both provider ids: `openai` and
`openai-codex`.

That covers providers that still fit OpenClaw's normal transports. A provider
that needs a totally custom request executor is a separate, deeper extension
surface.

## API key rotation

- Supports generic provider rotation for selected providers.
- Configure multiple keys via:
  - `OPENCLAW_LIVE_<PROVIDER>_KEY` (single live override, highest priority)
  - `<PROVIDER>_API_KEYS` (comma or semicolon list)
  - `<PROVIDER>_API_KEY` (primary key)
  - `<PROVIDER>_API_KEY_*` (numbered list, e.g. `<PROVIDER>_API_KEY_1`)
- For Google providers, `GOOGLE_API_KEY` is also included as fallback.
- Key selection order preserves priority and deduplicates values.
- Requests are retried with the next key only on rate-limit responses (for
  example `429`, `rate_limit`, `quota`, `resource exhausted`, `Too many
concurrent requests`, `ThrottlingException`, `concurrency limit reached`,
  `workers_ai ... quota limit exceeded`, or periodic usage-limit messages).
- Non-rate-limit failures fail immediately; no key rotation is attempted.
- When all candidate keys fail, the final error is returned from the last attempt.

## Built-in providers (pi-ai catalog)

OpenClaw ships with the pi‑ai catalog. These providers require **no**
`models.providers` config; just set auth + pick a model.

### OpenAI

- Provider: `openai`
- Auth: `OPENAI_API_KEY`
- Optional rotation: `OPENAI_API_KEYS`, `OPENAI_API_KEY_1`, `OPENAI_API_KEY_2`, plus `OPENCLAW_LIVE_OPENAI_KEY` (single override)
- Example models: `openai/gpt-5.4`, `openai/gpt-5.4-pro`
- CLI: `openclaw onboard --auth-choice openai-api-key`
- Default transport is `auto` (WebSocket-first, SSE fallback)
- Override per model via `agents.defaults.models["openai/<model>"].params.transport` (`"sse"`, `"websocket"`, or `"auto"`)
- OpenAI Responses WebSocket warm-up defaults to enabled via `params.openaiWsWarmup` (`true`/`false`)
- OpenAI priority processing can be enabled via `agents.defaults.models["openai/<model>"].params.serviceTier`
- `/fast` and `params.fastMode` map direct `openai/*` Responses requests to `service_tier=priority` on `api.openai.com`
- Use `params.serviceTier` when you want an explicit tier instead of the shared `/fast` toggle
- Hidden OpenClaw attribution headers (`originator`, `version`,
  `User-Agent`) apply only on native OpenAI traffic to `api.openai.com`, not
  generic OpenAI-compatible proxies
- Native OpenAI routes also keep Responses `store`, prompt-cache hints, and
  OpenAI reasoning-compat payload shaping; proxy routes do not
- `openai/gpt-5.3-codex-spark` is intentionally suppressed in OpenClaw because the live OpenAI API rejects it; Spark is treated as Codex-only

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

### OpenAI Code (Codex)

- Provider: `openai-codex`
- Auth: OAuth (ChatGPT)
- Example model: `openai-codex/gpt-5.4`
- CLI: `openclaw onboard --auth-choice openai-codex` or `openclaw models auth login --provider openai-codex`
- Default transport is `auto` (WebSocket-first, SSE fallback)
- Override per model via `agents.defaults.models["openai-codex/<model>"].params.transport` (`"sse"`, `"websocket"`, or `"auto"`)
- `params.serviceTier` is also forwarded on native Codex Responses requests (`chatgpt.com/backend-api`)
- Hidden OpenClaw attribution headers (`originator`, `version`,
  `User-Agent`) are only attached on native Codex traffic to
  `chatgpt.com/backend-api`, not generic OpenAI-compatible proxies
- Shares the same `/fast` toggle and `params.fastMode` config as direct `openai/*`; OpenClaw maps that to `service_tier=priority`
- `openai-codex/gpt-5.3-codex-spark` remains available when the Codex OAuth catalog exposes it; entitlement-dependent
- `openai-codex/gpt-5.4` keeps native `contextWindow = 1050000` and a default runtime `contextTokens = 272000`; override the runtime cap with `models.providers.openai-codex.models[].contextTokens`
- Policy note: OpenAI Codex OAuth is explicitly supported for external tools/workflows like OpenClaw.

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
}
```

```json5
{
  models: {
    providers: {
      "openai-codex": {
        models: [{ id: "gpt-5.4", contextTokens: 160000 }],
      },
    },
  },
}
```

### Google Gemini (API key)

- Provider: `google`
- Auth: `GEMINI_API_KEY`
- Optional rotation: `GEMINI_API_KEYS`, `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, `GOOGLE_API_KEY` fallback, and `OPENCLAW_LIVE_GEMINI_KEY` (single override)
- Example models: `google/gemini-3.1-pro-preview`, `google/gemini-3-flash-preview`
- Compatibility: legacy OpenClaw config using `google/gemini-3.1-flash-preview` is normalized to `google/gemini-3-flash-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`
- Direct Gemini runs also accept `agents.defaults.models["google/<model>"].params.cachedContent`
  (or legacy `cached_content`) to forward a provider-native
  `cachedContents/...` handle; Gemini cache hits surface as OpenClaw `cacheRead`

### Google Vertex

- Provider: `google-vertex`
- Auth: gcloud ADC
  - Gemini CLI JSON replies are parsed from `response`; usage falls back to
    `stats`, with `stats.cached` normalized into OpenClaw `cacheRead`.

### Other bundled provider plugins

- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - GLM models on Cerebras use ids `zai-glm-4.7` and `zai-glm-4.6`.
  - OpenAI-compatible base URL: `https://api.cerebras.ai/v1`.

## Providers via `models.providers` (custom/base URL)

Use `models.providers` (or `models.json`) to add **custom** providers or
OpenAI/Anthropic‑compatible proxies.

Many of the bundled provider plugins below already publish a default catalog.
Use explicit `models.providers.<id>` entries only when you want to override the
default base URL, headers, or model list.

### Local proxies (LM Studio, vLLM, LiteLLM, etc.)

Example (OpenAI‑compatible):

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/my-local-model" },
      models: { "lmstudio/my-local-model": { alias: "Local" } },
    },
  },
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "LMSTUDIO_KEY",
        api: "openai-completions",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Notes:

- For custom providers, `reasoning`, `input`, `cost`, `contextWindow`, and `maxTokens` are optional.
  When omitted, OpenClaw defaults to:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- Recommended: set explicit values that match your proxy/model limits.
- For `api: "openai-completions"` on non-native endpoints (any non-empty `baseUrl` whose host is not `api.openai.com`), OpenClaw forces `compat.supportsDeveloperRole: false` to avoid provider 400 errors for unsupported `developer` roles.
- Proxy-style OpenAI-compatible routes also skip native OpenAI-only request
  shaping: no `service_tier`, no Responses `store`, no prompt-cache hints, no
  OpenAI reasoning-compat payload shaping, and no hidden OpenClaw attribution
  headers.
- If `baseUrl` is empty/omitted, OpenClaw keeps the default OpenAI behavior (which resolves to `api.openai.com`).
- For safety, an explicit `compat.supportsDeveloperRole: true` is still overridden on non-native `openai-completions` endpoints.

## CLI examples

```bash
openclaw onboard --auth-choice gemini-api-key
openclaw models set google/gemini-3.1-pro-preview
openclaw models list
```

See also: [/gateway/configuration](/gateway/configuration) for full configuration examples.

## Related

- [Models](/concepts/models) — model configuration and aliases
- [Model Failover](/concepts/model-failover) — fallback chains and retry behavior
- [Configuration Reference](/gateway/configuration-reference#agent-defaults) — model config keys
- [Providers](/providers) — per-provider setup guides

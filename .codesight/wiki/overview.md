# openclaw — Overview

> **Navigation aid.** This article shows WHERE things live (routes, models, files). Read actual source files before implementing new features or making changes.

**openclaw** is a mixed project built with hono, express, go-net-http, organized as a monorepo.

**Workspaces:** `openclaw` (``), `openclaw-control-ui` (`ui`), `clawdbot` (`packages\clawdbot`), `@openclaw/memory-host-sdk` (`packages\memory-host-sdk`), `moltbot` (`packages\moltbot`), `@openclaw/plugin-package-contract` (`packages\plugin-package-contract`), `@openclaw/acpx` (`extensions\acpx`), `@openclaw/alibaba-provider` (`extensions\alibaba`), `@openclaw/anthropic-provider` (`extensions\anthropic`), `@openclaw/anthropic-vertex-provider` (`extensions\anthropic-vertex`), `@openclaw/brave-plugin` (`extensions\brave`), `@openclaw/browser-plugin` (`extensions\browser`), `@openclaw/byteplus-provider` (`extensions\byteplus`), `@openclaw/chutes-provider` (`extensions\chutes`), `@openclaw/cloudflare-ai-gateway-provider` (`extensions\cloudflare-ai-gateway`), `@openclaw/comfy-provider` (`extensions\comfy`), `@openclaw/copilot-proxy` (`extensions\copilot-proxy`), `@openclaw/deepgram-provider` (`extensions\deepgram`), `@openclaw/deepseek-provider` (`extensions\deepseek`), `@openclaw/diagnostics-otel` (`extensions\diagnostics-otel`), `@openclaw/diffs` (`extensions\diffs`), `@openclaw/discord` (`extensions\discord`), `@openclaw/elevenlabs-speech` (`extensions\elevenlabs`), `@openclaw/exa-plugin` (`extensions\exa`), `@openclaw/fal-provider` (`extensions\fal`), `@openclaw/fireworks-provider` (`extensions\fireworks`), `@openclaw/google-plugin` (`extensions\google`), `@openclaw/googlechat` (`extensions\googlechat`), `@openclaw/groq-provider` (`extensions\groq`), `@openclaw/huggingface-provider` (`extensions\huggingface`), `@openclaw/image-generation-core` (`extensions\image-generation-core`), `@openclaw/imessage` (`extensions\imessage`), `@openclaw/kilocode-provider` (`extensions\kilocode`), `@openclaw/kimi-provider` (`extensions\kimi-coding`), `@openclaw/line` (`extensions\line`), `@openclaw/litellm-provider` (`extensions\litellm`), `@openclaw/llm-task` (`extensions\llm-task`), `@openclaw/lobster` (`extensions\lobster`), `@openclaw/mattermost` (`extensions\mattermost`), `@openclaw/media-understanding-core` (`extensions\media-understanding-core`), `@openclaw/memory-core` (`extensions\memory-core`), `@openclaw/memory-lancedb` (`extensions\memory-lancedb`), `@openclaw/microsoft-speech` (`extensions\microsoft`), `@openclaw/microsoft-foundry` (`extensions\microsoft-foundry`), `@openclaw/minimax-provider` (`extensions\minimax`), `@openclaw/mistral-provider` (`extensions\mistral`), `@openclaw/moonshot-provider` (`extensions\moonshot`), `@openclaw/msteams` (`extensions\msteams`), `@openclaw/nvidia-provider` (`extensions\nvidia`), `@openclaw/ollama-provider` (`extensions\ollama`), `@openclaw/open-prose` (`extensions\open-prose`), `@openclaw/openai-provider` (`extensions\openai`), `@openclaw/opencode-provider` (`extensions\opencode`), `@openclaw/opencode-go-provider` (`extensions\opencode-go`), `@openclaw/openrouter-provider` (`extensions\openrouter`), `@openclaw/openshell-sandbox` (`extensions\openshell`), `@openclaw/perplexity-plugin` (`extensions\perplexity`), `@openclaw/qa-channel` (`extensions\qa-channel`), `@openclaw/qa-lab` (`extensions\qa-lab`), `@openclaw/qianfan-provider` (`extensions\qianfan`), `@openclaw/qwen-provider` (`extensions\qwen`), `@openclaw/runway-provider` (`extensions\runway`), `@openclaw/sglang-provider` (`extensions\sglang`), `@openclaw/speech-core` (`extensions\speech-core`), `@openclaw/stepfun-provider` (`extensions\stepfun`), `@openclaw/synthetic-provider` (`extensions\synthetic`), `@openclaw/telegram` (`extensions\telegram`), `@openclaw/together-provider` (`extensions\together`), `@openclaw/twitch` (`extensions\twitch`), `@openclaw/venice-provider` (`extensions\venice`), `@openclaw/vercel-ai-gateway-provider` (`extensions\vercel-ai-gateway`), `@openclaw/video-generation-core` (`extensions\video-generation-core`), `@openclaw/vllm-provider` (`extensions\vllm`), `@openclaw/voice-call` (`extensions\voice-call`), `@openclaw/volcengine-provider` (`extensions\volcengine`), `@openclaw/xai-plugin` (`extensions\xai`), `@openclaw/xiaomi-provider` (`extensions\xiaomi`), `docs-i18n` (`scripts\docs-i18n`)

## Scale

60 API routes · 3900 library files · 207 middleware layers · 464 environment variables

## Subsystems

- **[Agents.bindings](./agents.bindings.md)** — 1 routes
- **[Anthropic-prompt-probe](./anthropic-prompt-probe.md)** — 1 routes
- **[Bridge-server](./bridge-server.md)** — 1 routes — touches: auth, cache
- **[Capabilities](./capabilities.md)** — 1 routes
- **[Cdp.helpers](./cdp.helpers.md)** — 3 routes
- **[Cdp.test](./cdp.test.md)** — 1 routes
- **[Chat-meta-shared](./chat-meta-shared.md)** — 1 routes
- **[Chrome](./chrome.md)** — 1 routes
- **[Chrome.test](./chrome.test.md)** — 1 routes
- **[Client](./client.md)** — 4 routes
- **[Close](./close.md)** — 1 routes
- **[Core](./core.md)** — 1 routes
- **[Delivery-context.test](./delivery-context.test.md)** — 2 routes
- **[Echo-transcript](./echo-transcript.md)** — 1 routes
- **[Gateway-ws-client](./gateway-ws-client.md)** — 1 routes
- **[Jsonl-socket.test](./jsonl-socket.test.md)** — 2 routes
- **[Lab-server](./lab-server.md)** — 2 routes
- **[Mcp-channels-harness](./mcp-channels-harness.md)** — 1 routes
- **[Media](./media.md)** — 1 routes — touches: queue
- **[Media-stream](./media-stream.md)** — 3 routes
- **[Message-handler](./message-handler.md)** — 1 routes
- **[Monitor-websocket](./monitor-websocket.md)** — 4 routes
- **[Monitor.test](./monitor.test.md)** — 3 routes — touches: auth, payment
- **[Openai-ws-connection](./openai-ws-connection.md)** — 3 routes
- **[Provider.lifecycle](./provider.lifecycle.md)** — 2 routes
- **[Realtime-handler](./realtime-handler.md)** — 2 routes
- **[Realtime-transcription-provider](./realtime-transcription-provider.md)** — 4 routes
- **[Realtime-voice-provider](./realtime-voice-provider.md)** — 4 routes
- **[Send](./send.md)** — 1 routes
- **[Send.test](./send.test.md)** — 1 routes
- **[Sessions-spawn-hooks.test](./sessions-spawn-hooks.test.md)** — 1 routes
- **[Templating](./templating.md)** — 1 routes
- **[Test-helpers.e2e](./test-helpers.e2e.md)** — 1 routes
- **[Test-helpers.server](./test-helpers.server.md)** — 1 routes
- **[Types.core](./types.core.md)** — 1 routes

**Libraries:** 3900 files — see [libraries.md](./libraries.md)

## High-Impact Files

Changes to these files have the widest blast radius across the codebase:

- `src\config\config.ts` — imported by **1471** files
- `src\runtime.ts` — imported by **328** files
- `src\utils.ts` — imported by **219** files
- `src\channels\plugins\types.ts` — imported by **184** files
- `src\routing\session-key.ts` — imported by **174** files
- `src\plugins\runtime.ts` — imported by **169** files

## Required Environment Variables

- `ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS` — `extensions\acpx\src\transport\acp-client.ts`
- `ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS` — `extensions\acpx\src\transport\acp-client.ts`
- `AI_GATEWAY_API_KEY` — `src\commands\auth-choice.test.ts`
- `ALL_PROXY` — `extensions\browser\src\browser\cdp-proxy-bypass.test.ts`
- `ANTHROPIC_API_KEY` — `extensions\openshell\src\backend.test.ts`
- `ANTHROPIC_API_KEY_SECONDARY` — `src\infra\dotenv.test.ts`
- `ANTHROPIC_BASE_URL` — `src\infra\dotenv.test.ts`
- `ANTHROPIC_OAUTH_TOKEN` — `scripts\zai-fallback-repro.ts`
- `AWS_ACCESS_KEY_ID` — `src\agents\model-auth.ts`
- `AWS_BEARER_TOKEN_BEDROCK` — `src\agents\model-auth.ts`
- `AWS_DEFAULT_REGION` — `packages\memory-host-sdk\src\host\embeddings-bedrock.test.ts`
- `AWS_PROFILE` — `src\agents\model-auth.ts`
- _...451 more_

---
_Back to [index.md](./index.md) · Generated 2026-05-19_
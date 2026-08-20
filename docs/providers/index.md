---
summary: "Model providers (LLMs) supported by DennouAibou"
read_when:
  - You want to choose a model provider
  - You need a quick overview of supported LLM backends
title: "Provider Directory"
---

# Model Providers

DennouAibou can use many LLM providers. Pick a provider, authenticate, then set the
default model as `provider/model`.

Looking for chat channel docs (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.)? See [Channels](/channels).

## Quick start

1. Authenticate with the provider (usually via `openclaw onboard`).
2. Set the default model:

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

## Provider docs

- [Amazon Bedrock](/providers/bedrock)
- [Google (Gemini)](/providers/google)
- [OpenAI (API + Codex)](/providers/openai)

## Shared overview pages

- [Image Generation](/tools/image-generation) - Shared `image_generate` tool, provider selection, and failover
- [Music Generation](/tools/music-generation) - Shared `music_generate` tool, provider selection, and failover
- [Video Generation](/tools/video-generation) - Shared `video_generate` tool, provider selection, and failover

## Transcription providers

- [Deepgram (audio transcription)](/providers/deepgram)

## Community tools

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Community proxy for Claude subscription credentials (verify Anthropic policy/terms before use)

For the full provider catalog and advanced configuration, see
[Model providers](/concepts/model-providers).

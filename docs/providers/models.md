---
summary: "Model providers (LLMs) supported by OpenClaw"
read_when:
  - You want to choose a model provider
  - You want quick setup examples for LLM auth + model selection
title: "Model Provider Quickstart"
---

# Model Providers

OpenClaw can use many LLM providers. Pick one, authenticate, then set the default
model as `provider/model`.

## Quick start (two steps)

1. Authenticate with the provider (usually via `openclaw onboard`).
2. Set the default model:

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

## Supported providers (starter set)

- [Amazon Bedrock](/providers/bedrock)
- [OpenAI (API + Codex)](/providers/openai)

For the full provider catalog and advanced configuration, see
[Model providers](/concepts/model-providers).

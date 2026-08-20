---
summary: "Generate music with the shared music-generation provider"
read_when:
  - Generating music or audio via the agent
  - Configuring music generation providers and models
  - Understanding the music_generate tool parameters
title: "Music Generation"
---

# Music Generation

The `music_generate` tool lets the agent create music or audio through the
shared music-generation capability with the bundled Google provider.

For shared provider-backed agent sessions, DennouAibou starts music generation as a
background task, tracks it in the task ledger, then wakes the agent again when
the track is ready so the agent can post the finished audio back into the
original channel.

<Note>
The built-in shared tool only appears when at least one music-generation provider is available. If you don't see `music_generate` in your agent's tools, configure `agents.defaults.musicGenerationModel` or set up a provider API key.
</Note>

## Quick start

### Shared provider-backed generation

1. Set an API key for at least one provider, for example `GEMINI_API_KEY`.
2. Optionally set your preferred model:

```json5
{
  agents: {
    defaults: {
      musicGenerationModel: {
        primary: "google/lyria-3-clip-preview",
      },
    },
  },
}
```

3. Ask the agent: _"Generate an upbeat synthpop track about a night drive
   through a neon city."_

The agent calls `music_generate` automatically. No tool allow-listing needed.

For direct synchronous contexts without a session-backed agent run, the built-in
tool still falls back to inline generation and returns the final media path in
the tool result.

Example prompts:

```text
Generate a cinematic piano track with soft strings and no vocals.
```

```text
Generate an energetic chiptune loop about launching a rocket at sunrise.
```

## Shared bundled provider support

| Provider | Default model          | Reference inputs | Supported controls                                        | API key                                |
| -------- | ---------------------- | ---------------- | --------------------------------------------------------- | -------------------------------------- |
| Google   | `lyria-3-clip-preview` | Up to 10 images  | `lyrics`, `instrumental`, `format`                        | `GEMINI_API_KEY`, `GOOGLE_API_KEY`     |

### Declared capability matrix

This is the explicit mode contract used by `music_generate`, contract tests,
and the shared live sweep.

| Provider | `generate` | `edit` | Edit limit | Shared live lanes                                                         |
| -------- | ---------- | ------ | ---------- | ------------------------------------------------------------------------- |
| Google   | Yes        | Yes    | 10 images  | `generate`, `edit`                                                        |

Use `action: "list"` to inspect available shared providers and models at
runtime:

```text
/tool music_generate action=list
```

Use `action: "status"` to inspect the active session-backed music task:

```text
/tool music_generate action=status
```

Direct generation example:

```text
/tool music_generate prompt="Dreamy lo-fi hip hop with vinyl texture and gentle rain" instrumental=true
```

## Built-in tool parameters

| Parameter         | Type     | Description                                                                                       |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `prompt`          | string   | Music generation prompt (required for `action: "generate"`)                                       |
| `action`          | string   | `"generate"` (default), `"status"` for the current session task, or `"list"` to inspect providers |
| `model`           | string   | Provider/model override, e.g. `google/lyria-3-pro-preview`                                         |
| `lyrics`          | string   | Optional lyrics when the provider supports explicit lyric input                                   |
| `instrumental`    | boolean  | Request instrumental-only output when the provider supports it                                    |
| `image`           | string   | Single reference image path or URL                                                                |
| `images`          | string[] | Multiple reference images (up to 10)                                                              |
| `durationSeconds` | number   | Target duration in seconds when the provider supports duration hints                              |
| `format`          | string   | Output format hint (`mp3` or `wav`) when the provider supports it                                 |
| `filename`        | string   | Output filename hint                                                                              |

Not all providers support all parameters. DennouAibou still validates hard limits
such as input counts before submission, but unsupported optional hints are
ignored with a warning when the selected provider or model cannot honor them.

## Async behavior for the shared provider-backed path

- Session-backed agent runs: `music_generate` creates a background task, returns a started/task response immediately, and posts the finished track later in a follow-up agent message.
- Duplicate prevention: while that background task is still `queued` or `running`, later `music_generate` calls in the same session return task status instead of starting another generation.
- Status lookup: use `action: "status"` to inspect the active session-backed music task without starting a new one.
- Task tracking: use `openclaw tasks list` or `openclaw tasks show <taskId>` to inspect queued, running, and terminal status for the generation.
- Completion wake: DennouAibou injects an internal completion event back into the same session so the model can write the user-facing follow-up itself.
- Prompt hint: later user/manual turns in the same session get a small runtime hint when a music task is already in flight so the model does not blindly call `music_generate` again.
- No-session fallback: direct/local contexts without a real agent session still run inline and return the final audio result in the same turn.

## Configuration

### Model selection

```json5
{
  agents: {
    defaults: {
      musicGenerationModel: {
        primary: "google/lyria-3-clip-preview",
      },
    },
  },
}
```

### Provider selection order

When generating music, DennouAibou tries providers in this order:

1. `model` parameter from the tool call, if the agent specifies one
2. `musicGenerationModel.primary` from config
3. `musicGenerationModel.fallbacks` in order
4. Auto-detection using auth-backed provider defaults only:
   - current default provider first
   - remaining registered music-generation providers in provider-id order

If a provider fails, the next candidate is tried automatically. If all fail, the
error includes details from each attempt.

## Provider notes

- Google uses Lyria 3 batch generation. The current bundled flow supports
  prompt, optional lyrics text, and optional reference images.

## Provider capability modes

The shared music-generation contract now supports explicit mode declarations:

- `generate` for prompt-only generation
- `edit` when the request includes one or more reference images

New provider implementations should prefer explicit mode blocks:

```typescript
capabilities: {
  generate: {
    maxTracks: 1,
    supportsLyrics: true,
    supportsFormat: true,
  },
  edit: {
    enabled: true,
    maxTracks: 1,
    maxInputImages: 1,
    supportsFormat: true,
  },
}
```

Legacy flat fields such as `maxInputImages`, `supportsLyrics`, and
`supportsFormat` are not enough to advertise edit support. Providers should
declare `generate` and `edit` explicitly so live tests, contract tests, and
the shared `music_generate` tool can validate mode support deterministically.

## Choosing the right path

- Use the shared provider-backed path when you want model selection, provider failover, and the built-in async task/status flow.
- Use a plugin path when you need a custom workflow graph or a provider that is not part of the shared bundled music capability.
- If you are debugging shared provider behavior, start with [Google (Gemini)](/providers/google).

## Related

- [Background Tasks](/automation/tasks) - task tracking for detached `music_generate` runs
- [Configuration Reference](/gateway/configuration-reference#agent-defaults) - `musicGenerationModel` config
- [Google (Gemini)](/providers/google)
- [Models](/concepts/models) - model configuration and failover
- [Tools Overview](/tools)

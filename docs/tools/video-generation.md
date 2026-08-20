---
summary: "Generate videos from text, images, or existing videos using Google and OpenAI"
read_when:
  - Generating videos via the agent
  - Configuring video generation providers and models
  - Understanding the video_generate tool parameters
title: "Video Generation"
---

# Video Generation

DennouAibou agents can generate videos from text prompts, reference images, or existing videos. Google (Veo) and OpenAI (Sora) are the supported provider backends, each with different model options, input modes, and feature sets. The agent picks the right provider automatically based on your configuration and available API keys.

<Note>
The `video_generate` tool only appears when at least one video-generation provider is available. If you do not see it in your agent tools, set a provider API key or configure `agents.defaults.videoGenerationModel`.
</Note>

## Quick start

1. Set an API key for any supported provider:

```bash
export GEMINI_API_KEY="your-key"
```

2. Optionally pin a default model:

```bash
openclaw config set agents.defaults.videoGenerationModel.primary "google/veo-3.1-fast-generate-preview"
```

3. Ask the agent:

> Generate a 5-second cinematic video of a friendly lobster surfing at sunset.

The agent calls `video_generate` automatically. No tool allowlisting is needed.

## What happens when you generate a video

Video generation is asynchronous. When the agent calls `video_generate` in a session:

1. DennouAibou submits the request to the provider and immediately returns a task ID.
2. The provider processes the job in the background (typically 30 seconds to 5 minutes depending on the provider and resolution).
3. When the video is ready, DennouAibou wakes the same session with an internal completion event.
4. The agent posts the finished video back into the original conversation.

While a job is in flight, duplicate `video_generate` calls in the same session return the current task status instead of starting another generation. Use `openclaw tasks list` or `openclaw tasks show <taskId>` to check progress from the CLI.

Outside of session-backed agent runs (for example, direct tool invocations), the tool falls back to inline generation and returns the final media path in the same turn.

## Supported providers

| Provider | Default model                   | Text | Image ref | Video ref | API key          |
| -------- | ------------------------------- | ---- | --------- | --------- | ---------------- |
| Google   | `veo-3.1-fast-generate-preview` | Yes  | 1 image   | 1 video   | `GEMINI_API_KEY` |
| OpenAI   | `sora-2`                        | Yes  | 1 image   | 1 video   | `OPENAI_API_KEY` |

Some providers accept additional or alternate API key env vars. See individual [provider pages](#related) for details.

Run `video_generate action=list` to inspect available providers and models at runtime.

## Tool parameters

### Required

| Parameter | Type   | Description                                                                   |
| --------- | ------ | ----------------------------------------------------------------------------- |
| `prompt`  | string | Text description of the video to generate (required for `action: "generate"`) |

### Content inputs

| Parameter | Type     | Description                          |
| --------- | -------- | ------------------------------------ |
| `image`   | string   | Single reference image (path or URL) |
| `images`  | string[] | Multiple reference images (up to 5)  |
| `video`   | string   | Single reference video (path or URL) |
| `videos`  | string[] | Multiple reference videos (up to 4)  |

### Style controls

| Parameter         | Type    | Description                                                              |
| ----------------- | ------- | ------------------------------------------------------------------------ |
| `aspectRatio`     | string  | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`  |
| `resolution`      | string  | `480P`, `720P`, or `1080P`                                               |
| `durationSeconds` | number  | Target duration in seconds (rounded to nearest provider-supported value) |
| `size`            | string  | Size hint when the provider supports it                                  |
| `audio`           | boolean | Enable generated audio when supported                                    |
| `watermark`       | boolean | Toggle provider watermarking when supported                              |

### Advanced

| Parameter  | Type   | Description                                                           |
| ---------- | ------ | --------------------------------------------------------------------- |
| `action`   | string | `"generate"` (default), `"status"`, or `"list"`                       |
| `model`    | string | Provider/model override (e.g. `google/veo-3.1-fast-generate-preview`) |
| `filename` | string | Output filename hint                                                  |

Not all providers support all parameters. Unsupported overrides are ignored on a best-effort basis and reported as warnings in the tool result. Hard capability limits (such as too many reference inputs) fail before submission.

## Actions

- **generate** (default) -- create a video from the given prompt and optional reference inputs.
- **status** -- check the state of the in-flight video task for the current session without starting another generation.
- **list** -- show available providers, models, and their capabilities.

## Model selection

When generating a video, DennouAibou resolves the model in this order:

1. **`model` tool parameter** -- if the agent specifies one in the call.
2. **`videoGenerationModel.primary`** -- from config.
3. **`videoGenerationModel.fallbacks`** -- tried in order.
4. **Auto-detection** -- uses providers that have valid auth, starting with the current default provider, then remaining providers in alphabetical order.

If a provider fails, the next candidate is tried automatically. If all candidates fail, the error includes details from each attempt.

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "google/veo-3.1-fast-generate-preview",
        fallbacks: ["openai/sora-2"],
      },
    },
  },
}
```

## Provider notes

| Provider | Notes                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Google   | Uses Gemini/Veo. Supports one image or one video reference.                                                                              |
| OpenAI   | Only `size` override is forwarded. Other style overrides (`aspectRatio`, `resolution`, `audio`, `watermark`) are ignored with a warning. |

## Configuration

Set the default video generation model in your DennouAibou config:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "google/veo-3.1-fast-generate-preview",
        fallbacks: ["openai/sora-2"],
      },
    },
  },
}
```

Or via the CLI:

```bash
openclaw config set agents.defaults.videoGenerationModel.primary "google/veo-3.1-fast-generate-preview"
```

## Related

- [Tools Overview](/tools)
- [Background Tasks](/automation/tasks) -- task tracking for async video generation
- [Google (Gemini)](/providers/google)
- [OpenAI](/providers/openai)
- [Configuration Reference](/gateway/configuration-reference#agent-defaults)
- [Models](/concepts/models)

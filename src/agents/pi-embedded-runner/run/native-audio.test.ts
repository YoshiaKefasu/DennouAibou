import { describe, expect, it } from "vitest";
import { __testing } from "./native-audio.js";

describe("native-audio stream payload rewriting (OpenAI-compatible)", () => {
  it("rewrites data-url audio image_url parts into input_audio", () => {
    const payload = {
      model: "audio-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Tell me about this clip" },
            {
              type: "image_url",
              image_url: {
                url: "data:audio/ogg;base64,TESTAUDIO=",
              },
            },
          ],
        },
      ],
      stream: true,
    };
    const rewritten = __testing.rewriteAudioPayload(payload) as {
      messages: Array<{ content: unknown[] }>;
    };
    const parts = rewritten.messages[0].content;
    const audioPart = parts.find((part) => (part as { type?: string }).type === "input_audio");
    expect(audioPart).toEqual({
      type: "input_audio",
      input_audio: { data: "TESTAUDIO=", format: "ogg" },
    });
  });

  it("does not rewrite non-audio image payloads", () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,QUJDRA==" },
            },
          ],
        },
      ],
    };
    const rewritten = __testing.rewriteAudioPayload(payload) as {
      messages: Array<{ content: Array<{ type?: string }> }>;
    };
    expect(rewritten.messages[0].content[0].type).toBe("image_url");
  });

  it("maps audio/mpeg to mp3 format", () => {
    const part = __testing.parseAudioDataUrl(
      "data:audio/mpeg;base64,QUJDRA==",
    );
    expect(part).toEqual({ data: "QUJDRA==", format: "mp3" });
  });

  it("returns undefined for malformed data urls", () => {
    expect(__testing.parseAudioDataUrl("data:image/png;base64,QUJDRA==")).toBeUndefined();
    expect(__testing.parseAudioDataUrl("audio/ogg;base64,TEST")).toBeUndefined();
  });
});
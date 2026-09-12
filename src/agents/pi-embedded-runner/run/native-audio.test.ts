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
    const part = __testing.parseAudioDataUrl("data:audio/mpeg;base64,QUJDRA==");
    expect(part).toEqual({ data: "QUJDRA==", format: "mp3" });
  });

  it("returns undefined for malformed data urls", () => {
    expect(__testing.parseAudioDataUrl("data:image/png;base64,QUJDRA==")).toBeUndefined();
    expect(__testing.parseAudioDataUrl("audio/ogg;base64,TEST")).toBeUndefined();
  });
});

describe("native-audio context injection (persisted audio de-dup)", () => {
  const block = { type: "audio", data: "QUJDRA==", mimeType: "audio/ogg" } as const;

  it("detects audio parts anywhere in the context", () => {
    expect(
      __testing.contextHasAudio({
        systemPrompt: "",
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
          {
            role: "user",
            content: [{ type: "audio", data: "QUJDRA==", mimeType: "audio/ogg" }],
            timestamp: 2,
          },
        ],
      } as never),
    ).toBe(true);
    expect(
      __testing.contextHasAudio({
        systemPrompt: "",
        messages: [{ role: "user", content: "plain text", timestamp: 1 }],
      } as never),
    ).toBe(false);
  });

  it("counts decoded audio bytes across messages", () => {
    expect(
      __testing.contextAudioBytes({
        systemPrompt: "",
        messages: [
          {
            role: "user",
            content: [{ type: "audio", data: "QUJDRA==", mimeType: "audio/ogg" }],
            timestamp: 1,
          },
        ],
      } as never),
    ).toBe(Buffer.from("QUJDRA==", "base64").length);
    expect(
      __testing.contextAudioBytes({
        systemPrompt: "",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
      } as never),
    ).toBe(0);
  });

  it("skips injection when the context already carries audio from history", async () => {
    const { createNativeAudioStreamFn } = await import("./native-audio.js");
    const capturedContexts: unknown[] = [];
    const inner = (async (_model: unknown, context: unknown) => {
      capturedContexts.push(context);
      return { async *[Symbol.asyncIterator]() {} };
    }) as never;
    const wrapped = createNativeAudioStreamFn(inner, [block]);
    const contextWithPersistedAudio = {
      systemPrompt: "",
      messages: [
        {
          role: "user",
          content: [{ type: "audio", data: block.data, mimeType: block.mimeType }],
          timestamp: 1,
        },
        { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 },
        { role: "user", content: [{ type: "text", text: "and this?" }], timestamp: 3 },
      ],
    } as never;
    await wrapped({ id: "m" } as never, contextWithPersistedAudio);
    const messages = (
      capturedContexts[0] as {
        messages: Array<{ content: unknown }>;
      }
    ).messages;
    // The last user message stays text-only: the audio already lives in
    // history, so injecting again would duplicate the payload.
    expect(messages[messages.length - 1].content).toEqual([{ type: "text", text: "and this?" }]);
  });

  it("injects blocks into the last user message when history has none", async () => {
    const { createNativeAudioStreamFn } = await import("./native-audio.js");
    const capturedContexts: unknown[] = [];
    const inner = (async (_model: unknown, context: unknown) => {
      capturedContexts.push(context);
      return { async *[Symbol.asyncIterator]() {} };
    }) as never;
    const wrapped = createNativeAudioStreamFn(inner, [block]);
    const textOnlyContext = {
      systemPrompt: "",
      messages: [{ role: "user", content: [{ type: "text", text: "listen" }], timestamp: 1 }],
    } as never;
    await wrapped({ id: "m" } as never, textOnlyContext);
    const lastMessage = (
      capturedContexts[0] as { messages: Array<{ content: unknown[] }> }
    ).messages.at(-1);
    expect(lastMessage?.content).toHaveLength(2);
    expect(lastMessage?.content.at(-1)).toEqual(block);
  });
});

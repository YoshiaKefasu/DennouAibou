import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildOpenAICompletionsParams,
  parseTransportChunkUsage,
  sanitizeTransportPayloadText,
} from "./openai-transport-stream.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import {
  buildTransportAwareSimpleStreamFn,
  createBoundaryAwareStreamFnForModel,
  isTransportAwareApiSupported,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";

describe("openai transport stream", () => {
  it("reports the supported transport-aware APIs", () => {
    expect(isTransportAwareApiSupported("openai-completions")).toBe(true);
    expect(isTransportAwareApiSupported("openai-responses" as never)).toBe(false);
    expect(isTransportAwareApiSupported("anthropic-messages" as never)).toBe(false);
    expect(isTransportAwareApiSupported("google-generative-ai" as never)).toBe(false);
  });

  it("builds boundary-aware stream shapers for supported default agent transports", () => {
    expect(
      createBoundaryAwareStreamFnForModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">),
    ).toBeTypeOf("function");
  });

  it("prepares a custom simple-completion api alias when transport overrides are attached", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const prepared = prepareTransportAwareSimpleModel(model);

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-openai-completions-transport");
    expect(prepared).toMatchObject({
      api: "openclaw-openai-completions-transport",
      provider: "openai",
      id: "gpt-5.4",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("builds completions request parameters with messages and system prompt", () => {
    const model: Model<"openai-completions"> = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    };

    const params = buildOpenAICompletionsParams(
      model,
      {
        systemPrompt: `You are helpful.${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic part.`,
        messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
      },
      { maxTokens: 1024, temperature: 0.7 },
    );

    expect(params.model).toBe("gpt-5.4");
    expect(params.stream).toBe(true);
    expect(params.temperature).toBe(0.7);
    expect(Array.isArray(params.messages)).toBe(true);
  });

  it("calculates usage from completions chunk", () => {
    const model: Model<"openai-completions"> = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    };

    const usage = parseTransportChunkUsage(
      {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 20 },
      },
      model,
    );

    expect(usage.input).toBe(80);
    expect(usage.output).toBe(50);
    expect(usage.cacheRead).toBe(20);
    expect(usage.totalTokens).toBe(150);
  });

  it("sanitizes unpaired surrogates in transport payload text", () => {
    expect(sanitizeTransportPayloadText("test\uD800string")).toBe("teststring");
  });
});

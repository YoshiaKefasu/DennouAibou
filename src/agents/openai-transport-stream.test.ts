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

  it("forwards reasoning_effort: max when the model advertises reasoning and supportsReasoningEffort", () => {
    const model = {
      id: "kimi-k3",
      name: "Kimi K3",
      api: "openai-completions",
      provider: "cli-router",
      baseUrl: "http://127.0.0.1:8317/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
      compat: {
        supportsReasoningEffort: true,
        reasoningEffortMap: {
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
      },
    } as unknown as Model<"openai-completions">;

    const params = buildOpenAICompletionsParams(
      model,
      {
        messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
      },
      { reasoningEffort: "max" },
    );

    expect(params.reasoning_effort).toBe("max");
    expect(params.reasoning).toBeUndefined();
  });

  it("omits reasoning_effort when the model's map marks the requested level as null", () => {
    const model = {
      id: "kimi-k3",
      name: "Kimi K3",
      api: "openai-completions",
      provider: "cli-router",
      baseUrl: "http://127.0.0.1:8317/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
      compat: {
        supportsReasoningEffort: true,
        reasoningEffortMap: {
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: null,
        },
      },
    } as unknown as Model<"openai-completions">;

    const params = buildOpenAICompletionsParams(
      model,
      {
        messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
      },
      { reasoningEffort: "max" },
    );

    // The map says "max" is not supported → reasoning_effort must not appear
    // on the wire (defense against sending an unsupported effort level).
    expect(params.reasoning_effort).toBeUndefined();
    expect(params.reasoning).toBeUndefined();
  });

  it("passes reasoning_effort through when the model has no map but supportsReasoningEffort is true", () => {
    // Back-compat: legacy configs that only set supportsReasoningEffort
    // should still emit the raw effort token on the wire.
    const model = {
      id: "legacy-model",
      name: "Legacy Model",
      api: "openai-completions",
      provider: "demo",
      baseUrl: "http://127.0.0.1/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
      compat: { supportsReasoningEffort: true },
    } as unknown as Model<"openai-completions">;

    const params = buildOpenAICompletionsParams(
      model,
      {
        messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
      },
      { reasoningEffort: "low" },
    );

    expect(params.reasoning_effort).toBe("low");
  });
});

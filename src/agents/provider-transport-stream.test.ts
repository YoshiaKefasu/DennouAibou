import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import {
  buildTransportAwareSimpleStreamFn,
  createBoundaryAwareStreamFnForModel,
  createTransportAwareStreamFnForModel,
  isTransportAwareApiSupported,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";

function buildModel<TApi extends Api>(
  api: TApi,
  params: {
    id: string;
    provider: string;
    baseUrl: string;
  },
): Model<TApi> {
  return {
    id: params.id,
    name: params.id,
    api,
    provider: params.provider,
    baseUrl: params.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

describe("provider transport stream contracts", () => {
  it("covers the supported transport api alias matrix", () => {
    const supportedCases = [
      {
        api: "openai-completions" as const,
        provider: "xai",
        id: "grok-4",
        baseUrl: "https://api.x.ai/v1",
        alias: "openclaw-openai-completions-transport" as const,
      },
    ];

    for (const testCase of supportedCases) {
      const model = attachModelProviderRequestTransport(
        buildModel(testCase.api, {
          id: testCase.id,
          provider: testCase.provider,
          baseUrl: testCase.baseUrl,
        }),
        {
          proxy: {
            mode: "explicit-proxy",
            url: "http://proxy.internal:8443",
          },
        },
      );

      expect(isTransportAwareApiSupported(testCase.api)).toBe(true);
      expect(resolveTransportAwareSimpleApi(testCase.api)).toBe(testCase.alias);
      expect(createBoundaryAwareStreamFnForModel(model)).toBeTypeOf("function");
      expect(createTransportAwareStreamFnForModel(model)).toBeTypeOf("function");
      expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
      expect(prepareTransportAwareSimpleModel(model)).toMatchObject({
        api: testCase.alias,
        provider: testCase.provider,
        id: testCase.id,
      });
    }

    const unsupportedApis = [
      "openai-responses",
      "openai-codex-responses",
      "azure-openai-responses",
      "anthropic-messages",
      "google-generative-ai",
    ] as const;

    for (const api of unsupportedApis) {
      expect(isTransportAwareApiSupported(api as never)).toBe(false);
      expect(resolveTransportAwareSimpleApi(api as never)).toBeUndefined();
    }
  });

  it("fails closed when unsupported apis carry transport overrides", () => {
    const model = attachModelProviderRequestTransport(
      buildModel("ollama", {
        id: "qwen3:32b",
        provider: "ollama",
        baseUrl: "http://localhost:11434",
      }),
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(isTransportAwareApiSupported(model.api)).toBe(false);
    expect(resolveTransportAwareSimpleApi(model.api)).toBeUndefined();
    expect(createBoundaryAwareStreamFnForModel(model)).toBeUndefined();
    expect(() => createTransportAwareStreamFnForModel(model)).toThrow(
      'Model-provider request.proxy/request.tls is not yet supported for api "ollama"',
    );
    expect(() => buildTransportAwareSimpleStreamFn(model)).toThrow(
      'Model-provider request.proxy/request.tls is not yet supported for api "ollama"',
    );
    expect(() => prepareTransportAwareSimpleModel(model)).toThrow(
      'Model-provider request.proxy/request.tls is not yet supported for api "ollama"',
    );
  });

  it("keeps unsupported apis unchanged when no transport overrides are attached", () => {
    const model = buildModel("ollama", {
      id: "qwen3:32b",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });

    expect(createTransportAwareStreamFnForModel(model)).toBeUndefined();
    expect(buildTransportAwareSimpleStreamFn(model)).toBeUndefined();
    expect(prepareTransportAwareSimpleModel(model)).toBe(model);
  });
});

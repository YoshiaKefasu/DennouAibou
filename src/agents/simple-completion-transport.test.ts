import type { Model } from "@earendil-works/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const ensureCustomApiRegistered = vi.fn();
const resolveProviderStreamFn = vi.fn();
const buildTransportAwareSimpleStreamFn = vi.fn();
const prepareTransportAwareSimpleModel = vi.fn();

vi.mock("./custom-api-registry.js", () => ({
  ensureCustomApiRegistered,
}));

vi.mock("./provider-transport-stream.js", () => ({
  buildTransportAwareSimpleStreamFn,
  prepareTransportAwareSimpleModel,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderStreamFn,
}));

let prepareModelForSimpleCompletion: typeof import("./simple-completion-transport.js").prepareModelForSimpleCompletion;

describe("prepareModelForSimpleCompletion", () => {
  beforeAll(async () => {
    ({ prepareModelForSimpleCompletion } = await import("./simple-completion-transport.js"));
  });

  beforeEach(() => {
    ensureCustomApiRegistered.mockReset();
    resolveProviderStreamFn.mockReset();
    buildTransportAwareSimpleStreamFn.mockReset();
    prepareTransportAwareSimpleModel.mockReset();
    resolveProviderStreamFn.mockReturnValue("ollama-stream");
    buildTransportAwareSimpleStreamFn.mockReturnValue(undefined);
    prepareTransportAwareSimpleModel.mockImplementation((model) => model);
  });

  it("registers the configured Ollama transport and keeps the original api", () => {
    const model: Model<"ollama"> = {
      id: "llama3",
      name: "Llama 3",
      api: "ollama",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 4096,
      headers: {},
    };
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://remote-ollama:11434",
            models: [],
          },
        },
      },
    };

    const result = prepareModelForSimpleCompletion({
      model,
      cfg,
    });

    expect(resolveProviderStreamFn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ollama",
        config: cfg,
        context: expect.objectContaining({
          provider: "ollama",
          modelId: "llama3",
          model,
        }),
      }),
    );
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith("ollama", "ollama-stream");
    expect(result).toBe(model);
  });

  it("prepares transport-aware simple models and registers their stream function", () => {
    const originalModel: Model<"openai-completions"> = {
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
    const transportModel: Model<"openai-completions"> = {
      ...originalModel,
      api: "openclaw-openai-completions-transport" as never,
    };

    resolveProviderStreamFn.mockReturnValueOnce(undefined);
    prepareTransportAwareSimpleModel.mockReturnValueOnce(transportModel);
    buildTransportAwareSimpleStreamFn.mockReturnValueOnce("openai-stream");

    const result = prepareModelForSimpleCompletion({ model: originalModel });

    expect(prepareTransportAwareSimpleModel).toHaveBeenCalledWith(originalModel);
    expect(buildTransportAwareSimpleStreamFn).toHaveBeenCalledWith(originalModel);
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
      "openclaw-openai-completions-transport",
      "openai-stream",
    );
    expect(result).toBe(transportModel);
  });
});

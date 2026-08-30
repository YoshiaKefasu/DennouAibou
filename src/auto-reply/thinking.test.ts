import { beforeEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderBinaryThinking: vi.fn(),
  resolveProviderDefaultThinkingLevel: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
}));

let isElevatedThinkingDenied: typeof import("./thinking.js").isElevatedThinkingDenied;
let listThinkingLevelLabels: typeof import("./thinking.js").listThinkingLevelLabels;
let listThinkingLevels: typeof import("./thinking.js").listThinkingLevels;
let normalizeReasoningLevel: typeof import("./thinking.js").normalizeReasoningLevel;
let normalizeThinkLevel: typeof import("./thinking.js").normalizeThinkLevel;
let resolveThinkingDefaultForModel: typeof import("./thinking.js").resolveThinkingDefaultForModel;

async function loadFreshThinkingModuleForTest() {
  vi.resetModules();
  vi.doMock("../plugins/provider-thinking.js", () => ({
    resolveProviderBinaryThinking: providerRuntimeMocks.resolveProviderBinaryThinking,
    resolveProviderDefaultThinkingLevel: providerRuntimeMocks.resolveProviderDefaultThinkingLevel,
  }));
  vi.doMock("../config/config.js", () => ({
    loadConfig: configMocks.loadConfig,
  }));
  return await import("./thinking.js");
}

beforeEach(async () => {
  providerRuntimeMocks.resolveProviderBinaryThinking.mockReset();
  providerRuntimeMocks.resolveProviderBinaryThinking.mockReturnValue(undefined);
  providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockReset();
  providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockReturnValue(undefined);

  configMocks.loadConfig.mockReset();
  configMocks.loadConfig.mockReturnValue({});

  ({
    isElevatedThinkingDenied,
    listThinkingLevelLabels,
    listThinkingLevels,
    normalizeReasoningLevel,
    normalizeThinkLevel,
    resolveThinkingDefaultForModel,
  } = await loadFreshThinkingModuleForTest());
});

describe("normalizeThinkLevel", () => {
  it("accepts mid as medium", () => {
    expect(normalizeThinkLevel("mid")).toBe("medium");
  });

  it("accepts xhigh aliases", () => {
    expect(normalizeThinkLevel("xhigh")).toBe("xhigh");
    expect(normalizeThinkLevel("x-high")).toBe("xhigh");
    expect(normalizeThinkLevel("x_high")).toBe("xhigh");
    expect(normalizeThinkLevel("x high")).toBe("xhigh");
  });

  it("accepts extra-high aliases as xhigh", () => {
    expect(normalizeThinkLevel("extra-high")).toBe("xhigh");
    expect(normalizeThinkLevel("extra high")).toBe("xhigh");
    expect(normalizeThinkLevel("extra_high")).toBe("xhigh");
    expect(normalizeThinkLevel("  extra high  ")).toBe("xhigh");
  });

  it("does not over-match nearby xhigh words", () => {
    expect(normalizeThinkLevel("extra-highest")).toBeUndefined();
    expect(normalizeThinkLevel("xhigher")).toBeUndefined();
  });

  it("accepts on as low", () => {
    expect(normalizeThinkLevel("on")).toBe("low");
  });

  it("accepts adaptive and auto aliases", () => {
    expect(normalizeThinkLevel("adaptive")).toBe("adaptive");
    expect(normalizeThinkLevel("auto")).toBe("adaptive");
    expect(normalizeThinkLevel("Adaptive")).toBe("adaptive");
  });

  it("accepts max and maximum as the max reasoning level", () => {
    expect(normalizeThinkLevel("max")).toBe("max");
    expect(normalizeThinkLevel("MAX")).toBe("max");
    expect(normalizeThinkLevel("maximum")).toBe("max");
  });
});

describe("listThinkingLevels", () => {
  it("returns base levels for models without a map", () => {
    // No map, no plugin opt-in → base levels only.
    expect(listThinkingLevels("demo", "demo-model")).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "adaptive",
    ]);
  });

  it("derives choices from the reasoningEffortMap when present", () => {
    configMocks.loadConfig.mockReturnValue({
      models: {
        providers: {
          "cli-router": {
            models: [
              {
                id: "kimi-k3",
                compat: {
                  reasoningEffortMap: {
                    minimal: null,
                    low: "low",
                    medium: null,
                    high: "high",
                    xhigh: null,
                    max: "max",
                  },
                },
              },
            ],
          },
        },
      },
    });

    expect(listThinkingLevels("cli-router", "kimi-k3")).toEqual([
      "off",
      "low",
      "high",
      "max",
      "adaptive",
    ]);
  });

  it("places map entries in PI canonical order, dropping null entries", () => {
    configMocks.loadConfig.mockReturnValue({
      models: {
        providers: {
          demo: {
            models: [
              {
                id: "demo-model",
                compat: {
                  reasoningEffortMap: {
                    max: "max",
                    minimal: "minimal",
                    medium: "medium",
                  },
                },
              },
            ],
          },
        },
      },
    });

    expect(listThinkingLevels("demo", "demo-model")).toEqual([
      "off",
      "minimal",
      "medium",
      "max",
      "adaptive",
    ]);
  });

  it("always includes adaptive", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).toContain("adaptive");
  });
});

describe("listThinkingLevelLabels", () => {
  it("uses provider runtime hooks for binary thinking providers", () => {
    providerRuntimeMocks.resolveProviderBinaryThinking.mockReturnValue(true);

    expect(listThinkingLevelLabels("demo", "demo-model")).toEqual(["off", "on"]);
  });

  it("returns on/off for provider-advertised binary thinking", () => {
    providerRuntimeMocks.resolveProviderBinaryThinking.mockImplementation(({ provider }) =>
      provider === "zai" ? true : undefined,
    );

    expect(listThinkingLevelLabels("zai", "glm-4.7")).toEqual(["off", "on"]);
  });

  it("does not assume binary thinking without provider runtime", () => {
    expect(listThinkingLevelLabels("zai", "glm-4.7")).toContain("low");
    expect(listThinkingLevelLabels("zai", "glm-4.7")).not.toContain("on");
  });

  it("returns full levels for non-ZAI", () => {
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).toContain("low");
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).not.toContain("on");
  });
});

describe("resolveThinkingDefaultForModel", () => {
  it("uses provider runtime hooks for default thinking levels", () => {
    providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockReturnValue("adaptive");

    expect(resolveThinkingDefaultForModel({ provider: "demo", model: "demo-model" })).toBe(
      "adaptive",
    );
  });

  it("uses provider-advertised adaptive defaults", () => {
    providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockImplementation(
      ({ provider, context }) =>
        provider === "anthropic" && context.modelId === "claude-opus-4-6" ? "adaptive" : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({ provider: "anthropic", model: "claude-opus-4-6" }),
    ).toBe("adaptive");
  });

  it("uses provider-advertised adaptive defaults for Bedrock aliases", () => {
    providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockImplementation(
      ({ provider, context }) =>
        provider === "amazon-bedrock" && context.modelId === "claude-sonnet-4-6"
          ? "adaptive"
          : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({ provider: "aws-bedrock", model: "claude-sonnet-4-6" }),
    ).toBe("adaptive");
  });

  it("does not assume adaptive defaults without provider runtime", () => {
    expect(
      resolveThinkingDefaultForModel({ provider: "anthropic", model: "claude-opus-4-6" }),
    ).toBe("off");
    expect(
      resolveThinkingDefaultForModel({ provider: "aws-bedrock", model: "claude-sonnet-4-6" }),
    ).toBe("off");
  });

  it("defaults reasoning-capable catalog models to low", () => {
    expect(
      resolveThinkingDefaultForModel({
        provider: "openai",
        model: "gpt-5.4",
        catalog: [{ provider: "openai", id: "gpt-5.4", reasoning: true }],
      }),
    ).toBe("low");
  });

  it("defaults to off when no adaptive or reasoning hint is present", () => {
    expect(
      resolveThinkingDefaultForModel({
        provider: "openai",
        model: "gpt-4.1-mini",
        catalog: [{ provider: "openai", id: "gpt-4.1-mini", reasoning: false }],
      }),
    ).toBe("off");
  });
});

describe("normalizeReasoningLevel", () => {
  it("accepts on/off", () => {
    expect(normalizeReasoningLevel("on")).toBe("on");
    expect(normalizeReasoningLevel("off")).toBe("off");
  });

  it("accepts show/hide", () => {
    expect(normalizeReasoningLevel("show")).toBe("on");
    expect(normalizeReasoningLevel("hide")).toBe("off");
  });

  it("accepts stream", () => {
    expect(normalizeReasoningLevel("stream")).toBe("stream");
    expect(normalizeReasoningLevel("streaming")).toBe("stream");
  });
});

describe("isElevatedThinkingDenied", () => {
  it("denies xhigh for models with no map", () => {
    expect(isElevatedThinkingDenied("xhigh", "demo", "demo-model")).toBe(true);
  });

  it("denies max for models with no map", () => {
    expect(isElevatedThinkingDenied("max", "demo", "demo-model")).toBe(true);
  });

  it("denies xhigh when the model map sets xhigh to null", () => {
    configMocks.loadConfig.mockReturnValue({
      models: {
        providers: {
          "cli-router": {
            models: [
              {
                id: "kimi-k3",
                compat: {
                  reasoningEffortMap: {
                    low: "low",
                    high: "high",
                    max: "max",
                    xhigh: null,
                  },
                },
              },
            ],
          },
        },
      },
    });
    expect(isElevatedThinkingDenied("xhigh", "cli-router", "kimi-k3")).toBe(true);
  });

  it("denies max when the model map sets max to null", () => {
    configMocks.loadConfig.mockReturnValue({
      models: {
        providers: {
          demo: {
            models: [
              {
                id: "demo-model",
                compat: { reasoningEffortMap: { low: "low", high: "high" } },
              },
            ],
          },
        },
      },
    });
    expect(isElevatedThinkingDenied("max", "demo", "demo-model")).toBe(true);
  });

  it("allows xhigh when the model map declares it", () => {
    configMocks.loadConfig.mockReturnValue({
      models: {
        providers: {
          demo: {
            models: [
              {
                id: "demo-model",
                compat: { reasoningEffortMap: { high: "high", xhigh: "xhigh" } },
              },
            ],
          },
        },
      },
    });
    expect(isElevatedThinkingDenied("xhigh", "demo", "demo-model")).toBe(false);
  });

  it("allows max when the model map declares it (cli-router kimi-k3 path)", () => {
    configMocks.loadConfig.mockReturnValue({
      models: {
        providers: {
          "cli-router": {
            models: [
              {
                id: "kimi-k3",
                compat: {
                  reasoningEffortMap: {
                    minimal: null,
                    low: "low",
                    medium: null,
                    high: "high",
                    xhigh: null,
                    max: "max",
                  },
                },
              },
            ],
          },
        },
      },
    });
    expect(isElevatedThinkingDenied("max", "cli-router", "kimi-k3")).toBe(false);
  });

  it("returns false for non-elevated levels regardless of map presence", () => {
    expect(isElevatedThinkingDenied("high", "demo", "demo-model")).toBe(false);
    expect(isElevatedThinkingDenied("off", "demo", "demo-model")).toBe(false);
    expect(isElevatedThinkingDenied("low", "demo", "demo-model")).toBe(false);
  });
});

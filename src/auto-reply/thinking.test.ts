import { beforeEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderBinaryThinking: vi.fn(),
  resolveProviderDefaultThinkingLevel: vi.fn(),
  resolveProviderMaxThinking: vi.fn(),
  resolveProviderXHighThinking: vi.fn(),
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
    resolveProviderMaxThinking: providerRuntimeMocks.resolveProviderMaxThinking,
    resolveProviderXHighThinking: providerRuntimeMocks.resolveProviderXHighThinking,
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
  providerRuntimeMocks.resolveProviderMaxThinking.mockReset();
  providerRuntimeMocks.resolveProviderMaxThinking.mockReturnValue(undefined);
  providerRuntimeMocks.resolveProviderXHighThinking.mockReset();
  providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(undefined);

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
  it("uses provider runtime hooks for xhigh support", () => {
    providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(true);

    expect(listThinkingLevels("demo", "demo-model")).toContain("xhigh");
  });

  it("includes xhigh for provider-advertised models", () => {
    providerRuntimeMocks.resolveProviderXHighThinking.mockImplementation(({ provider, context }) =>
      (provider === "openai" && ["gpt-5.4", "gpt-5.4", "gpt-5.4-pro"].includes(context.modelId)) ||
      (provider === "openai-codex" &&
        ["gpt-5.4", "gpt-5.4", "gpt-5.3-codex-spark"].includes(context.modelId)) ||
      (provider === "github-copilot" && ["gpt-5.4", "gpt-5.4"].includes(context.modelId))
        ? true
        : undefined,
    );

    expect(listThinkingLevels("openai-codex", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("openai-codex", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("openai-codex", "gpt-5.3-codex-spark")).toContain("xhigh");
    expect(listThinkingLevels("openai", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("openai", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("openai", "gpt-5.4-pro")).toContain("xhigh");
    expect(listThinkingLevels("openai-codex", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("github-copilot", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("github-copilot", "gpt-5.4")).toContain("xhigh");
  });

  it("excludes xhigh for non-codex models", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).not.toContain("xhigh");
  });

  it("always includes adaptive", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).toContain("adaptive");
    expect(listThinkingLevels("anthropic", "claude-opus-4-6")).toContain("adaptive");
  });

  it("excludes max unless supportsMaxThinking opts in", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).not.toContain("max");
  });

  it("includes max right after xhigh when the plugin opts in", () => {
    providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(true);
    providerRuntimeMocks.resolveProviderMaxThinking.mockReturnValue(true);

    const levels = listThinkingLevels("demo", "demo-model");
    const xhighIndex = levels.indexOf("xhigh");
    const maxIndex = levels.indexOf("max");
    expect(maxIndex).toBe(xhighIndex + 1);
  });

  it("omits max when only xhigh is opted in via provider but max returns false", () => {
    // When the plugin says false for max but xhigh returns true, we honor
    // the explicit false (no fallback to xhigh) and keep max hidden.
    providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(true);
    providerRuntimeMocks.resolveProviderMaxThinking.mockReturnValue(false);

    expect(listThinkingLevels("demo", "demo-model")).not.toContain("max");
    expect(listThinkingLevels("demo", "demo-model")).toContain("xhigh");
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
  it("rejects xhigh when the provider plugin does not opt in", () => {
    // No plugin opt-in, no compat flag → xhigh denied.
    providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(false);
    expect(isElevatedThinkingDenied("xhigh", "demo", "demo-model")).toBe(true);
  });

  it("rejects max when the provider plugin does not opt in and compat flag is absent", () => {
    // No plugin opt-in, no compat flag → max denied.
    providerRuntimeMocks.resolveProviderMaxThinking.mockReturnValue(false);
    expect(isElevatedThinkingDenied("max", "demo", "demo-model")).toBe(true);
  });

  it("returns false for non-elevated levels regardless of provider support", () => {
    expect(isElevatedThinkingDenied("high", "demo", "demo-model")).toBe(false);
    expect(isElevatedThinkingDenied("off", "demo", "demo-model")).toBe(false);
    expect(isElevatedThinkingDenied("low", "demo", "demo-model")).toBe(false);
  });

  it("opts max in when the model advertises compat.supportsReasoningEffort", () => {
    // The cli-router moonshotai/kimi-k3 path: no plugin opt-in, but the
    // catalog entry sets compat.supportsReasoningEffort = true, which is
    // the only signal that the openai-completions wire accepts "max".
    providerRuntimeMocks.resolveProviderMaxThinking.mockReturnValue(undefined);
    configMocks.loadConfig.mockReturnValue({
      models: {
        providers: {
          "cli-router": {
            models: [
              {
                id: "kimi-k3",
                compat: { supportsReasoningEffort: true },
              },
            ],
          },
        },
      },
    });
    expect(isElevatedThinkingDenied("max", "cli-router", "kimi-k3")).toBe(false);
  });
});

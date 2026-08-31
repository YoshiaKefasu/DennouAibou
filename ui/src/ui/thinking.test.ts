import { describe, expect, it } from "vitest";
import {
  formatThinkingLevels,
  listThinkingLevelLabels,
  normalizeThinkLevel,
  type ThinkingCatalogEntry,
} from "./thinking.ts";

const BASE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "adaptive"] as const;

// kimi-k3-style map: only low/high/max are advertised; minimal/medium/xhigh
// are declared-but-null (dropped, mirroring the backend behavior).
const KIMI_K3_CATALOG: ThinkingCatalogEntry[] = [
  {
    id: "kimi-k3",
    provider: "cli-router",
    reasoning: true,
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
];

describe("normalizeThinkLevel", () => {
  it("keeps max and high distinct", () => {
    expect(normalizeThinkLevel("max")).toBe("max");
    expect(normalizeThinkLevel("high")).toBe("high");
    expect(normalizeThinkLevel("maximum")).toBe("max");
  });

  it("normalizes xhigh without collapsing it into high", () => {
    expect(normalizeThinkLevel("xhigh")).toBe("xhigh");
    expect(normalizeThinkLevel("extra-high")).toBe("xhigh");
    expect(normalizeThinkLevel("extrahigh")).toBe("xhigh");
  });

  it("keeps existing base-level normalization intact", () => {
    expect(normalizeThinkLevel("off")).toBe("off");
    expect(normalizeThinkLevel("minimal")).toBe("minimal");
    expect(normalizeThinkLevel("thinkhard")).toBe("low");
    expect(normalizeThinkLevel("think-harder")).toBe("medium");
    expect(normalizeThinkLevel("ultra")).toBe("high");
    expect(normalizeThinkLevel("adaptive")).toBe("adaptive");
  });
});

describe("listThinkingLevelLabels", () => {
  it("returns model-specific levels in PI order when the model declares a reasoningEffortMap", () => {
    expect(listThinkingLevelLabels("cli-router", "kimi-k3", KIMI_K3_CATALOG)).toEqual([
      "off",
      "low",
      "high",
      "max",
      "adaptive",
    ]);
  });

  it("places map entries in PI canonical order regardless of key order", () => {
    const catalog: ThinkingCatalogEntry[] = [
      {
        id: "demo-model",
        provider: "demo",
        reasoning: true,
        compat: {
          reasoningEffortMap: {
            max: "max",
            high: "high",
            minimal: "minimal",
            low: "low",
            xhigh: "xhigh",
            medium: "medium",
          },
        },
      },
    ];
    expect(listThinkingLevelLabels("demo", "demo-model", catalog)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "adaptive",
    ]);
  });

  it("falls back to base levels when the model has no reasoningEffortMap", () => {
    const catalog: ThinkingCatalogEntry[] = [
      { id: "gpt-4.1-mini", provider: "openai", reasoning: true },
    ];
    // Backend contract: without a map, xhigh/max are denied by
    // `isElevatedThinkingDenied`, so the UI must not offer them either.
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini", catalog)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "adaptive",
    ]);
  });

  it("falls back to base levels when the map is all-null (no advertised level)", () => {
    const catalog: ThinkingCatalogEntry[] = [
      {
        id: "demo-model",
        provider: "demo",
        reasoning: true,
        compat: {
          reasoningEffortMap: {
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: null,
            max: null,
          },
        },
      },
    ];
    expect(listThinkingLevelLabels("demo", "demo-model", catalog)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "adaptive",
    ]);
  });

  it("falls back to base levels when the catalog is missing or the model is absent", () => {
    expect(listThinkingLevelLabels("openai", "gpt-5", null)).toEqual([...BASE_THINKING_LEVELS]);
    expect(listThinkingLevelLabels("openai", "gpt-5", undefined)).toEqual([
      ...BASE_THINKING_LEVELS,
    ]);
    expect(listThinkingLevelLabels("openai", "gpt-5", KIMI_K3_CATALOG)).toEqual([
      ...BASE_THINKING_LEVELS,
    ]);
    expect(listThinkingLevelLabels("cli-router", null, KIMI_K3_CATALOG)).toEqual([
      ...BASE_THINKING_LEVELS,
    ]);
  });

  it("matches the catalog case-insensitively", () => {
    expect(listThinkingLevelLabels("CLI-ROUTER", "KIMI-K3", KIMI_K3_CATALOG)).toEqual([
      "off",
      "low",
      "high",
      "max",
      "adaptive",
    ]);
  });

  it("returns binary levels for binary thinking providers regardless of catalog", () => {
    expect(listThinkingLevelLabels("zai", "glm-4.6", KIMI_K3_CATALOG)).toEqual(["off", "on"]);
  });
});

describe("formatThinkingLevels", () => {
  it("formats model-specific levels from the reasoningEffortMap", () => {
    expect(formatThinkingLevels("cli-router", "kimi-k3", KIMI_K3_CATALOG)).toBe(
      "off, low, high, max, adaptive",
    );
  });

  it("formats base levels without a map", () => {
    expect(formatThinkingLevels("openai", "gpt-5", null)).toBe(
      "off, minimal, low, medium, high, adaptive",
    );
  });
});

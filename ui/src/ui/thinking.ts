export type ThinkingCatalogEntry = {
  provider: string;
  id: string;
  reasoning?: boolean;
  compat?: { reasoningEffortMap?: Record<string, string | null> };
};

/** PI-style canonical order for map-driven thinking levels (mirrors backend `src/auto-reply/thinking.ts`). */
const PI_ORDERED_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const BASE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "adaptive"] as const;
const BINARY_THINKING_LEVELS = ["off", "on"] as const;
const ANTHROPIC_CLAUDE_46_MODEL_RE = /^claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i;
const AMAZON_BEDROCK_CLAUDE_46_MODEL_RE = /claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i;

export function normalizeThinkingProviderId(provider?: string | null): string {
  if (!provider) {
    return "";
  }
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  if (normalized === "bedrock" || normalized === "aws-bedrock") {
    return "amazon-bedrock";
  }
  return normalized;
}

export function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeThinkingProviderId(provider) === "zai";
}

export function normalizeThinkLevel(raw?: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  const key = raw.trim().toLowerCase();
  const collapsed = key.replace(/[\s_-]+/g, "");
  if (collapsed === "adaptive" || collapsed === "auto") {
    return "adaptive";
  }
  if (collapsed === "xhigh" || collapsed === "extrahigh") {
    return "xhigh";
  }
  if (collapsed === "max" || collapsed === "maximum") {
    return "max";
  }
  if (key === "off") {
    return "off";
  }
  if (["on", "enable", "enabled"].includes(key)) {
    return "low";
  }
  if (["min", "minimal"].includes(key)) {
    return "minimal";
  }
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key)) {
    return "low";
  }
  if (["mid", "med", "medium", "thinkharder", "think-harder", "harder"].includes(key)) {
    return "medium";
  }
  if (["high", "ultra", "ultrathink", "think-hard", "thinkhardest", "highest"].includes(key)) {
    return "high";
  }
  if (key === "think") {
    return "minimal";
  }
  return undefined;
}

export function listThinkingLevelLabels(
  provider?: string | null,
  model?: string | null,
  catalog?: ThinkingCatalogEntry[] | null,
): readonly string[] {
  if (isBinaryThinkingProvider(provider)) {
    return BINARY_THINKING_LEVELS;
  }
  const trimmedProvider = provider?.trim();
  const trimmedModel = model?.trim();
  if (trimmedProvider && trimmedModel && catalog) {
    const target = trimmedModel.toLowerCase();
    const entry = catalog.find(
      (candidate) =>
        candidate.provider.toLowerCase() === trimmedProvider.toLowerCase() &&
        candidate.id.toLowerCase() === target,
    );
    const map = entry?.compat?.reasoningEffortMap;
    if (map) {
      const present = PI_ORDERED_LEVELS.filter(
        (level) => Object.prototype.hasOwnProperty.call(map, level) && map[level] != null,
      );
      if (present.length > 0) {
        return ["off", ...present, "adaptive"];
      }
    }
  }
  return BASE_THINKING_LEVELS;
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  catalog?: ThinkingCatalogEntry[] | null,
): string {
  return listThinkingLevelLabels(provider, model, catalog).join(", ");
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}): string {
  const normalizedProvider = normalizeThinkingProviderId(params.provider);
  const modelId = params.model.trim();
  if (normalizedProvider === "anthropic" && ANTHROPIC_CLAUDE_46_MODEL_RE.test(modelId)) {
    return "adaptive";
  }
  if (normalizedProvider === "amazon-bedrock" && AMAZON_BEDROCK_CLAUDE_46_MODEL_RE.test(modelId)) {
    return "adaptive";
  }
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  return candidate?.reasoning ? "low" : "off";
}

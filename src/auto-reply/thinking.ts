import { normalizeProviderId } from "../agents/provider-id.js";
import { loadConfig } from "../config/config.js";
import {
  formatThinkingLevels as formatThinkingLevelsFallback,
  listThinkingLevelLabels as listThinkingLevelLabelsFallback,
  listThinkingLevels as listThinkingLevelsFallback,
  resolveThinkingDefaultForModel as resolveThinkingDefaultForModelFallback,
} from "./thinking.shared.js";
import type { ThinkLevel, ThinkingCatalogEntry } from "./thinking.shared.js";
export {
  formatMaxModelHint,
  formatXHighModelHint,
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeNoticeLevel,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
  normalizeVerboseLevel,
  resolveResponseUsageMode,
  resolveElevatedMode,
} from "./thinking.shared.js";
export type {
  ElevatedLevel,
  ElevatedMode,
  NoticeLevel,
  ReasoningLevel,
  ThinkLevel,
  ThinkingCatalogEntry,
  UsageDisplayLevel,
  VerboseLevel,
} from "./thinking.shared.js";
import {
  resolveProviderBinaryThinking,
  resolveProviderDefaultThinkingLevel,
  resolveProviderMaxThinking,
  resolveProviderXHighThinking,
} from "../plugins/provider-thinking.js";

export function isBinaryThinkingProvider(provider?: string | null, model?: string | null): boolean {
  const normalizedProvider = provider?.trim() ? normalizeProviderId(provider) : "";
  if (!normalizedProvider) {
    return false;
  }

  const pluginDecision = resolveProviderBinaryThinking({
    provider: normalizedProvider,
    context: {
      provider: normalizedProvider,
      modelId: model?.trim() ?? "",
    },
  });
  if (typeof pluginDecision === "boolean") {
    return pluginDecision;
  }
  return false;
}

export function supportsXHighThinking(provider?: string | null, model?: string | null): boolean {
  const modelKey = model?.trim().toLowerCase();
  if (!modelKey) {
    return false;
  }
  const providerKey = provider?.trim() ? normalizeProviderId(provider) : "";
  if (providerKey) {
    const pluginDecision = resolveProviderXHighThinking({
      provider: providerKey,
      context: {
        provider: providerKey,
        modelId: modelKey,
      },
    });
    if (typeof pluginDecision === "boolean") {
      return pluginDecision;
    }
  }
  return false;
}

export function supportsMaxThinking(provider?: string | null, model?: string | null): boolean {
  const modelKey = model?.trim().toLowerCase();
  if (!modelKey) {
    return false;
  }
  const providerKey = provider?.trim() ? normalizeProviderId(provider) : "";
  if (providerKey) {
    const pluginDecision = resolveProviderMaxThinking({
      provider: providerKey,
      context: {
        provider: providerKey,
        modelId: modelKey,
      },
    });
    if (typeof pluginDecision === "boolean") {
      return pluginDecision;
    }
  }
  // No explicit plugin opt-in: fall back to the model catalog's compat entry.
  // Any model that advertises `compat.supportsReasoningEffort: true` is
  // assumed to accept the highest wire value the SDK emits, which now
  // includes "max" (see openai-completions.reasoningEffort in pi-ai 0.84.2).
  // This unblocks the cli-router moonshotai/kimi-k3 path whose plugin slot
  // does not exist yet, without widening the surface for the openai provider
  // (which has its own explicit `supportsMaxThinking: () => false`).
  if (lookupModelCompatSupportsReasoningEffort(providerKey, modelKey)) {
    return true;
  }
  return false;
}

/**
 * Resolve whether a (provider, model) pair advertises the
 * `compat.supportsReasoningEffort` flag in the user config. The lookup is
 * performed against the loaded config's `models.providers.<id>.models[]`
 * entries, matching modelId case-insensitively. Returns `undefined` when
 * the model is not present (callers should treat that as "not opted in").
 */
function lookupModelCompatSupportsReasoningEffort(
  provider: string,
  model: string,
): boolean | undefined {
  if (!provider || !model) {
    return undefined;
  }
  try {
    const cfg = loadConfig();
    const providerEntry = (cfg.models?.providers ?? {})[provider];
    const models = providerEntry?.models;
    if (!Array.isArray(models)) {
      return undefined;
    }
    const target = model.toLowerCase();
    for (const m of models) {
      if (typeof m?.id === "string" && m.id.toLowerCase() === target) {
        const compat = m.compat ?? {};
        return typeof compat.supportsReasoningEffort === "boolean"
          ? compat.supportsReasoningEffort
          : undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns true when a `xhigh` or `max` directive is unsupported by the
 * configured (provider, model) pair. Centralises the down-or-reject decision
 * that was previously repeated as a ternary across multiple call sites.
 */
export function isElevatedThinkingDenied(
  level: ThinkLevel,
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  if (level === "xhigh") return !supportsXHighThinking(provider, model);
  if (level === "max") return !supportsMaxThinking(provider, model);
  return false;
}

export function listThinkingLevels(provider?: string | null, model?: string | null): ThinkLevel[] {
  const levels = listThinkingLevelsFallback(provider, model);
  const xhighIndex = levels.indexOf("xhigh");
  if (xhighIndex >= 0) {
    // xhigh is already injected by callers that opt-in via supportsXHighThinking.
    // Insert "max" right after xhigh when supportsMaxThinking opts in too.
    if (supportsMaxThinking(provider, model) && !levels.includes("max")) {
      levels.splice(xhighIndex + 1, 0, "max");
    }
    return levels;
  }
  // Backwards-compatible fallback: if no xhigh was injected yet, keep the
  // legacy "splice before adaptive" behaviour for xhigh itself, then layer
  // max in if it is opted in.
  if (supportsXHighThinking(provider, model)) {
    levels.splice(levels.length - 1, 0, "xhigh");
  }
  if (supportsMaxThinking(provider, model) && !levels.includes("max")) {
    const xhighInserted = levels.indexOf("xhigh");
    if (xhighInserted >= 0) {
      levels.splice(xhighInserted + 1, 0, "max");
    } else {
      levels.splice(levels.length - 1, 0, "max");
    }
  }
  return levels;
}

export function listThinkingLevelLabels(provider?: string | null, model?: string | null): string[] {
  if (isBinaryThinkingProvider(provider, model)) {
    return ["off", "on"];
  }
  return listThinkingLevelLabelsFallback(provider, model);
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
): string {
  return supportsXHighThinking(provider, model)
    ? listThinkingLevelLabels(provider, model).join(separator)
    : formatThinkingLevelsFallback(provider, model, separator);
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}): ThinkLevel {
  const normalizedProvider = normalizeProviderId(params.provider);
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  const pluginDecision = resolveProviderDefaultThinkingLevel({
    provider: normalizedProvider,
    context: {
      provider: normalizedProvider,
      modelId: params.model,
      reasoning: candidate?.reasoning,
    },
  });
  if (pluginDecision) {
    return pluginDecision;
  }
  return resolveThinkingDefaultForModelFallback(params);
}

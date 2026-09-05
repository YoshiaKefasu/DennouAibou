import { getCachedModelCatalogSync } from "../agents/model-catalog.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { loadConfig } from "../config/config.js";
import type { ReasoningEffortMap } from "../config/types.models.js";
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
} from "../plugins/provider-thinking.js";

/**
 * PI-style canonical order for non-base thinking levels. The map-driven
 * `listThinkingLevels` walks this order, dropping entries whose value is
 * `null` (or missing) in the resolved `reasoningEffortMap`.
 */
const PI_ORDERED_LEVELS: readonly ThinkLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Levels that are *always* present in the choices regardless of map presence
 * (placed at the start of the list).
 */
const ALWAYS_LEADING_LEVELS: readonly ThinkLevel[] = ["off"];

/**
 * Levels that are *always* present in the choices regardless of map presence
 * (placed at the end of the list, after the PI-ordered non-null map entries).
 */
const ALWAYS_TRAILING_LEVELS: readonly ThinkLevel[] = ["adaptive"];

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

/**
 * Looks up the per-model `compat.reasoningEffortMap` from the loaded config
 * and, as a fallback, from the cached runtime model catalog. The map is the
 * single source of truth for which thinking levels a model advertises and
 * what wire value each one resolves to. Returns `undefined` when the model is
 * not found in either source (the caller should then fall back to base
 * levels and deny elevated reasoning).
 */
function lookupModelReasoningEffortMap(
  provider: string,
  model: string,
): ReasoningEffortMap | undefined {
  const trimmedProvider = provider?.trim();
  const trimmedModel = model?.trim();
  if (!trimmedProvider || !trimmedModel) {
    return undefined;
  }
  const target = trimmedModel.toLowerCase();
  const fromConfig = (): ReasoningEffortMap | undefined => {
    try {
      const cfg = loadConfig();
      const providerEntry = (cfg.models?.providers ?? {})[trimmedProvider];
      const models = providerEntry?.models;
      if (!Array.isArray(models)) {
        return undefined;
      }
      for (const m of models) {
        if (typeof m?.id === "string" && m.id.toLowerCase() === target) {
          return m.compat?.reasoningEffortMap;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  };
  const fromRuntimeCatalog = (): ReasoningEffortMap | undefined => {
    try {
      const catalog = getCachedModelCatalogSync();
      if (!catalog) {
        return undefined;
      }
      for (const entry of catalog) {
        if (
          entry.provider.toLowerCase() === trimmedProvider.toLowerCase() &&
          entry.id.toLowerCase() === target
        ) {
          return entry.compat?.reasoningEffortMap;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  };
  // Config wins over runtime catalog (config is explicit override).
  return fromConfig() ?? fromRuntimeCatalog();
}

/**
 * Returns the set of `ThinkLevel`s the model advertises via its map
 * (non-null entries, in PI canonical order). Returns `undefined` when the
 * model has no map — callers should treat that as "base levels only".
 */
function resolveMapLevels(provider: string, model: string): readonly ThinkLevel[] | undefined {
  const map = lookupModelReasoningEffortMap(provider, model);
  if (!map) {
    return undefined;
  }
  const present: ThinkLevel[] = [];
  for (const level of PI_ORDERED_LEVELS) {
    if (Object.prototype.hasOwnProperty.call(map, level) && map[level] != null) {
      present.push(level);
    }
  }
  return present;
}

/**
 * Returns the wire value the model declares for `level`, or `null` if the
 * level is declared-but-unsupported, or `undefined` if the level is not in
 * the map at all (caller should treat as unsupported).
 */
function resolveMapWire(
  provider: string,
  model: string,
  level: ThinkLevel,
): string | null | undefined {
  const map = lookupModelReasoningEffortMap(provider, model);
  if (!map || !Object.prototype.hasOwnProperty.call(map, level)) {
    return undefined;
  }
  return map[level] ?? null;
}

// Note: `resolveMapReasoningEffort` previously lived here as a thin wrapper
// around `resolveMapWire` for the openai transport. The transport now uses
// its own `mapReasoningEffort` (in `src/agents/openai-transport-stream.ts`)
// and reads `compat.reasoningEffortMap` directly from the model, so the
// wrapper has no remaining callers and was removed. Keep `resolveMapWire`
// module-private since it is only consumed by `isElevatedThinkingDenied`.

/**
 * Returns true when a `xhigh` or `max` directive is unsupported by the
 * configured (provider, model) pair. With map-driven resolution, a model
 * declares `null` for levels it cannot serve, so this is just a check
 * against the map (or "no map" for backward-compatible models without
 * explicit policy).
 */
export function isElevatedThinkingDenied(
  level: ThinkLevel,
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  if (level === "xhigh" || level === "max") {
    const wire = resolveMapWire(provider ?? "", model ?? "", level);
    if (wire === undefined) {
      // Model has no map (or the map does not mention this level at all):
      // back-compat default — deny the elevated level. Models that want to
      // advertise it must declare it in their reasoningEffortMap.
      return true;
    }
    return wire === null;
  }
  return false;
}

export function listThinkingLevels(provider?: string | null, model?: string | null): ThinkLevel[] {
  const mapLevels = resolveMapLevels(provider ?? "", model ?? "");
  if (mapLevels) {
    return [...ALWAYS_LEADING_LEVELS, ...mapLevels, ...ALWAYS_TRAILING_LEVELS];
  }
  // Backwards-compatible fallback: no map → base levels only.
  return listThinkingLevelsFallback(provider, model);
}

export function listThinkingLevelLabels(provider?: string | null, model?: string | null): string[] {
  if (isBinaryThinkingProvider(provider, model)) {
    return ["off", "on"];
  }
  return listThinkingLevels(provider, model);
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
): string {
  // Map-driven models and back-compat models both use listThinkingLevelLabels
  // so we no longer need the supportsXHighThinking gate. formatThinkingLevels
  // in thinking.shared is kept as a fallback for callers that still ask for
  // the non-pi-ordered list.
  return listThinkingLevelLabels(provider, model).join(separator);
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

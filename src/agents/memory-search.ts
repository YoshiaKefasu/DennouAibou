import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, MemorySearchConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { SecretInput } from "../config/types.secrets.js";
import { getMemoryEmbeddingProvider } from "../plugins/memory-embedding-provider-runtime.js";
import { clampInt, clampNumber, resolveUserPath } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope.js";

const MEMORY_MULTIMODAL_SPECS = {
  image: {
    labelPrefix: "Image file",
    extensions: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"],
  },
  audio: {
    labelPrefix: "Audio file",
    extensions: [".mp3", ".wav", ".ogg", ".opus", ".m4a", ".aac", ".flac"],
  },
} as const;

export type MemoryMultimodalModality = keyof typeof MEMORY_MULTIMODAL_SPECS;
export const MEMORY_MULTIMODAL_MODALITIES = Object.keys(
  MEMORY_MULTIMODAL_SPECS,
) as MemoryMultimodalModality[];
export type MemoryMultimodalSelection = MemoryMultimodalModality | "all";

export type MemoryMultimodalSettings = {
  enabled: boolean;
  modalities: MemoryMultimodalModality[];
  maxFileBytes: number;
};

export const DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES = 10 * 1024 * 1024;

export function normalizeMemoryMultimodalModalities(
  raw: MemoryMultimodalSelection[] | undefined,
): MemoryMultimodalModality[] {
  if (raw === undefined || raw.includes("all")) {
    return [...MEMORY_MULTIMODAL_MODALITIES];
  }
  const normalized = new Set<MemoryMultimodalModality>();
  for (const value of raw) {
    if (value === "image" || value === "audio") {
      normalized.add(value);
    }
  }
  return Array.from(normalized);
}

export function normalizeMemoryMultimodalSettings(raw: {
  enabled?: boolean;
  modalities?: MemoryMultimodalSelection[];
  maxFileBytes?: number;
}): MemoryMultimodalSettings {
  const enabled = raw.enabled === true;
  const maxFileBytes =
    typeof raw.maxFileBytes === "number" && Number.isFinite(raw.maxFileBytes)
      ? Math.max(1, Math.floor(raw.maxFileBytes))
      : DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES;
  return {
    enabled,
    modalities: enabled ? normalizeMemoryMultimodalModalities(raw.modalities) : [],
    maxFileBytes,
  };
}

export function isMemoryMultimodalEnabled(settings: MemoryMultimodalSettings): boolean {
  return settings.enabled && settings.modalities.length > 0;
}

export function normalizeGeminiEmbeddingModelForMemory(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^models\//, "").replace(/^(gemini|google)\//, "");
}

export function supportsMemoryMultimodalEmbeddings(params: {
  provider: string;
  model: string;
}): boolean {
  if (params.provider !== "gemini") {
    return false;
  }
  return normalizeGeminiEmbeddingModelForMemory(params.model) === "gemini-embedding-2-preview";
}

export type ResolvedMemorySearchConfig = {
  enabled: boolean;
  sources: Array<"memory" | "sessions">;
  extraPaths: string[];
  multimodal: MemoryMultimodalSettings;
  provider: string;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
    batch?: {
      enabled: boolean;
      wait: boolean;
      concurrency: number;
      pollIntervalMs: number;
      timeoutMinutes: number;
    };
  };
  experimental: {
    sessionMemory: boolean;
  };
  fallback: string;
  model: string;
  outputDimensionality?: number;
  local: {
    modelPath?: string;
    modelCacheDir?: string;
  };
  store: {
    driver: "sqlite";
    path: string;
    fts: {
      tokenizer: "unicode61" | "trigram";
    };
    vector: {
      enabled: boolean;
      extensionPath?: string;
    };
  };
  chunking: {
    tokens: number;
    overlap: number;
  };
  sync: {
    onSessionStart: boolean;
    onSearch: boolean;
    watch: boolean;
    watchDebounceMs: number;
    intervalMinutes: number;
    sessions: {
      deltaBytes: number;
      deltaMessages: number;
      postCompactionForce: boolean;
    };
  };
  query: {
    maxResults: number;
    minScore: number;
    hybrid: {
      enabled: boolean;
      vectorWeight: number;
      textWeight: number;
      candidateMultiplier: number;
      mmr: {
        enabled: boolean;
        lambda: number;
      };
      temporalDecay: {
        enabled: boolean;
        halfLifeDays: number;
      };
    };
  };
  cache: {
    enabled: boolean;
    maxEntries?: number;
  };
};

const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_CHUNK_OVERLAP = 80;
const DEFAULT_WATCH_DEBOUNCE_MS = 1500;
const DEFAULT_SESSION_DELTA_BYTES = 100_000;
const DEFAULT_SESSION_DELTA_MESSAGES = 50;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_HYBRID_ENABLED = true;
const DEFAULT_HYBRID_VECTOR_WEIGHT = 0.7;
const DEFAULT_HYBRID_TEXT_WEIGHT = 0.3;
const DEFAULT_HYBRID_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_MMR_ENABLED = false;
const DEFAULT_MMR_LAMBDA = 0.7;
const DEFAULT_TEMPORAL_DECAY_ENABLED = false;
const DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS = 30;
const DEFAULT_CACHE_ENABLED = true;
const DEFAULT_SOURCES: Array<"memory" | "sessions"> = ["memory"];

function normalizeSources(
  sources: Array<"memory" | "sessions"> | undefined,
  sessionMemoryEnabled: boolean,
): Array<"memory" | "sessions"> {
  const normalized = new Set<"memory" | "sessions">();
  const input = sources?.length ? sources : DEFAULT_SOURCES;
  for (const source of input) {
    if (source === "memory") {
      normalized.add("memory");
    }
    if (source === "sessions" && sessionMemoryEnabled) {
      normalized.add("sessions");
    }
  }
  if (normalized.size === 0) {
    normalized.add("memory");
  }
  return Array.from(normalized);
}

function resolveStorePath(agentId: string, raw?: string): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  const fallback = path.join(stateDir, "memory", `${agentId}.sqlite`);
  if (!raw) {
    return fallback;
  }
  const withToken = raw.includes("{agentId}") ? raw.replaceAll("{agentId}", agentId) : raw;
  return resolveUserPath(withToken);
}

function mergeConfig(
  defaults: MemorySearchConfig | undefined,
  overrides: MemorySearchConfig | undefined,
  agentId: string,
): ResolvedMemorySearchConfig {
  const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
  const sessionMemory =
    overrides?.experimental?.sessionMemory ?? defaults?.experimental?.sessionMemory ?? false;
  const provider = overrides?.provider ?? defaults?.provider ?? "auto";
  const primaryAdapter = provider === "auto" ? undefined : getMemoryEmbeddingProvider(provider);
  const defaultRemote = defaults?.remote;
  const overrideRemote = overrides?.remote;
  const fallback = overrides?.fallback ?? defaults?.fallback ?? "none";
  const fallbackAdapter =
    fallback && fallback !== "none" ? getMemoryEmbeddingProvider(fallback) : undefined;
  const hasRemoteConfig = Boolean(
    overrideRemote?.baseUrl ||
    overrideRemote?.apiKey ||
    overrideRemote?.headers ||
    defaultRemote?.baseUrl ||
    defaultRemote?.apiKey ||
    defaultRemote?.headers,
  );
  const includeRemote =
    hasRemoteConfig ||
    provider === "auto" ||
    primaryAdapter?.transport !== "local" ||
    fallbackAdapter?.transport === "remote";
  const batch = {
    enabled: overrideRemote?.batch?.enabled ?? defaultRemote?.batch?.enabled ?? false,
    wait: overrideRemote?.batch?.wait ?? defaultRemote?.batch?.wait ?? true,
    concurrency: Math.max(
      1,
      overrideRemote?.batch?.concurrency ?? defaultRemote?.batch?.concurrency ?? 2,
    ),
    pollIntervalMs:
      overrideRemote?.batch?.pollIntervalMs ?? defaultRemote?.batch?.pollIntervalMs ?? 2000,
    timeoutMinutes:
      overrideRemote?.batch?.timeoutMinutes ?? defaultRemote?.batch?.timeoutMinutes ?? 60,
  };
  const remote = includeRemote
    ? {
        baseUrl: overrideRemote?.baseUrl ?? defaultRemote?.baseUrl,
        apiKey: overrideRemote?.apiKey ?? defaultRemote?.apiKey,
        headers: overrideRemote?.headers ?? defaultRemote?.headers,
        batch,
      }
    : undefined;
  const modelDefault = provider === "auto" ? undefined : primaryAdapter?.defaultModel;
  const model = overrides?.model ?? defaults?.model ?? modelDefault ?? "";
  const outputDimensionality = overrides?.outputDimensionality ?? defaults?.outputDimensionality;
  const local = {
    modelPath: overrides?.local?.modelPath ?? defaults?.local?.modelPath,
    modelCacheDir: overrides?.local?.modelCacheDir ?? defaults?.local?.modelCacheDir,
  };
  const sources = normalizeSources(overrides?.sources ?? defaults?.sources, sessionMemory);
  const rawPaths = [...(defaults?.extraPaths ?? []), ...(overrides?.extraPaths ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);
  const extraPaths = Array.from(new Set(rawPaths));
  const multimodal = normalizeMemoryMultimodalSettings({
    enabled: overrides?.multimodal?.enabled ?? defaults?.multimodal?.enabled,
    modalities: overrides?.multimodal?.modalities ?? defaults?.multimodal?.modalities,
    maxFileBytes: overrides?.multimodal?.maxFileBytes ?? defaults?.multimodal?.maxFileBytes,
  });
  const vector = {
    enabled: overrides?.store?.vector?.enabled ?? defaults?.store?.vector?.enabled ?? true,
    extensionPath:
      overrides?.store?.vector?.extensionPath ?? defaults?.store?.vector?.extensionPath,
  };
  const fts = {
    tokenizer: overrides?.store?.fts?.tokenizer ?? defaults?.store?.fts?.tokenizer ?? "unicode61",
  };
  const store = {
    driver: overrides?.store?.driver ?? defaults?.store?.driver ?? "sqlite",
    path: resolveStorePath(agentId, overrides?.store?.path ?? defaults?.store?.path),
    fts,
    vector,
  };
  const chunking = {
    tokens: overrides?.chunking?.tokens ?? defaults?.chunking?.tokens ?? DEFAULT_CHUNK_TOKENS,
    overlap: overrides?.chunking?.overlap ?? defaults?.chunking?.overlap ?? DEFAULT_CHUNK_OVERLAP,
  };
  const sync = {
    onSessionStart: overrides?.sync?.onSessionStart ?? defaults?.sync?.onSessionStart ?? true,
    onSearch: overrides?.sync?.onSearch ?? defaults?.sync?.onSearch ?? true,
    watch: overrides?.sync?.watch ?? defaults?.sync?.watch ?? true,
    watchDebounceMs:
      overrides?.sync?.watchDebounceMs ??
      defaults?.sync?.watchDebounceMs ??
      DEFAULT_WATCH_DEBOUNCE_MS,
    intervalMinutes: overrides?.sync?.intervalMinutes ?? defaults?.sync?.intervalMinutes ?? 0,
    sessions: {
      deltaBytes:
        overrides?.sync?.sessions?.deltaBytes ??
        defaults?.sync?.sessions?.deltaBytes ??
        DEFAULT_SESSION_DELTA_BYTES,
      deltaMessages:
        overrides?.sync?.sessions?.deltaMessages ??
        defaults?.sync?.sessions?.deltaMessages ??
        DEFAULT_SESSION_DELTA_MESSAGES,
      postCompactionForce:
        overrides?.sync?.sessions?.postCompactionForce ??
        defaults?.sync?.sessions?.postCompactionForce ??
        true,
    },
  };
  const query = {
    maxResults: overrides?.query?.maxResults ?? defaults?.query?.maxResults ?? DEFAULT_MAX_RESULTS,
    minScore: overrides?.query?.minScore ?? defaults?.query?.minScore ?? DEFAULT_MIN_SCORE,
  };
  const hybrid = {
    enabled:
      overrides?.query?.hybrid?.enabled ??
      defaults?.query?.hybrid?.enabled ??
      DEFAULT_HYBRID_ENABLED,
    vectorWeight:
      overrides?.query?.hybrid?.vectorWeight ??
      defaults?.query?.hybrid?.vectorWeight ??
      DEFAULT_HYBRID_VECTOR_WEIGHT,
    textWeight:
      overrides?.query?.hybrid?.textWeight ??
      defaults?.query?.hybrid?.textWeight ??
      DEFAULT_HYBRID_TEXT_WEIGHT,
    candidateMultiplier:
      overrides?.query?.hybrid?.candidateMultiplier ??
      defaults?.query?.hybrid?.candidateMultiplier ??
      DEFAULT_HYBRID_CANDIDATE_MULTIPLIER,
    mmr: {
      enabled:
        overrides?.query?.hybrid?.mmr?.enabled ??
        defaults?.query?.hybrid?.mmr?.enabled ??
        DEFAULT_MMR_ENABLED,
      lambda:
        overrides?.query?.hybrid?.mmr?.lambda ??
        defaults?.query?.hybrid?.mmr?.lambda ??
        DEFAULT_MMR_LAMBDA,
    },
    temporalDecay: {
      enabled:
        overrides?.query?.hybrid?.temporalDecay?.enabled ??
        defaults?.query?.hybrid?.temporalDecay?.enabled ??
        DEFAULT_TEMPORAL_DECAY_ENABLED,
      halfLifeDays:
        overrides?.query?.hybrid?.temporalDecay?.halfLifeDays ??
        defaults?.query?.hybrid?.temporalDecay?.halfLifeDays ??
        DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS,
    },
  };
  const cache = {
    enabled: overrides?.cache?.enabled ?? defaults?.cache?.enabled ?? DEFAULT_CACHE_ENABLED,
    maxEntries: overrides?.cache?.maxEntries ?? defaults?.cache?.maxEntries,
  };

  const overlap = clampNumber(chunking.overlap, 0, Math.max(0, chunking.tokens - 1));
  const minScore = clampNumber(query.minScore, 0, 1);
  const vectorWeight = clampNumber(hybrid.vectorWeight, 0, 1);
  const textWeight = clampNumber(hybrid.textWeight, 0, 1);
  const sum = vectorWeight + textWeight;
  const normalizedVectorWeight = sum > 0 ? vectorWeight / sum : DEFAULT_HYBRID_VECTOR_WEIGHT;
  const normalizedTextWeight = sum > 0 ? textWeight / sum : DEFAULT_HYBRID_TEXT_WEIGHT;
  const candidateMultiplier = clampInt(hybrid.candidateMultiplier, 1, 20);
  const temporalDecayHalfLifeDays = Math.max(
    1,
    Math.floor(
      Number.isFinite(hybrid.temporalDecay.halfLifeDays)
        ? hybrid.temporalDecay.halfLifeDays
        : DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS,
    ),
  );
  const deltaBytes = clampInt(sync.sessions.deltaBytes, 0, Number.MAX_SAFE_INTEGER);
  const deltaMessages = clampInt(sync.sessions.deltaMessages, 0, Number.MAX_SAFE_INTEGER);
  const postCompactionForce = sync.sessions.postCompactionForce;
  return {
    enabled,
    sources,
    extraPaths,
    multimodal,
    provider,
    remote,
    experimental: {
      sessionMemory,
    },
    fallback,
    model,
    outputDimensionality,
    local,
    store,
    chunking: { tokens: Math.max(1, chunking.tokens), overlap },
    sync: {
      ...sync,
      sessions: {
        deltaBytes,
        deltaMessages,
        postCompactionForce,
      },
    },
    query: {
      ...query,
      minScore,
      hybrid: {
        enabled: Boolean(hybrid.enabled),
        vectorWeight: normalizedVectorWeight,
        textWeight: normalizedTextWeight,
        candidateMultiplier,
        mmr: {
          enabled: Boolean(hybrid.mmr.enabled),
          lambda: Number.isFinite(hybrid.mmr.lambda)
            ? Math.max(0, Math.min(1, hybrid.mmr.lambda))
            : DEFAULT_MMR_LAMBDA,
        },
        temporalDecay: {
          enabled: Boolean(hybrid.temporalDecay.enabled),
          halfLifeDays: temporalDecayHalfLifeDays,
        },
      },
    },
    cache: {
      enabled: Boolean(cache.enabled),
      maxEntries:
        typeof cache.maxEntries === "number" && Number.isFinite(cache.maxEntries)
          ? Math.max(1, Math.floor(cache.maxEntries))
          : undefined,
    },
  };
}

export function resolveMemorySearchConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedMemorySearchConfig | null {
  const defaults = cfg.agents?.defaults?.memorySearch;
  const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
  const resolved = mergeConfig(defaults, overrides, agentId);
  if (!resolved.enabled) {
    return null;
  }
  const multimodalActive = isMemoryMultimodalEnabled(resolved.multimodal);
  const multimodalProvider =
    resolved.provider === "auto" ? undefined : getMemoryEmbeddingProvider(resolved.provider);
  const builtinMultimodalSupport =
    resolved.provider === "auto"
      ? false
      : supportsMemoryMultimodalEmbeddings({
          provider: resolved.provider,
          model: resolved.model,
        });
  if (
    multimodalActive &&
    !(
      // Fall back to the built-in helper when the provider is not registered yet
      // or when a registered adapter does not implement multimodal capability checks.
      (
        multimodalProvider?.supportsMultimodalEmbeddings?.({
          model: resolved.model,
        }) ?? builtinMultimodalSupport
      )
    )
  ) {
    throw new Error(
      "agents.*.memorySearch.multimodal requires a provider adapter that supports multimodal embeddings for the configured model.",
    );
  }
  if (multimodalActive && resolved.fallback !== "none") {
    throw new Error(
      'agents.*.memorySearch.multimodal does not support memorySearch.fallback. Set fallback to "none".',
    );
  }
  return resolved;
}

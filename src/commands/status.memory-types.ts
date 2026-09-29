// Local memory-status types.
// Type-only: behavior is unchanged.

export type Tone = "ok" | "warn" | "muted";

export type MemorySource = "memory" | "sessions";

export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
};

export type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

export type MemoryProviderStatus = {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  extraPaths?: string[];
  sources?: MemorySource[];
  sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>;
  cache?: { enabled: boolean; entries?: number; maxEntries?: number };
  fts?: { enabled: boolean; available: boolean; error?: string };
  fallback?: { from: string; reason?: string };
  vector?: {
    enabled: boolean;
    available?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  batch?: {
    enabled: boolean;
    failures: number;
    limit: number;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    lastError?: string;
    lastProvider?: string;
  };
  custom?: Record<string, unknown>;
};

export type EmbeddingInputTextPart = {
  type: "text";
  text: string;
};

export type EmbeddingInputInlineDataPart = {
  type: "inline-data";
  mimeType: string;
  data: string;
};

export type EmbeddingInputPart = EmbeddingInputTextPart | EmbeddingInputInlineDataPart;

export type EmbeddingInput = {
  text: string;
  parts?: EmbeddingInputPart[];
};

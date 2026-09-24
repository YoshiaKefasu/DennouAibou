import { defineConfig } from "vitest/config";
import { narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { sharedVitestConfig } from "./vitest.shared.config.ts";

function normalizePathPattern(value: string): string {
  return value.replaceAll("\\", "/");
}

function relativizeScopedPattern(value: string, dir: string): string {
  const normalizedValue = normalizePathPattern(value);
  const normalizedDir = normalizePathPattern(dir).replace(/\/+$/u, "");
  if (!normalizedDir) {
    return normalizedValue;
  }
  if (normalizedValue === normalizedDir) {
    return ".";
  }
  const prefix = `${normalizedDir}/`;
  return normalizedValue.startsWith(prefix)
    ? normalizedValue.slice(prefix.length)
    : normalizedValue;
}

function relativizeScopedPatterns(values: string[], dir?: string): string[] {
  if (!dir) {
    return values.map(normalizePathPattern);
  }
  return values.map((value) => relativizeScopedPattern(value, dir));
}

export function resolveVitestIsolation(
  _env: Record<string, string | undefined> = process.env,
): boolean {
  return false;
}

/**
 * Stable per-project `sequence.groupOrder` assignments.
 * Note: vitest throws when projects share a groupOrder but resolve different
 * maxWorkers (host-load-dependent scheduling can diverge per lane). Unique
 * orders isolate each lane so worker-count drift never blocks a run.
 * New lanes not listed here fall back to a name-derived order; verify with
 * `resolveScopedGroupOrder` when adding a project.
 */
export const SCOPED_GROUP_ORDER: Record<string, number> = {
  unit: 1,
  infra: 2,
  boundary: 3,
  contracts: 4,
  bundled: 5,
  gateway: 6,
  hooks: 7,
  "runtime-config": 8,
  secrets: 9,
  cli: 10,
  commands: 11,
  "auto-reply": 12,
  agents: 13,
  daemon: 14,
  media: 15,
  "plugin-sdk": 16,
  plugins: 17,
  logging: 18,
  process: 19,
  cron: 20,
  "media-understanding": 21,
  "shared-core": 22,
  tooling: 23,
  tui: 24,
  ui: 25,
  utils: 26,
  wizard: 27,
  channels: 28,
  "extension-channels": 29,
  "extension-diffs": 30,
  "extension-mattermost": 31,
  "extension-memory": 32,
  "extension-msteams": 33,
  "extension-messaging": 34,
  "extension-providers": 35,
  "extension-telegram": 36,
  "extension-voice-call": 37,
  extensions: 38,
};
export function resolveScopedGroupOrder(name: string | undefined): number {
  if (!name) {
    return 0;
  }
  const assigned = SCOPED_GROUP_ORDER[name];
  if (assigned !== undefined) {
    return assigned;
  }
  let hash = 5381;
  for (const char of name) {
    hash = ((hash << 5) + hash + (char.codePointAt(0) ?? 0)) | 0;
  }
  // Fallback lane: offset past the table to avoid colliding with it.
  return (Math.abs(hash) % 9000) + 1001;
}

export function createScopedVitestConfig(
  include: string[],
  options?: {
    deps?: Record<string, unknown>;
    dir?: string;
    env?: Record<string, string | undefined>;
    environment?: string;
    exclude?: string[];
    argv?: string[];
    includeOpenClawRuntimeSetup?: boolean;
    isolate?: boolean;
    name?: string;
    pool?: "forks" | "threads";
    passWithNoTests?: boolean;
    groupOrder?: number;
    setupFiles?: string[];
    useNonIsolatedRunner?: boolean;
  },
) {
  const base = sharedVitestConfig as Record<string, unknown>;
  const baseTest = sharedVitestConfig.test ?? {};
  const scopedDir = options?.dir;
  const cliInclude = narrowIncludePatternsForCli(include, options?.argv);
  const exclude = relativizeScopedPatterns(
    [...(baseTest.exclude ?? []), ...(options?.exclude ?? [])],
    scopedDir,
  );
  const isolate = options?.isolate ?? resolveVitestIsolation(options?.env);
  const setupFiles = [
    ...new Set([
      ...(baseTest.setupFiles ?? []),
      ...(options?.setupFiles ?? []),
      ...(options?.includeOpenClawRuntimeSetup === false ? [] : ["test/setup-openclaw-runtime.ts"]),
    ]),
  ];
  const useNonIsolatedRunner = options?.useNonIsolatedRunner ?? !isolate;
  const runner = useNonIsolatedRunner ? "./test/non-isolated-runner.ts" : undefined;

  return defineConfig({
    ...base,
    test: {
      ...baseTest,
      ...(options?.deps ? { deps: options.deps } : {}),
      ...(options?.name ? { name: options.name } : {}),
      ...(options?.environment ? { environment: options.environment } : {}),
      isolate,
      ...(runner ? { runner } : { runner: undefined }),
      setupFiles,
      ...(scopedDir ? { dir: scopedDir } : {}),
      include: relativizeScopedPatterns(cliInclude ?? include, scopedDir),
      exclude,
      ...(options?.pool ? { pool: options.pool } : {}),
      sequence: {
        groupOrder: options?.groupOrder ?? resolveScopedGroupOrder(options?.name),
      },
      ...(options?.passWithNoTests !== undefined || cliInclude !== null
        ? { passWithNoTests: options?.passWithNoTests ?? true }
        : {}),
    },
  });
}

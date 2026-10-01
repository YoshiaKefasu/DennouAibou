import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openBoundaryFile } from "../infra/boundary-file-read.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { resolveWorkspaceTemplateDir } from "./workspace-templates.js";

export function resolveDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const home = resolveRequiredHomeDir(env, homedir);
  const profile = env.DENNOU_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(home, ".openclaw", `workspace-${profile}`);
  }
  return path.join(home, ".openclaw", "workspace");
}

// Safe: `process` may be undefined in browser bundles that pull this module in.
export const DEFAULT_AGENT_WORKSPACE_DIR: string = (() => {
  try {
    return resolveDefaultAgentWorkspaceDir();
  } catch {
    return "";
  }
})();
const DEFAULT_HABITS_FILENAME = "HABITS.md";
export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";
// Optional JSON config that controls which workspace Markdown files are loaded into the
// prompt and in what order. `context-files.json` wins over `prompt-files.json` when both exist.
export const CONTEXT_FILES_CONFIG_FILENAME = "context-files.json";
export const CONTEXT_FILES_CONFIG_ALT_FILENAME = "prompt-files.json";
const WORKSPACE_STATE_DIRNAME = ".openclaw";
const WORKSPACE_STATE_FILENAME = "workspace-state.json";
const WORKSPACE_STATE_VERSION = 1;

const workspaceTemplateCache = new Map<string, Promise<string>>();
let gitAvailabilityPromise: Promise<boolean> | null = null;
const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024;

// File content cache keyed by stable file identity to avoid stale reads.
const workspaceFileCache = new Map<string, { content: string; identity: string }>();

/**
 * Read workspace files via boundary-safe open and cache by inode/dev/size/mtime identity.
 */
type WorkspaceGuardedReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: "path" | "validation" | "io"; error?: unknown };

function workspaceFileIdentity(stat: syncFs.Stats, canonicalPath: string): string {
  return `${canonicalPath}|${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

async function readWorkspaceFileWithGuards(params: {
  filePath: string;
  workspaceDir: string;
}): Promise<WorkspaceGuardedReadResult> {
  const opened = await openBoundaryFile({
    absolutePath: params.filePath,
    rootPath: params.workspaceDir,
    boundaryLabel: "workspace root",
    maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  });
  if (!opened.ok) {
    workspaceFileCache.delete(params.filePath);
    return opened;
  }

  const identity = workspaceFileIdentity(opened.stat, opened.path);
  const cached = workspaceFileCache.get(params.filePath);
  if (cached && cached.identity === identity) {
    syncFs.closeSync(opened.fd);
    return { ok: true, content: cached.content };
  }

  try {
    const content = syncFs.readFileSync(opened.fd, "utf-8");
    workspaceFileCache.set(params.filePath, { content, identity });
    return { ok: true, content };
  } catch (error) {
    workspaceFileCache.delete(params.filePath);
    return { ok: false, reason: "io", error };
  } finally {
    syncFs.closeSync(opened.fd);
  }
}

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return content;
  }
  const start = endIndex + "\n---".length;
  let trimmed = content.slice(start);
  trimmed = trimmed.replace(/^\s+/, "");
  return trimmed;
}

async function loadTemplate(name: string): Promise<string> {
  const cached = workspaceTemplateCache.get(name);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const templateDir = await resolveWorkspaceTemplateDir();
    const templatePath = path.join(templateDir, name);
    try {
      const content = await fs.readFile(templatePath, "utf-8");
      return stripFrontMatter(content);
    } catch {
      throw new Error(
        `Missing workspace template: ${name} (${templatePath}). Ensure docs/reference/templates are packaged.`,
      );
    }
  })();

  workspaceTemplateCache.set(name, pending);
  try {
    return await pending;
  } catch (error) {
    workspaceTemplateCache.delete(name);
    throw error;
  }
}

export type WorkspaceBootstrapFileName =
  | typeof DEFAULT_HABITS_FILENAME
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME
  | typeof DEFAULT_IDENTITY_FILENAME
  | typeof DEFAULT_USER_FILENAME
  | typeof DEFAULT_BOOTSTRAP_FILENAME
  | typeof DEFAULT_MEMORY_FILENAME
  | typeof DEFAULT_MEMORY_ALT_FILENAME;

export type WorkspaceBootstrapFile = {
  /** Basename of the file, e.g. "AGENTS.md" or a custom file such as "CUSTOM.md". */
  name: string;
  path: string;
  content?: string;
  missing: boolean;
  /**
   * Explicit prompt priority from `context-files.json` / `prompt-files.json`
   * (smaller number = earlier in the prompt). Undefined means "use the default order".
   */
  priority?: number;
};

export type ContextFilesConfigEntry = {
  file: string;
  priority?: number;
};

export type ExtraBootstrapLoadDiagnosticCode =
  | "invalid-bootstrap-filename"
  | "missing"
  | "security"
  | "io";

export type ExtraBootstrapLoadDiagnostic = {
  path: string;
  reason: ExtraBootstrapLoadDiagnosticCode;
  detail: string;
};

type WorkspaceSetupState = {
  version: typeof WORKSPACE_STATE_VERSION;
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
};

/** Set of recognized bootstrap filenames for runtime validation */
const VALID_BOOTSTRAP_NAMES: ReadonlySet<string> = new Set([
  DEFAULT_HABITS_FILENAME,
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
]);

async function writeFileIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
    return true;
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "EEXIST") {
      throw err;
    }
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveWorkspaceStatePath(dir: string): string {
  return path.join(dir, WORKSPACE_STATE_DIRNAME, WORKSPACE_STATE_FILENAME);
}

function parseWorkspaceSetupState(raw: string): WorkspaceSetupState | null {
  try {
    const parsed = JSON.parse(raw) as {
      bootstrapSeededAt?: unknown;
      setupCompletedAt?: unknown;
      onboardingCompletedAt?: unknown;
    };
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const legacyCompletedAt =
      typeof parsed.onboardingCompletedAt === "string" ? parsed.onboardingCompletedAt : undefined;
    return {
      version: WORKSPACE_STATE_VERSION,
      bootstrapSeededAt:
        typeof parsed.bootstrapSeededAt === "string" ? parsed.bootstrapSeededAt : undefined,
      setupCompletedAt:
        typeof parsed.setupCompletedAt === "string" ? parsed.setupCompletedAt : legacyCompletedAt,
    };
  } catch {
    return null;
  }
}

async function readWorkspaceSetupState(statePath: string): Promise<WorkspaceSetupState> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = parseWorkspaceSetupState(raw);
    if (
      parsed &&
      raw.includes('"onboardingCompletedAt"') &&
      !raw.includes('"setupCompletedAt"') &&
      parsed.setupCompletedAt
    ) {
      await writeWorkspaceSetupState(statePath, parsed);
    }
    return parsed ?? { version: WORKSPACE_STATE_VERSION };
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "ENOENT") {
      throw err;
    }
    return {
      version: WORKSPACE_STATE_VERSION,
    };
  }
}

async function readWorkspaceSetupStateForDir(dir: string): Promise<WorkspaceSetupState> {
  const statePath = resolveWorkspaceStatePath(resolveUserPath(dir));
  return await readWorkspaceSetupState(statePath);
}

export async function isWorkspaceSetupCompleted(dir: string): Promise<boolean> {
  const state = await readWorkspaceSetupStateForDir(dir);
  return typeof state.setupCompletedAt === "string" && state.setupCompletedAt.trim().length > 0;
}

async function writeWorkspaceSetupState(
  statePath: string,
  state: WorkspaceSetupState,
): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(tmpPath, payload, { encoding: "utf-8" });
    await fs.rename(tmpPath, statePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function hasGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isGitAvailable(): Promise<boolean> {
  if (gitAvailabilityPromise) {
    return gitAvailabilityPromise;
  }

  gitAvailabilityPromise = (async () => {
    try {
      const result = await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2_000 });
      return result.code === 0;
    } catch {
      return false;
    }
  })();

  return gitAvailabilityPromise;
}

async function ensureGitRepo(dir: string, isBrandNewWorkspace: boolean) {
  if (!isBrandNewWorkspace) {
    return;
  }
  if (await hasGitRepo(dir)) {
    return;
  }
  if (!(await isGitAvailable())) {
    return;
  }
  try {
    await runCommandWithTimeout(["git", "init"], { cwd: dir, timeoutMs: 10_000 });
  } catch {
    // Ignore git init failures; workspace creation should still succeed.
  }
}

/**
 * Ensure the agent workspace exists and optionally populate bootstrap files.
 *
 * @param params.dir - Workspace directory path. Defaults to `~/.dennou-aibou/workspace`.
 * @param params.ensureBootstrapFiles - If true, create missing bootstrap files from templates.
 * @returns Workspace paths. Path properties are present only when `ensureBootstrapFiles` is true
 *   and the corresponding file was created or already existed.
 */
export async function ensureAgentWorkspace(params?: {
  dir?: string;
  ensureBootstrapFiles?: boolean;
}): Promise<{
  dir: string;
  agentsPath?: string;
  /** Path to HABITS.md, present only when `ensureBootstrapFiles` is true. */
  habitsPath?: string;
  soulPath?: string;
  toolsPath?: string;
  identityPath?: string;
  userPath?: string;
  bootstrapPath?: string;
}> {
  const rawDir = params?.dir?.trim() ? params.dir.trim() : DEFAULT_AGENT_WORKSPACE_DIR;
  const dir = resolveUserPath(rawDir);
  await fs.mkdir(dir, { recursive: true });

  if (!params?.ensureBootstrapFiles) {
    return { dir };
  }

  const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
  const habitsPath = path.join(dir, DEFAULT_HABITS_FILENAME);
  const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
  const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
  const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
  const userPath = path.join(dir, DEFAULT_USER_FILENAME);
  const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
  const statePath = resolveWorkspaceStatePath(dir);

  const isBrandNewWorkspace = await (async () => {
    const templatePaths = [agentsPath, habitsPath, soulPath, toolsPath, identityPath, userPath];
    const userContentPaths = [
      path.join(dir, "memory"),
      path.join(dir, DEFAULT_MEMORY_FILENAME),
      path.join(dir, ".git"),
    ];
    const paths = [...templatePaths, ...userContentPaths];
    const existing = await Promise.all(
      paths.map(async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      }),
    );
    return existing.every((v) => !v);
  })();

  const agentsTemplate = await loadTemplate(DEFAULT_AGENTS_FILENAME);
  const habitsTemplate = await loadTemplate(DEFAULT_HABITS_FILENAME);
  const soulTemplate = await loadTemplate(DEFAULT_SOUL_FILENAME);
  const toolsTemplate = await loadTemplate(DEFAULT_TOOLS_FILENAME);
  const identityTemplate = await loadTemplate(DEFAULT_IDENTITY_FILENAME);
  const userTemplate = await loadTemplate(DEFAULT_USER_FILENAME);
  await writeFileIfMissing(agentsPath, agentsTemplate);
  await writeFileIfMissing(habitsPath, habitsTemplate);
  await writeFileIfMissing(soulPath, soulTemplate);
  await writeFileIfMissing(toolsPath, toolsTemplate);
  await writeFileIfMissing(identityPath, identityTemplate);
  await writeFileIfMissing(userPath, userTemplate);

  let state = await readWorkspaceSetupState(statePath);
  let stateDirty = false;
  const markState = (next: Partial<WorkspaceSetupState>) => {
    state = { ...state, ...next };
    stateDirty = true;
  };
  const nowIso = () => new Date().toISOString();

  let bootstrapExists = await fileExists(bootstrapPath);
  if (!state.bootstrapSeededAt && bootstrapExists) {
    markState({ bootstrapSeededAt: nowIso() });
  }

  if (!state.setupCompletedAt && state.bootstrapSeededAt && !bootstrapExists) {
    markState({ setupCompletedAt: nowIso() });
  }

  if (!state.bootstrapSeededAt && !state.setupCompletedAt && !bootstrapExists) {
    // Legacy migration path: if USER/IDENTITY diverged from templates, or if user-content
    // indicators exist, treat setup as complete and avoid recreating BOOTSTRAP for
    // already-configured workspaces.
    const [identityContent, userContent] = await Promise.all([
      fs.readFile(identityPath, "utf-8"),
      fs.readFile(userPath, "utf-8"),
    ]);
    const hasUserContent = await (async () => {
      const indicators = [
        path.join(dir, "memory"),
        path.join(dir, DEFAULT_MEMORY_FILENAME),
        path.join(dir, ".git"),
      ];
      for (const indicator of indicators) {
        try {
          await fs.access(indicator);
          return true;
        } catch {
          // continue
        }
      }
      return false;
    })();
    const legacySetupCompleted =
      identityContent !== identityTemplate || userContent !== userTemplate || hasUserContent;
    if (legacySetupCompleted) {
      markState({ setupCompletedAt: nowIso() });
    } else {
      const bootstrapTemplate = await loadTemplate(DEFAULT_BOOTSTRAP_FILENAME);
      const wroteBootstrap = await writeFileIfMissing(bootstrapPath, bootstrapTemplate);
      if (!wroteBootstrap) {
        bootstrapExists = await fileExists(bootstrapPath);
      } else {
        bootstrapExists = true;
      }
      if (bootstrapExists && !state.bootstrapSeededAt) {
        markState({ bootstrapSeededAt: nowIso() });
      }
    }
  }

  if (stateDirty) {
    await writeWorkspaceSetupState(statePath, state);
  }
  await ensureGitRepo(dir, isBrandNewWorkspace);

  return {
    dir,
    agentsPath,
    habitsPath,
    soulPath,
    toolsPath,
    identityPath,
    userPath,
    bootstrapPath,
  };
}

/**
 * Lenient priority parsing: finite numbers pass through and numeric strings (e.g. `"5"`)
 * are parsed with `Number.parseInt`. Anything else yields `undefined` (default order).
 */
function parseConfigPriorityValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeContextFilesConfigItem(item: unknown): ContextFilesConfigEntry | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const obj = item as Record<string, unknown>;
  const fileValue =
    typeof obj.file === "string" ? obj.file : typeof obj.name === "string" ? obj.name : undefined;
  if (!fileValue) {
    return null;
  }
  const file = fileValue.trim();
  // Only plain relative filenames inside the workspace root are allowed (path-traversal guard).
  if (!file || file === "." || file === ".." || file.includes("/") || file.includes("\\")) {
    return null;
  }
  // Only Markdown files may be injected into the prompt (e.g. no `.env`).
  if (!file.toLowerCase().endsWith(".md")) {
    return null;
  }
  return { file, priority: parseConfigPriorityValue(obj.priority ?? obj.order) };
}

function extractContextFilesConfigArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.files)) {
      return obj.files;
    }
    if (Array.isArray(obj.contextFiles)) {
      return obj.contextFiles;
    }
    // Map form: { "RULES.md": 1, "SOUL.md": 5 }. Like the array form, invalid values
    // and non-Markdown keys are skipped during normalization below; the map is
    // rejected only when nothing valid remains.
    const mapEntries = Object.entries(obj);
    if (mapEntries.length > 0) {
      return mapEntries.map(([file, priority]) => ({ file, priority }));
    }
  }
  return null;
}

/**
 * Parse `context-files.json` / `prompt-files.json` content.
 *
 * Supported shapes:
 * - Array form:  `[{ "file": "SOUL.md", "priority": 5 }, ...]` (`file`/`name`, `priority`/`order`)
 * - Map form:    `{ "RULES.md": 1, "SOUL.md": 5 }`
 * - Wrappers:    `{ "files": [...] }` or `{ "contextFiles": [...] }`
 *
 * Invalid JSON returns null (caller falls back to defaults). Malformed entries are skipped;
 * duplicate basenames keep the first occurrence.
 */
export function parseContextFilesConfig(raw: string): ContextFilesConfigEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = extractContextFilesConfigArray(parsed);
  if (!list) {
    return null;
  }
  const seen = new Set<string>();
  const entries: ContextFilesConfigEntry[] = [];
  for (const item of list) {
    const entry = normalizeContextFilesConfigItem(item);
    if (!entry) {
      continue;
    }
    const key = entry.file.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(entry);
  }
  // Adopt when at least one valid entry survives; otherwise fall back to defaults.
  return entries.length > 0 ? entries : null;
}

async function resolveMemoryBootstrapEntry(
  resolvedDir: string,
): Promise<{ name: WorkspaceBootstrapFileName; filePath: string } | null> {
  // Prefer MEMORY.md; fall back to memory.md only when absent.
  // Checking both and deduplicating via realpath is unreliable on case-insensitive
  // file systems mounted in Docker (e.g. macOS volumes), where both names pass
  // fs.access() but realpath does not normalise case through the mount layer,
  // causing the same content to be injected twice and wasting tokens.
  for (const name of [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME] as const) {
    const filePath = path.join(resolvedDir, name);
    try {
      await fs.access(filePath);
      return { name, filePath };
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function loadContextFilesConfig(
  resolvedDir: string,
): Promise<ContextFilesConfigEntry[] | null> {
  for (const fileName of [CONTEXT_FILES_CONFIG_FILENAME, CONTEXT_FILES_CONFIG_ALT_FILENAME]) {
    const loaded = await readWorkspaceFileWithGuards({
      filePath: path.join(resolvedDir, fileName),
      workspaceDir: resolvedDir,
    });
    if (!loaded.ok) {
      // Missing or unreadable candidate — try the next filename.
      continue;
    }
    // First readable candidate wins; unparseable content falls back to defaults.
    return parseContextFilesConfig(loaded.content);
  }
  return null;
}

export async function loadWorkspaceBootstrapFiles(dir: string): Promise<WorkspaceBootstrapFile[]> {
  const resolvedDir = resolveUserPath(dir);

  const config = await loadContextFilesConfig(resolvedDir);
  // Lowercased basename -> explicit priority from the JSON config.
  const configPriorityByBase = new Map<string, number | undefined>();
  // Custom files listed in the JSON that are not one of the default bootstrap files.
  const customEntries: Array<{ name: string; filePath: string; priority?: number }> = [];
  const defaultNameByBase = new Set([...VALID_BOOTSTRAP_NAMES].map((name) => name.toLowerCase()));
  if (config) {
    for (const entry of config) {
      const baseKey = entry.file.toLowerCase();
      configPriorityByBase.set(baseKey, entry.priority);
      const hasDefault = defaultNameByBase.has(baseKey);
      if (hasDefault) {
        continue;
      }
      customEntries.push({
        name: entry.file,
        filePath: path.join(resolvedDir, entry.file),
        priority: entry.priority,
      });
    }
  }

  const defaultEntries: Array<{
    name: WorkspaceBootstrapFileName;
    filePath: string;
    priority?: number;
  }> = [
    {
      name: DEFAULT_HABITS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_HABITS_FILENAME),
    },
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME),
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME),
    },
    {
      name: DEFAULT_USER_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME),
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
    },
  ];
  for (const entry of defaultEntries) {
    entry.priority = configPriorityByBase.get(entry.name.toLowerCase());
  }

  const entries: Array<{ name: string; filePath: string; priority?: number }> = [
    ...defaultEntries,
    ...customEntries,
  ];

  const memoryEntry = await resolveMemoryBootstrapEntry(resolvedDir);
  if (memoryEntry) {
    entries.push({
      ...memoryEntry,
      priority: configPriorityByBase.get(memoryEntry.name.toLowerCase()),
    });
  }

  // Budget order: explicit priorities first (ascending); unprioritized entries keep their
  // default relative order afterwards. Ties keep their configured/default relative order
  // (`toSorted` is stable). This way an important custom file (e.g. priority 1) consumes
  // the bootstrap char budget before unprioritized defaults instead of being cut off last.
  const orderedEntries = [...entries].toSorted((a, b) => {
    const aOrder =
      typeof a.priority === "number" && Number.isFinite(a.priority)
        ? a.priority
        : Number.MAX_SAFE_INTEGER;
    const bOrder =
      typeof b.priority === "number" && Number.isFinite(b.priority)
        ? b.priority
        : Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });

  const result: WorkspaceBootstrapFile[] = [];
  for (const entry of orderedEntries) {
    const loaded = await readWorkspaceFileWithGuards({
      filePath: entry.filePath,
      workspaceDir: resolvedDir,
    });
    if (loaded.ok) {
      result.push({
        name: entry.name,
        path: entry.filePath,
        content: loaded.content,
        missing: false,
        ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
      });
    } else {
      result.push({
        name: entry.name,
        path: entry.filePath,
        missing: true,
        ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
      });
    }
  }
  return result;
}

const MINIMAL_BOOTSTRAP_ALLOWLIST = new Set([
  DEFAULT_HABITS_FILENAME,
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
]);

/**
 * Narrow bootstrap files for minimal-context sessions (subagent/cron).
 *
 * Besides the allowlisted default files, files carrying an explicit
 * `context-files.json` / `prompt-files.json` priority are kept: an explicit
 * priority is deliberate user intent to inject that file, and dropping it
 * silently would contradict the configured order.
 */
export function filterBootstrapFilesForSession(
  files: WorkspaceBootstrapFile[],
  sessionKey?: string,
): WorkspaceBootstrapFile[] {
  if (!sessionKey || (!isSubagentSessionKey(sessionKey) && !isCronSessionKey(sessionKey))) {
    return files;
  }
  return files.filter(
    (file) =>
      MINIMAL_BOOTSTRAP_ALLOWLIST.has(file.name) ||
      (typeof file.priority === "number" && Number.isFinite(file.priority)),
  );
}

export async function loadExtraBootstrapFiles(
  dir: string,
  extraPatterns: string[],
): Promise<WorkspaceBootstrapFile[]> {
  const loaded = await loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns);
  return loaded.files;
}

export async function loadExtraBootstrapFilesWithDiagnostics(
  dir: string,
  extraPatterns: string[],
): Promise<{
  files: WorkspaceBootstrapFile[];
  diagnostics: ExtraBootstrapLoadDiagnostic[];
}> {
  if (!extraPatterns.length) {
    return { files: [], diagnostics: [] };
  }
  const resolvedDir = resolveUserPath(dir);

  // Resolve glob patterns into concrete file paths
  const resolvedPaths = new Set<string>();
  for (const pattern of extraPatterns) {
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) {
      try {
        const matches = fs.glob(pattern, { cwd: resolvedDir });
        for await (const m of matches) {
          resolvedPaths.add(m);
        }
      } catch {
        // glob not available or pattern error — fall back to literal
        resolvedPaths.add(pattern);
      }
    } else {
      resolvedPaths.add(pattern);
    }
  }

  const files: WorkspaceBootstrapFile[] = [];
  const diagnostics: ExtraBootstrapLoadDiagnostic[] = [];
  for (const relPath of resolvedPaths) {
    const filePath = path.resolve(resolvedDir, relPath);
    // Only load files whose basename is a recognized bootstrap filename
    const baseName = path.basename(relPath);
    if (!VALID_BOOTSTRAP_NAMES.has(baseName)) {
      diagnostics.push({
        path: filePath,
        reason: "invalid-bootstrap-filename",
        detail: `unsupported bootstrap basename: ${baseName}`,
      });
      continue;
    }
    const loaded = await readWorkspaceFileWithGuards({
      filePath,
      workspaceDir: resolvedDir,
    });
    if (loaded.ok) {
      files.push({
        name: baseName,
        path: filePath,
        content: loaded.content,
        missing: false,
      });
      continue;
    }

    const reason: ExtraBootstrapLoadDiagnosticCode =
      loaded.reason === "path" ? "missing" : loaded.reason === "validation" ? "security" : "io";
    diagnostics.push({
      path: filePath,
      reason,
      detail:
        loaded.error instanceof Error
          ? loaded.error.message
          : typeof loaded.error === "string"
            ? loaded.error
            : reason,
    });
  }
  return { files, diagnostics };
}

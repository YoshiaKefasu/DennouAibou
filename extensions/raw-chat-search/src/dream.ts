import { completeSimple } from "@earendil-works/pi-ai/compat";
import { Cron } from "croner";
import {
  extractAssistantText,
  prepareSimpleCompletionModelForAgent,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { PluginLogger } from "../../../src/plugins/types.js";
import { DEFAULT_AGENT_ID } from "../../../src/routing/session-key.js";
import type { RawChatDatabase } from "./database.js";
import {
  applyDreamConsolidation,
  MEMO_CONTENT_MAX_LENGTH,
  readMemos,
  resolveMemoTimezone,
  type DreamConsolidationInput,
  type MemoRecord,
} from "./memo-db.js";

/**
 * Dream — nightly autonomous memo consolidation (DENNOU_SHINKEI_MEMO §6).
 *
 * A single structured LLM completion (`completeSimple`, JSON answer) merges
 * duplicated memos, resolves contradictions, and archives the absorbed rows.
 * No agent session is ever spawned (`subagent.run` is not used), so there is
 * no session-file growth and no loop risk (rules #2032/#2041).
 *
 * Model resolution + auth go through `prepareSimpleCompletionModelForAgent`,
 * which is the same `resolveDefaultModelForAgent` / `resolveModelAsync` +
 * transport prepare + `getApiKeyForModel` chain the gateway uses elsewhere.
 */

export const DEFAULT_DREAM_SCHEDULE = "0 3 * * *";
export const DEFAULT_DREAM_LANGUAGE = "ja";
export const DREAM_LLM_TIMEOUT_MS = 60_000;
export const DREAM_LLM_MAX_TOKENS = 2_000;
export const DREAM_LLM_TEMPERATURE = 0.2;

export type DreamConfig = {
  enabled: boolean;
  schedule: string;
  /** Explicit `provider/model` ref; undefined falls back to the agent default model. */
  model?: string;
  timezone: string;
  /** 2-letter ISO 639-1 code for merged memo prose (default "ja"). */
  language: string;
};

export type DreamConsolidation = DreamConsolidationInput;

export type DreamResult = {
  ok: boolean;
  /** True when the LLM call was skipped (0–1 active memos) or a run was already in flight. */
  skipped?: boolean;
  activeCount: number;
  consolidatedCount?: number;
  archivedCount?: number;
  model?: string;
  reason?: string;
  error?: string;
};

/** Injectable seams so unit tests never touch the network or the model registry. */
export type DreamDeps = {
  prepareModel?: typeof prepareSimpleCompletionModelForAgent;
  completeSimpleFn?: typeof completeSimple;
  now?: () => number;
};

export type DreamRunParams = {
  db: RawChatDatabase;
  cfg: OpenClawConfig;
  agentId?: string;
  // Note: model auth derives the agent dir from cfg + agentId internally
  // (prepareSimpleCompletionModelForAgent); agentDir stays reserved for
  // callers that pin a custom dir in the future.
  agentDir?: string;
  /** Explicit `provider/model` ref; wins over the plugin `dream.model` config. */
  modelOverride?: string;
  /** 2-letter ISO 639-1 code for merged memo prose (default "ja"). */
  language?: string;
  /** IANA timezone for expiry dates (defaults to cfg userTimezone, then host TZ). */
  timezone?: string;
  logger: PluginLogger;
  deps?: DreamDeps;
};

/** `dream.timezone` -> `agents.defaults.userTimezone` -> host TZ (§6.1). */
export function resolveDreamConfig(
  pluginConfig?: Record<string, unknown>,
  cfg?: OpenClawConfig,
): DreamConfig {
  const raw =
    pluginConfig?.["dream"] && typeof pluginConfig["dream"] === "object"
      ? (pluginConfig["dream"] as Record<string, unknown>)
      : {};
  const schedule =
    typeof raw["schedule"] === "string" && raw["schedule"].trim()
      ? raw["schedule"].trim()
      : DEFAULT_DREAM_SCHEDULE;
  const model =
    typeof raw["model"] === "string" && raw["model"].trim() ? raw["model"].trim() : undefined;
  // dream.language wins, then the plugin-level language, then the default.
  const languageRaw =
    typeof raw["language"] === "string" && raw["language"].trim()
      ? raw["language"].trim()
      : typeof pluginConfig?.["language"] === "string" && pluginConfig["language"].trim()
        ? (pluginConfig["language"] as string).trim()
        : DEFAULT_DREAM_LANGUAGE;
  return {
    enabled: raw["enabled"] !== false,
    schedule,
    ...(model ? { model } : {}),
    timezone: resolveMemoTimezone(
      typeof raw["timezone"] === "string" ? raw["timezone"] : undefined,
      cfg,
    ),
    language: languageRaw,
  };
}

const DREAM_SYSTEM_PROMPT = [
  "You are Kasou's nightly memory organizer (Dream).",
  "Merge duplicated memos, resolve contradictions, drop what is fully absorbed.",
  "Return ONLY the JSON object described by the user message. No prose, no code fences.",
].join(" ");

function formatDreamExpiry(memo: MemoRecord, timezone: string): string {
  if (memo.forever || memo.expiresAt === null) {
    return "forever";
  }
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(memo.expiresAt));
  } catch {
    return "unknown";
  }
}

/** Renders every active memo as LLM input. Exported for unit tests. */
export function buildDreamPrompt(
  memos: readonly MemoRecord[],
  timezone = "UTC",
  language: string = DEFAULT_DREAM_LANGUAGE,
): string {
  const lines = memos.map((memo) => {
    const tagsPart = memo.tags.length > 0 ? ` [tags: ${memo.tags.join(", ")}]` : "";
    return `#${memo.id} [${memo.category}]${tagsPart} (expires: ${formatDreamExpiry(memo, timezone)}): ${memo.content}`;
  });
  const body = [
    "Active memos to organize:",
    ...lines,
    "",
    "Work ALL THREE phases below in order (A → B → C) over the whole pool.",
    "Do NOT stop after consolidating — a run that only merges and never improves or archives is incomplete.",
    "",
    "### Phase A — Consolidate duplicates",
    "Group by category, then merge near-identical / superset-subset / same-fact-different-angle clusters into one canonical memo.",
    "Preserve every unique detail in the merged text. One fact per memo.",
    "Every id in a merge MUST share the same category — similar memos in different categories are NOT duplicates (archive the redundant one in Phase C instead).",
    "Contradictions resolve to the newer information; drop the outdated parts.",
    "",
    "### Phase B — Improve wording",
    "Rewrite narrative/historical phrasing into operational present tense.",
    "Drop session-local context; add specifics where vague.",
    "The polished text goes into updateContent (optional, max 2,000 chars).",
    "",
    "### Phase C — Archive stale / low-value",
    "Archive (via archiveIds, never including keepId itself) memos fully absorbed into keepId, restating another memo without added rationale, or carrying stale/transient detail.",
    "Be conservative — KEEP constraint/rule language (must/never/always), memos explaining WHY (because/so that/to prevent), and anything still referenced.",
    "NEVER invent new memos. Reference only the listed IDs.",
    "When nothing needs merging, return an empty consolidations array.",
    "",
    "Return ONLY the JSON object below (no prose, no code fences):",
    '{"consolidations": [{"keepId": 1, "updateContent": "...", "archiveIds": [2, 3]}]}',
  ].join("\n");
  return withDreamLanguageDirective(body, language);
}

/**
 * Resolve a 2-letter ISO 639-1 code to the model-facing name string
 * ("Japanese (日本語)"), following MagicContext's withContentLanguageDirective
 * spec: a name — not a bare code — is what makes a weak model reliably write
 * in-language. Returns "" for anything unresolvable, so an invalid value
 * emits no directive.
 */
export function resolveDreamLanguageName(language?: string): string {
  const code = typeof language === "string" ? language.trim().toLowerCase() : "";
  if (!/^[a-z]{2}$/u.test(code)) {
    return "";
  }
  let english: string | undefined;
  try {
    english =
      new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(code) ?? undefined;
  } catch {
    return "";
  }
  if (!english) {
    return "";
  }
  let endonym: string | undefined;
  try {
    endonym =
      new Intl.DisplayNames([code], { type: "language", fallback: "none" }).of(code) ?? undefined;
  } catch {
    endonym = undefined;
  }
  return endonym && endonym !== english ? `${english} (${endonym})` : english;
}

/**
 * Appends the output-language directive to a Dream prompt (MagicContext
 * withContentLanguageDirective spec, memo-scoped): merged memo prose comes out
 * in the target language while IDs, JSON keys, category names, and technical
 * terms stay in English verbatim.
 */
export function withDreamLanguageDirective(prompt: string, language?: string): string {
  const target = resolveDreamLanguageName(language);
  if (!target) {
    return prompt;
  }
  return [
    prompt,
    "",
    "## Output language",
    "",
    `Write human-readable prose you author in: ${target}.`,
    "",
    "Do not translate or rename structural tokens. Copy the required output schema exactly:",
    "- JSON keys, memo IDs (numbers), category names (User, Project, AgentHabits, etc), and status values stay in English exactly as shown.",
    "- Keep code identifiers, file paths, commands, config keys, CLI flags, URLs, model/provider IDs, and technical terms verbatim.",
    "- Localize only free-text prose values: the merged/rewritten memo bodies (updateContent).",
    "",
    "Preserve the required output shape. Do not add commentary outside the requested JSON output.",
  ].join("\n");
}

function stripDreamCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/u.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

/**
 * Parses the LLM answer into merge instructions. Throws when the text holds no
 * JSON object or the shape is wrong; item-level garbage (bad ids, overlong
 * updates, empty merges) is dropped so one wild row cannot sink the run.
 */
export function parseDreamResponseText(text: string): DreamConsolidation[] {
  const cleaned = stripDreamCodeFences(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("dream: LLM response contains no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error("dream: LLM response is not valid JSON");
  }
  const rawList = (parsed as { consolidations?: unknown }).consolidations;
  if (!Array.isArray(rawList)) {
    throw new Error("dream: LLM response misses the consolidations array");
  }
  const out: DreamConsolidation[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const item = raw as { keepId?: unknown; updateContent?: unknown; archiveIds?: unknown };
    if (!Number.isInteger(item.keepId) || (item.keepId as number) <= 0) {
      continue;
    }
    const keepId = item.keepId as number;
    const archiveIds = Array.isArray(item.archiveIds)
      ? [...new Set(item.archiveIds)].filter(
          (id): id is number => Number.isInteger(id) && id > 0 && id !== keepId,
        )
      : [];
    let updateContent: string | undefined;
    if (typeof item.updateContent === "string" && item.updateContent.trim()) {
      // Note: an overlong rewrite is dropped but the archive half still applies.
      if (item.updateContent.trim().length <= MEMO_CONTENT_MAX_LENGTH) {
        updateContent = item.updateContent.trim();
      }
    }
    if (archiveIds.length === 0 && !updateContent) {
      continue;
    }
    out.push({
      keepId,
      ...(updateContent ? { updateContent } : {}),
      archiveIds,
    });
  }
  return out;
}

/**
 * One Dream pass: skip on 0–1 active memos, else a single structured LLM call
 * followed by an atomic SQLite merge. Never throws — failures come back as
 * `{ ok: false }` so the Cron callback cannot crash the gateway.
 */
export async function runDreamConsolidation(params: DreamRunParams): Promise<DreamResult> {
  const { db, cfg, logger } = params;
  const deps = params.deps ?? {};
  const now = deps.now ?? Date.now;
  const agentId = params.agentId?.trim() ? params.agentId.trim() : DEFAULT_AGENT_ID;

  let active: MemoRecord[];
  try {
    // readMemos runs lazy expiry first (§5.1), so dated rows never reach the LLM.
    active = readMemos(db, {}, now());
  } catch (error) {
    return {
      ok: false,
      activeCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (active.length <= 1) {
    return {
      ok: true,
      skipped: true,
      activeCount: active.length,
      reason: "0-1 active memos: nothing to consolidate",
    };
  }

  const prepareModel = deps.prepareModel ?? prepareSimpleCompletionModelForAgent;
  const completeFn = deps.completeSimpleFn ?? completeSimple;
  const modelRef = params.modelOverride?.trim() ? params.modelOverride.trim() : undefined;
  const language = params.language?.trim() ? params.language.trim() : DEFAULT_DREAM_LANGUAGE;
  const timezone = params.timezone?.trim()
    ? params.timezone.trim()
    : resolveMemoTimezone(undefined, cfg);
  let prepared: Awaited<ReturnType<typeof prepareModel>>;
  try {
    prepared = await prepareModel({
      cfg,
      agentId,
      ...(modelRef ? { modelRef } : {}),
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  } catch (error) {
    // Note: prepareModel resolves the model + reads FS state, so it can
    // throw (unknown model, FS error). Never let that crash the gateway.
    return {
      ok: false,
      activeCount: active.length,
      error: `dream model preparation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if ("error" in prepared) {
    const label = prepared.selection
      ? `${prepared.selection.provider}/${prepared.selection.modelId}`
      : (modelRef ?? "default");
    return { ok: false, activeCount: active.length, error: `${prepared.error} (model=${label})` };
  }
  const modelLabel = `${prepared.model.provider}/${prepared.model.id}`;

  const knownIds = new Set(active.map((memo) => memo.id));
  let replyText: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DREAM_LLM_TIMEOUT_MS);
    try {
      const response = await completeFn(
        prepared.model,
        {
          messages: [
            {
              role: "user",
              content: `${DREAM_SYSTEM_PROMPT}\n\n${buildDreamPrompt(active, timezone, language)}`,
              timestamp: now(),
            },
          ],
        },
        {
          apiKey: prepared.auth.apiKey,
          maxTokens: DREAM_LLM_MAX_TOKENS,
          temperature: DREAM_LLM_TEMPERATURE,
          signal: controller.signal,
        },
      );
      replyText = extractAssistantText(response);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      ok: false,
      activeCount: active.length,
      model: modelLabel,
      error: `dream LLM call failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let consolidations: DreamConsolidation[];
  try {
    const parsed = parseDreamResponseText(replyText)
      .map((job) => ({
        ...job,
        archiveIds: job.archiveIds.filter((id) => knownIds.has(id)),
      }))
      .filter((job) => knownIds.has(job.keepId));
    // Cross-job defense: one job's keepId must never be archived by another
    // job, or the memo we meant to keep gets archived by mistake.
    const allKeepIds = new Set(parsed.map((job) => job.keepId));
    consolidations = parsed
      .map((job) => ({
        ...job,
        archiveIds: job.archiveIds.filter((id) => !allKeepIds.has(id)),
      }))
      .filter((job) => job.archiveIds.length > 0 || job.updateContent);
  } catch (error) {
    logger.warn(`raw-chat-search dream: ignoring unparseable answer: ${replyText.slice(0, 200)}`);
    return {
      ok: false,
      activeCount: active.length,
      model: modelLabel,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let applied = { updated: 0, archived: 0 };
  if (consolidations.length > 0) {
    try {
      applied = applyDreamConsolidation(db, consolidations, now());
    } catch (error) {
      return {
        ok: false,
        activeCount: active.length,
        model: modelLabel,
        error: `dream apply failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  logger.info(
    `raw-chat-search dream: consolidated ${applied.updated} memo(s), archived ${applied.archived} memo(s) (active: ${active.length}, model: ${modelLabel}).`,
  );
  return {
    ok: true,
    activeCount: active.length,
    consolidatedCount: applied.updated,
    archivedCount: applied.archived,
    model: modelLabel,
  };
}

export type DreamCronJob = {
  stop: () => void;
};

export type DreamCronFactory = (
  schedule: string,
  timezone: string,
  onFire: () => void,
) => DreamCronJob;

const defaultDreamCronFactory: DreamCronFactory = (schedule, timezone, onFire) =>
  new Cron(schedule, { timezone, protect: true }, onFire);

export type DreamSchedulerOptions = {
  schedule?: string;
  timezone?: string;
  modelOverride?: string;
  language?: string;
  agentId?: string;
  agentDir?: string;
  db: RawChatDatabase | (() => RawChatDatabase);
  cfg: OpenClawConfig | (() => OpenClawConfig);
  logger: PluginLogger;
  deps?: DreamDeps;
  cronFactory?: DreamCronFactory;
};

/**
 * Croner-backed Dream scheduler. `start()` registers the Cron job (false when
 * the expression is invalid — the gateway keeps running without Dream);
 * `stop()` frees the timer; `runOnce()` fires one consolidation on demand.
 */
export class DreamScheduler {
  private readonly options: DreamSchedulerOptions;
  private job: DreamCronJob | null = null;
  private inFlight: Promise<DreamResult> | null = null;

  constructor(options: DreamSchedulerOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.job !== null;
  }

  start(): boolean {
    if (this.job) {
      return true;
    }
    const schedule = this.options.schedule?.trim() || DEFAULT_DREAM_SCHEDULE;
    const timezone =
      this.options.timezone?.trim() || resolveMemoTimezone(undefined, this.readCfg());
    const factory = this.options.cronFactory ?? defaultDreamCronFactory;
    try {
      this.job = factory(schedule, timezone, () => {
        // Double defense: runDreamConsolidation never throws by contract,
        // but a defensive catch keeps a future regression from crashing the gateway.
        void this.runOnce().catch((err) => {
          this.options.logger.warn(
            `raw-chat-search dream: unhandled error in runOnce: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      });
    } catch (error) {
      this.options.logger.warn(
        `raw-chat-search dream: invalid schedule "${schedule}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    return true;
  }

  stop(): void {
    if (!this.job) {
      return;
    }
    try {
      this.job.stop();
    } catch {
      // Teardown best-effort: never fail gateway shutdown.
    }
    this.job = null;
  }

  runOnce(): Promise<DreamResult> {
    if (this.inFlight) {
      return Promise.resolve({
        ok: true,
        skipped: true,
        activeCount: 0,
        reason: "dream run already in flight",
      });
    }
    const task = runDreamConsolidation({
      db: this.readDb(),
      cfg: this.readCfg(),
      ...(this.options.agentId ? { agentId: this.options.agentId } : {}),
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      ...(this.options.modelOverride ? { modelOverride: this.options.modelOverride } : {}),
      ...(this.options.language ? { language: this.options.language } : {}),
      ...(this.options.timezone ? { timezone: this.options.timezone } : {}),
      logger: this.options.logger,
      ...(this.options.deps ? { deps: this.options.deps } : {}),
    }).finally(() => {
      if (this.inFlight === task) {
        this.inFlight = null;
      }
    });
    this.inFlight = task;
    return task;
  }

  private readDb(): RawChatDatabase {
    return typeof this.options.db === "function" ? this.options.db() : this.options.db;
  }

  private readCfg(): OpenClawConfig {
    return typeof this.options.cfg === "function" ? this.options.cfg() : this.options.cfg;
  }
}

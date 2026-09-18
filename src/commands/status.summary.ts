import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { readSessionStoreReadOnly } from "../config/sessions/store-read.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import type { HeartbeatStatus, SessionStatus, StatusSummary } from "./status.types.js";

let channelSummaryModulePromise: Promise<typeof import("../infra/channel-summary.js")> | undefined;
let linkChannelModulePromise: Promise<typeof import("./status.link-channel.js")> | undefined;
let configIoModulePromise: Promise<typeof import("../config/io.js")> | undefined;
let taskRegistryMaintenanceModulePromise:
  | Promise<typeof import("../tasks/task-registry.maintenance.js")>
  | undefined;

function loadChannelSummaryModule() {
  channelSummaryModulePromise ??= import("../infra/channel-summary.js");
  return channelSummaryModulePromise;
}

function loadLinkChannelModule() {
  linkChannelModulePromise ??= import("./status.link-channel.js");
  return linkChannelModulePromise;
}

const loadStatusSummaryRuntimeModule = createLazyRuntimeSurface(
  () => import("./status.summary.runtime.js"),
  ({ statusSummaryRuntime }) => statusSummaryRuntime,
);

function loadConfigIoModule() {
  configIoModulePromise ??= import("../config/io.js");
  return configIoModulePromise;
}

function loadTaskRegistryMaintenanceModule() {
  taskRegistryMaintenanceModulePromise ??= import("../tasks/task-registry.maintenance.js");
  return taskRegistryMaintenanceModulePromise;
}

const buildFlags = (entry?: SessionEntry): string[] => {
  if (!entry) {
    return [];
  }
  const flags: string[] = [];
  const think = entry?.thinkingLevel;
  if (typeof think === "string" && think.length > 0) {
    flags.push(`think:${think}`);
  }
  const verbose = entry?.verboseLevel;
  if (typeof verbose === "string" && verbose.length > 0) {
    flags.push(`verbose:${verbose}`);
  }
  if (typeof entry?.fastMode === "boolean") {
    flags.push(entry.fastMode ? "fast" : "fast:off");
  }
  const reasoning = entry?.reasoningLevel;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    flags.push(`reasoning:${reasoning}`);
  }
  const elevated = entry?.elevatedLevel;
  if (typeof elevated === "string" && elevated.length > 0) {
    flags.push(`elevated:${elevated}`);
  }
  if (entry?.systemSent) {
    flags.push("system");
  }
  if (entry?.abortedLastRun) {
    flags.push("aborted");
  }
  const sessionId = entry?.sessionId as unknown;
  if (typeof sessionId === "string" && sessionId.length > 0) {
    flags.push(`id:${sessionId}`);
  }
  return flags;
};

export function redactSensitiveStatusSummary(summary: StatusSummary): StatusSummary {
  return {
    ...summary,
    sessions: {
      ...summary.sessions,
      paths: [],
      defaults: {
        model: null,
        contextTokens: null,
      },
      recent: [],
      byAgent: summary.sessions.byAgent.map((entry) => ({
        ...entry,
        path: "[redacted]",
        recent: [],
      })),
    },
  };
}

/**
 * Injectable seams for the status-summary boundaries (config IO, channel
 * presence/summary, session store, task maintenance, and clock). Tests supply
 * fixtures instead of replacing whole modules with `vi.mock`.
 */
export type StatusSummaryDeps = {
  statusSummaryRuntime?: typeof import("./status.summary.runtime.js").statusSummaryRuntime;
  taskMaintenanceModule?: typeof import("../tasks/task-registry.maintenance.js");
  loadConfig?: () => OpenClawConfig;
  hasPotentialConfiguredChannels?: typeof hasPotentialConfiguredChannels;
  resolveLinkChannelContext?: typeof import("./status.link-channel.js").resolveLinkChannelContext;
  buildChannelSummary?: typeof import("../infra/channel-summary.js").buildChannelSummary;
  listGatewayAgentsBasic?: typeof listGatewayAgentsBasic;
  resolveMainSessionKey?: typeof resolveMainSessionKey;
  peekSystemEvents?: typeof peekSystemEvents;
  readSessionStoreReadOnly?: typeof readSessionStoreReadOnly;
  resolveStorePath?: typeof resolveStorePath;
  parseAgentSessionKey?: typeof parseAgentSessionKey;
  resolveRuntimeServiceVersion?: typeof resolveRuntimeServiceVersion;
  resolveFreshSessionTotalTokens?: typeof resolveFreshSessionTotalTokens;
  now?: () => number;
};

export async function getStatusSummary(
  options: {
    includeSensitive?: boolean;
    config?: OpenClawConfig;
    sourceConfig?: OpenClawConfig;
  } = {},
  deps: StatusSummaryDeps = {},
): Promise<StatusSummary> {
  const { includeSensitive = true } = options;
  const {
    classifySessionKey,
    resolveConfiguredStatusModelRef,
    resolveContextTokensForModel,
    resolveSessionModelRef,
  } = deps.statusSummaryRuntime ?? (await loadStatusSummaryRuntimeModule());
  const loadConfig = deps.loadConfig ?? (await loadConfigIoModule()).loadConfig;
  const hasConfiguredChannels =
    deps.hasPotentialConfiguredChannels ?? hasPotentialConfiguredChannels;
  const resolveStorePathImpl = deps.resolveStorePath ?? resolveStorePath;
  const parseAgentSessionKeyImpl = deps.parseAgentSessionKey ?? parseAgentSessionKey;
  const peekSystemEventsImpl = deps.peekSystemEvents ?? peekSystemEvents;
  const readSessionStore = deps.readSessionStoreReadOnly ?? readSessionStoreReadOnly;
  const resolveVersion = deps.resolveRuntimeServiceVersion ?? resolveRuntimeServiceVersion;
  const resolveTotalTokens = deps.resolveFreshSessionTotalTokens ?? resolveFreshSessionTotalTokens;
  const nowFn = deps.now ?? Date.now;
  const cfg = options.config ?? loadConfig();
  const needsChannelPlugins = hasConfiguredChannels(cfg);
  const linkContext = needsChannelPlugins
    ? await (
        deps.resolveLinkChannelContext ?? (await loadLinkChannelModule()).resolveLinkChannelContext
      )(cfg)
    : null;
  const agentList = (deps.listGatewayAgentsBasic ?? listGatewayAgentsBasic)(cfg);
  const heartbeatAgents: HeartbeatStatus[] = agentList.agents.map((agent) => ({
    agentId: agent.id,
    enabled: false,
    every: "",
    everyMs: null,
  }));
  const channelSummary = needsChannelPlugins
    ? await (deps.buildChannelSummary ?? (await loadChannelSummaryModule()).buildChannelSummary)(
        cfg,
        {
          colorize: true,
          includeAllowFrom: true,
          sourceConfig: options.sourceConfig,
        },
      )
    : [];
  const mainSessionKey = (deps.resolveMainSessionKey ?? resolveMainSessionKey)(cfg);
  const queuedSystemEvents = peekSystemEventsImpl(mainSessionKey);
  const taskMaintenanceModule =
    deps.taskMaintenanceModule ?? (await loadTaskRegistryMaintenanceModule());
  const tasks = taskMaintenanceModule.getInspectableTaskRegistrySummary();
  const taskAudit = taskMaintenanceModule.getInspectableTaskAuditSummary();

  const resolved = resolveConfiguredStatusModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const configModel = resolved.model ?? DEFAULT_MODEL;
  const configContextTokens =
    resolveContextTokensForModel({
      cfg,
      provider: resolved.provider ?? DEFAULT_PROVIDER,
      model: configModel,
      contextTokensOverride: cfg.agents?.defaults?.contextTokens,
      fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
      // Keep `status`/`status --json` startup read-only. These summary lookups
      // should not kick off background provider discovery or plugin scans.
      allowAsyncLoad: false,
    }) ?? DEFAULT_CONTEXT_TOKENS;

  const now = nowFn();
  const storeCache = new Map<string, Record<string, SessionEntry | undefined>>();
  const loadStore = (storePath: string) => {
    const cached = storeCache.get(storePath);
    if (cached) {
      return cached;
    }
    const store = readSessionStore(storePath);
    storeCache.set(storePath, store);
    return store;
  };
  const buildSessionRows = (
    store: Record<string, SessionEntry | undefined>,
    opts: { agentIdOverride?: string } = {},
  ) =>
    Object.entries(store)
      .filter(([key]) => key !== "global" && key !== "unknown")
      .map(([key, entry]) => {
        const updatedAt = entry?.updatedAt ?? null;
        const age = updatedAt ? now - updatedAt : null;
        const resolvedModel = resolveSessionModelRef(cfg, entry, opts.agentIdOverride);
        const model = resolvedModel.model ?? configModel ?? null;
        const contextTokens =
          resolveContextTokensForModel({
            cfg,
            provider: resolvedModel.provider,
            model,
            contextTokensOverride: entry?.contextTokens,
            fallbackContextTokens: configContextTokens ?? undefined,
            allowAsyncLoad: false,
          }) ?? null;
        const total = resolveTotalTokens(entry);
        const totalTokensFresh =
          typeof entry?.totalTokens === "number" ? entry?.totalTokensFresh !== false : false;
        const remaining =
          contextTokens != null && total !== undefined ? Math.max(0, contextTokens - total) : null;
        const pct =
          contextTokens && contextTokens > 0 && total !== undefined
            ? Math.min(999, Math.round((total / contextTokens) * 100))
            : null;
        const parsedAgentId = parseAgentSessionKeyImpl(key)?.agentId;
        const agentId = opts.agentIdOverride ?? parsedAgentId;

        return {
          agentId,
          key,
          kind: classifySessionKey(key, entry),
          sessionId: entry?.sessionId,
          updatedAt,
          age,
          thinkingLevel: entry?.thinkingLevel,
          fastMode: entry?.fastMode,
          verboseLevel: entry?.verboseLevel,
          reasoningLevel: entry?.reasoningLevel,
          elevatedLevel: entry?.elevatedLevel,
          systemSent: entry?.systemSent,
          abortedLastRun: entry?.abortedLastRun,
          inputTokens: entry?.inputTokens,
          outputTokens: entry?.outputTokens,
          cacheRead: entry?.cacheRead,
          cacheWrite: entry?.cacheWrite,
          totalTokens: total ?? null,
          totalTokensFresh,
          remainingTokens: remaining,
          percentUsed: pct,
          model,
          contextTokens,
          flags: buildFlags(entry),
        } satisfies SessionStatus;
      })
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const paths = new Set<string>();
  const byAgent = agentList.agents.map((agent) => {
    const storePath = resolveStorePathImpl(cfg.session?.store, { agentId: agent.id });
    paths.add(storePath);
    const store = loadStore(storePath);
    const sessions = buildSessionRows(store, { agentIdOverride: agent.id });
    return {
      agentId: agent.id,
      path: storePath,
      count: sessions.length,
      recent: sessions.slice(0, 10),
    };
  });

  const allSessions = Array.from(paths)
    .flatMap((storePath) => buildSessionRows(loadStore(storePath)))
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const recent = allSessions.slice(0, 10);
  const totalSessions = allSessions.length;

  const summary: StatusSummary = {
    runtimeVersion: resolveVersion(process.env),
    linkChannel: linkContext
      ? {
          id: linkContext.plugin.id,
          label: linkContext.plugin.meta.label ?? "Channel",
          linked: linkContext.linked,
          authAgeMs: linkContext.authAgeMs,
        }
      : undefined,
    heartbeat: {
      defaultAgentId: agentList.defaultId,
      agents: heartbeatAgents,
    },
    channelSummary,
    queuedSystemEvents,
    tasks,
    taskAudit,
    sessions: {
      paths: Array.from(paths),
      count: totalSessions,
      defaults: {
        model: configModel ?? null,
        contextTokens: configContextTokens ?? null,
      },
      recent,
      byAgent,
    },
  };
  return includeSensitive ? summary : redactSensitiveStatusSummary(summary);
}

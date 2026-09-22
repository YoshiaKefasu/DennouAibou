import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
} from "../../agents/agent-scope.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsAudio,
} from "../../agents/model-catalog.js";
import { resolveModelRefFromString, type ModelAliasIndex } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../../agents/workspace.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { hasInlineableNativeAudio } from "../../media/native-audio.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveDefaultModel } from "./directive-handling.defaults.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { runPreparedReply } from "./get-reply-run.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { emitPreAgentMessageHooks } from "./message-preprocess-hooks.js";
import { resolveStoredModelOverride } from "./model-selection.js";
import {
  initSessionState,
  resolveSessionModelOverrideSnapshot,
  type SessionModelOverrideSnapshot,
} from "./session.js";
import { createTypingController } from "./typing.js";

export type GetReplyDeps = {
  resolveReplyDirectives: typeof resolveReplyDirectives;
  handleInlineActions: typeof handleInlineActions;
  initSessionState: typeof initSessionState;
  resolveSessionModelOverrideSnapshot: typeof resolveSessionModelOverrideSnapshot;
  runPreparedReply: typeof runPreparedReply;
  // Optional test seams for dependencies that Bun's vi.mock cannot replace
  // (async importOriginal factories hang the Bun runtime). When omitted,
  // the production implementation is used exactly as before, so default
  // behavior is unchanged.
  emitResetCommandHooks?: typeof import("./commands-core.js").emitResetCommandHooks;
  loadConfig?: typeof loadConfig;
  resolveSessionAgentId?: typeof resolveSessionAgentId;
  resolveAgentDir?: typeof resolveAgentDir;
  resolveAgentWorkspaceDir?: typeof resolveAgentWorkspaceDir;
  resolveAgentSkillsFilter?: typeof resolveAgentSkillsFilter;
  resolveModelRefFromString?: typeof resolveModelRefFromString;
  resolveAgentTimeoutMs?: typeof resolveAgentTimeoutMs;
  ensureAgentWorkspace?: typeof ensureAgentWorkspace;
  resolveChannelModelOverride?: typeof resolveChannelModelOverride;
  resolveCommandAuthorization?: typeof resolveCommandAuthorization;
  resolveDefaultModel?: typeof resolveDefaultModel;
  finalizeInboundContext?: typeof finalizeInboundContext;
  emitPreAgentMessageHooks?: typeof emitPreAgentMessageHooks;
  fireAndForgetHook?: typeof import("../../hooks/fire-and-forget.js").fireAndForgetHook;
  createInternalHookEvent?: typeof import("../../hooks/internal-hooks.js").createInternalHookEvent;
  triggerInternalHook?: typeof import("../../hooks/internal-hooks.js").triggerInternalHook;
  getGlobalHookRunner?: typeof import("../../plugins/hook-runner-global.js").getGlobalHookRunner;
  applyMediaUnderstanding?: typeof import("../../media-understanding/apply.runtime.js").applyMediaUnderstanding;
  applyLinkUnderstanding?: typeof import("../../link-understanding/apply.runtime.js").applyLinkUnderstanding;
  loadModelCatalog?: typeof import("../../agents/model-catalog.js").loadModelCatalog;
  hasInlineableNativeAudio?: typeof import("../../media/native-audio.js").hasInlineableNativeAudio;
};

const defaultGetReplyDeps: GetReplyDeps = {
  resolveReplyDirectives,
  handleInlineActions,
  initSessionState,
  resolveSessionModelOverrideSnapshot,
  runPreparedReply,
};

type ResetCommandAction = "new" | "reset";

let sessionResetModelRuntimePromise: Promise<
  typeof import("./session-reset-model.runtime.js")
> | null = null;
let stageSandboxMediaRuntimePromise: Promise<
  typeof import("./stage-sandbox-media.runtime.js")
> | null = null;

function loadSessionResetModelRuntime() {
  sessionResetModelRuntimePromise ??= import("./session-reset-model.runtime.js");
  return sessionResetModelRuntimePromise;
}

function loadStageSandboxMediaRuntime() {
  stageSandboxMediaRuntimePromise ??= import("./stage-sandbox-media.runtime.js");
  return stageSandboxMediaRuntimePromise;
}

let hookRunnerGlobalPromise: Promise<typeof import("../../plugins/hook-runner-global.js")> | null =
  null;
let originRoutingPromise: Promise<typeof import("./origin-routing.js")> | null = null;

function loadHookRunnerGlobal() {
  hookRunnerGlobalPromise ??= import("../../plugins/hook-runner-global.js");
  return hookRunnerGlobalPromise;
}

function loadOriginRouting() {
  originRoutingPromise ??= import("./origin-routing.js");
  return originRoutingPromise;
}

function mergeSkillFilters(channelFilter?: string[], agentFilter?: string[]): string[] | undefined {
  const normalize = (list?: string[]) => {
    if (!Array.isArray(list)) {
      return undefined;
    }
    return normalizeStringEntries(list);
  };
  const channel = normalize(channelFilter);
  const agent = normalize(agentFilter);
  if (!channel && !agent) {
    return undefined;
  }
  if (!channel) {
    return agent;
  }
  if (!agent) {
    return channel;
  }
  if (channel.length === 0 || agent.length === 0) {
    return [];
  }
  const agentSet = new Set(agent);
  return channel.filter((name) => agentSet.has(name));
}

function hasInboundMedia(ctx: MsgContext): boolean {
  return Boolean(
    ctx.StickerMediaIncluded ||
    ctx.Sticker ||
    ctx.MediaPath?.trim() ||
    ctx.MediaUrl?.trim() ||
    ctx.MediaPaths?.some((value) => value?.trim()) ||
    ctx.MediaUrls?.some((value) => value?.trim()) ||
    ctx.MediaTypes?.length,
  );
}

function hasLinkCandidate(ctx: MsgContext): boolean {
  const message = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body;
  if (!message) {
    return false;
  }
  return /\bhttps?:\/\/\S+/i.test(message);
}

async function applyMediaUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  activeModel: { provider: string; model: string };
  applyMediaUnderstanding?: GetReplyDeps["applyMediaUnderstanding"];
  loadModelCatalog?: GetReplyDeps["loadModelCatalog"];
  hasInlineableNativeAudio?: GetReplyDeps["hasInlineableNativeAudio"];
}): Promise<boolean> {
  if (!hasInboundMedia(params.ctx)) {
    return false;
  }
  const loadModelCatalogFn = params.loadModelCatalog ?? loadModelCatalog;
  const hasInlineableNativeAudioFn = params.hasInlineableNativeAudio ?? hasInlineableNativeAudio;
  const catalog = await loadModelCatalogFn({ config: params.cfg });
  const modelEntry = findModelInCatalog(
    catalog,
    params.activeModel.provider,
    params.activeModel.model,
  );
  const audioPaths = params.ctx.MediaPaths ?? (params.ctx.MediaPath ? [params.ctx.MediaPath] : []);
  const audioTypes = params.ctx.MediaTypes;
  const nativeAudio = modelSupportsAudio(modelEntry)
    ? await hasInlineableNativeAudioFn({
        paths: audioPaths,
        types: audioTypes,
        fallbackType: params.ctx.MediaType,
        workspaceDir: params.agentDir,
      })
    : false;
  const { applyMediaUnderstanding } =
    params.applyMediaUnderstanding != null
      ? { applyMediaUnderstanding: params.applyMediaUnderstanding }
      : await import("../../media-understanding/apply.runtime.js");
  await applyMediaUnderstanding({ ...params, skipAudio: nativeAudio });
  return true;
}

async function applyLinkUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  applyLinkUnderstanding?: GetReplyDeps["applyLinkUnderstanding"];
}): Promise<boolean> {
  if (!hasLinkCandidate(params.ctx)) {
    return false;
  }
  const { applyLinkUnderstanding } =
    params.applyLinkUnderstanding != null
      ? { applyLinkUnderstanding: params.applyLinkUnderstanding }
      : await import("../../link-understanding/apply.runtime.js");
  await applyLinkUnderstanding(params);
  return true;
}

/**
 * Resolve the effective active model BEFORE media understanding runs.
 *
 * The reply path only resolves the session-stored `modelOverride`/
 * `providerOverride` (via directives) AFTER initSessionState, but the media
 * decision (native audio inlining vs Deepgram STT) needs the real active
 * model at inbound time. A user who switched `/model agy-gemini-3.8-flash`
 * must get `skipAudio: true` even when the global default model has no audio
 * input support. Priority mirrors the reply path: explicit heartbeat model >
 * session-stored override (incl. parent fallback) > channel override >
 * defaults.
 */
function resolveEffectiveActiveMediaModel(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  snapshot: SessionModelOverrideSnapshot;
  provider: string;
  model: string;
  defaultProvider: string;
  aliasIndex: ModelAliasIndex;
  hasResolvedHeartbeatModelOverride: boolean;
  resolveChannelModelOverride?: GetReplyDeps["resolveChannelModelOverride"];
}): { provider: string; model: string } {
  const { provider, model } = params;
  const resolveChannelModelOverrideFn =
    params.resolveChannelModelOverride ?? resolveChannelModelOverride;
  if (params.hasResolvedHeartbeatModelOverride) {
    return { provider, model };
  }
  const { sessionEntry, sessionStore, sessionKey, groupResolution } = params.snapshot;
  const hasSessionModelOverride = Boolean(
    sessionEntry?.modelOverride?.trim() || sessionEntry?.providerOverride?.trim(),
  );
  if (hasSessionModelOverride) {
    const stored = resolveStoredModelOverride({
      sessionEntry,
      sessionStore,
      sessionKey,
      parentSessionKey: params.ctx.ParentSessionKey,
      defaultProvider: params.defaultProvider,
    });
    if (stored?.model) {
      return { provider: stored.provider || params.defaultProvider, model: stored.model };
    }
    // Session override present but unresolvable — keep the current default.
    // The channel override is intentionally skipped here, matching the reply
    // path gating (`hasSessionModelOverride`).
    return { provider, model };
  }
  const channelModelOverride = resolveChannelModelOverrideFn({
    cfg: params.cfg,
    channel:
      groupResolution?.channel ??
      sessionEntry?.channel ??
      sessionEntry?.origin?.provider ??
      (typeof params.ctx.OriginatingChannel === "string"
        ? params.ctx.OriginatingChannel
        : undefined) ??
      params.ctx.Provider,
    groupId: groupResolution?.id ?? sessionEntry?.groupId,
    groupChatType: sessionEntry?.chatType ?? params.ctx.ChatType,
    groupChannel: sessionEntry?.groupChannel ?? params.ctx.GroupChannel,
    groupSubject: sessionEntry?.subject ?? params.ctx.GroupSubject,
    parentSessionKey: params.ctx.ParentSessionKey,
  });
  if (channelModelOverride) {
    const resolved = resolveModelRefFromString({
      raw: channelModelOverride.model,
      defaultProvider: params.defaultProvider,
      aliasIndex: params.aliasIndex,
    });
    if (resolved) {
      return { provider: resolved.ref.provider, model: resolved.ref.model };
    }
  }
  return { provider, model };
}

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
  deps: Partial<GetReplyDeps> = {},
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const resolvedDeps = { ...defaultGetReplyDeps, ...deps };
  const isFastTestEnv = process.env.DENNOU_TEST_FAST === "1";
  const loadConfigFn = resolvedDeps.loadConfig ?? loadConfig;
  const resolveSessionAgentIdFn = resolvedDeps.resolveSessionAgentId ?? resolveSessionAgentId;
  const resolveAgentSkillsFilterFn =
    resolvedDeps.resolveAgentSkillsFilter ?? resolveAgentSkillsFilter;
  const resolveDefaultModelFn = resolvedDeps.resolveDefaultModel ?? resolveDefaultModel;
  const resolveModelRefFromStringFn =
    resolvedDeps.resolveModelRefFromString ?? resolveModelRefFromString;
  const resolveAgentWorkspaceDirFn =
    resolvedDeps.resolveAgentWorkspaceDir ?? resolveAgentWorkspaceDir;
  const ensureAgentWorkspaceFn = resolvedDeps.ensureAgentWorkspace ?? ensureAgentWorkspace;
  const resolveAgentDirFn = resolvedDeps.resolveAgentDir ?? resolveAgentDir;
  const resolveAgentTimeoutMsFn = resolvedDeps.resolveAgentTimeoutMs ?? resolveAgentTimeoutMs;
  const finalizeInboundContextFn = resolvedDeps.finalizeInboundContext ?? finalizeInboundContext;
  const resolveCommandAuthorizationFn =
    resolvedDeps.resolveCommandAuthorization ?? resolveCommandAuthorization;
  const resolveChannelModelOverrideFn =
    resolvedDeps.resolveChannelModelOverride ?? resolveChannelModelOverride;
  const cfg =
    configOverride == null
      ? loadConfigFn()
      : (applyMergePatch(loadConfigFn(), configOverride) as OpenClawConfig);
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const agentSessionKey = targetSessionKey || ctx.SessionKey;
  const agentId = resolveSessionAgentIdFn({
    sessionKey: agentSessionKey,
    config: cfg,
  });
  const mergedSkillFilter = mergeSkillFilters(
    opts?.skillFilter,
    resolveAgentSkillsFilter(cfg, agentId),
  );
  const resolvedOpts =
    mergedSkillFilter !== undefined ? { ...opts, skillFilter: mergedSkillFilter } : opts;
  const agentCfg = cfg.agents?.defaults;
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModelFn({
    cfg,
    agentId,
  });
  let provider = defaultProvider;
  let model = defaultModel;
  let hasResolvedHeartbeatModelOverride = false;
  if (opts?.isHeartbeat) {
    // Prefer the resolved per-agent heartbeat model passed from the heartbeat runner,
    // fall back to the global defaults heartbeat model for backward compatibility.
    const heartbeatRaw =
      opts.heartbeatModelOverride?.trim() ?? agentCfg?.heartbeat?.model?.trim() ?? "";
    const heartbeatRef = heartbeatRaw
      ? resolveModelRefFromStringFn({
          raw: heartbeatRaw,
          defaultProvider,
          aliasIndex,
        })
      : null;
    if (heartbeatRef) {
      provider = heartbeatRef.ref.provider;
      model = heartbeatRef.ref.model;
      hasResolvedHeartbeatModelOverride = true;
    }
  }

  const workspaceDirRaw = resolveAgentWorkspaceDirFn(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspace = await ensureAgentWorkspaceFn({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
  });
  const workspaceDir = workspace.dir;
  const agentDir = resolveAgentDirFn(cfg, agentId);
  const timeoutMs = resolveAgentTimeoutMsFn({ cfg, overrideSeconds: opts?.timeoutOverrideSeconds });
  const configuredTypingSeconds =
    agentCfg?.typingIntervalSeconds ?? sessionCfg?.typingIntervalSeconds;
  const typingIntervalSeconds =
    typeof configuredTypingSeconds === "number" ? configuredTypingSeconds : 6;
  const typing = createTypingController({
    onReplyStart: opts?.onReplyStart,
    onCleanup: opts?.onTypingCleanup,
    typingIntervalSeconds,
    silentToken: SILENT_REPLY_TOKEN,
    log: defaultRuntime.log,
  });
  opts?.onTypingController?.(typing);

  const finalized = finalizeInboundContextFn(ctx);

  if (!isFastTestEnv) {
    // Resolve the effective active model (session-stored /model override,
    // channel override) BEFORE media understanding so native-audio inlining
    // (`skipAudio`) is decided against the model the session is actually
    // using, not the global default. See #native-audio.
    const sessionModelOverrideSnapshot = hasInboundMedia(finalized)
      ? resolvedDeps.resolveSessionModelOverrideSnapshot({
          ctx: finalized,
          cfg,
        })
      : null;
    const effectiveActiveModel = sessionModelOverrideSnapshot
      ? resolveEffectiveActiveMediaModel({
          ctx: finalized,
          cfg,
          snapshot: sessionModelOverrideSnapshot,
          provider,
          model,
          defaultProvider,
          aliasIndex,
          hasResolvedHeartbeatModelOverride,
          resolveChannelModelOverride: resolvedDeps.resolveChannelModelOverride ?? undefined,
        })
      : { provider, model };
    await applyMediaUnderstandingIfNeeded({
      ctx: finalized,
      cfg,
      agentDir,
      activeModel: effectiveActiveModel,
      applyMediaUnderstanding: resolvedDeps.applyMediaUnderstanding ?? undefined,
      loadModelCatalog: resolvedDeps.loadModelCatalog ?? undefined,
      hasInlineableNativeAudio: resolvedDeps.hasInlineableNativeAudio ?? undefined,
    });
    await applyLinkUnderstandingIfNeeded({
      ctx: finalized,
      cfg,
      applyLinkUnderstanding: resolvedDeps.applyLinkUnderstanding ?? undefined,
    });
  }
  const emitPreAgentMessageHooksFn =
    resolvedDeps.emitPreAgentMessageHooks ?? emitPreAgentMessageHooks;
  const messageHookDeps = {
    ...(resolvedDeps.fireAndForgetHook
      ? { fireAndForgetHook: resolvedDeps.fireAndForgetHook }
      : {}),
    ...(resolvedDeps.createInternalHookEvent
      ? { createInternalHookEvent: resolvedDeps.createInternalHookEvent }
      : {}),
    ...(resolvedDeps.triggerInternalHook
      ? { triggerInternalHook: resolvedDeps.triggerInternalHook }
      : {}),
  };
  emitPreAgentMessageHooksFn(
    {
      ctx: finalized,
      cfg,
      isFastTestEnv,
    },
    messageHookDeps,
  );

  const commandAuthorized = finalized.CommandAuthorized;
  resolveCommandAuthorizationFn({
    ctx: finalized,
    cfg,
    commandAuthorized,
  });
  const sessionState = await resolvedDeps.initSessionState({
    ctx: finalized,
    cfg,
    commandAuthorized,
  });
  let {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    bodyStripped,
  } = sessionState;

  if (resetTriggered && bodyStripped?.trim()) {
    const { applyResetModelOverride } = await loadSessionResetModelRuntime();
    await applyResetModelOverride({
      cfg,
      agentId,
      resetTriggered,
      bodyStripped,
      sessionCtx,
      ctx: finalized,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      defaultProvider,
      defaultModel,
      aliasIndex,
    });
  }

  const channelModelOverride = resolveChannelModelOverrideFn({
    cfg,
    channel:
      groupResolution?.channel ??
      sessionEntry.channel ??
      sessionEntry.origin?.provider ??
      (typeof finalized.OriginatingChannel === "string"
        ? finalized.OriginatingChannel
        : undefined) ??
      finalized.Provider,
    groupId: groupResolution?.id ?? sessionEntry.groupId,
    groupChatType: sessionEntry.chatType ?? sessionCtx.ChatType ?? finalized.ChatType,
    groupChannel: sessionEntry.groupChannel ?? sessionCtx.GroupChannel ?? finalized.GroupChannel,
    groupSubject: sessionEntry.subject ?? sessionCtx.GroupSubject ?? finalized.GroupSubject,
    parentSessionKey: sessionCtx.ParentSessionKey,
  });
  const hasSessionModelOverride = Boolean(
    sessionEntry.modelOverride?.trim() || sessionEntry.providerOverride?.trim(),
  );
  if (!hasResolvedHeartbeatModelOverride && !hasSessionModelOverride && channelModelOverride) {
    const resolved = resolveModelRefFromStringFn({
      raw: channelModelOverride.model,
      defaultProvider,
      aliasIndex,
    });
    if (resolved) {
      provider = resolved.ref.provider;
      model = resolved.ref.model;
    }
  }

  const directiveResult = await resolvedDeps.resolveReplyDirectives({
    ctx: finalized,
    cfg,
    agentId,
    agentDir,
    workspaceDir,
    agentCfg,
    sessionCtx,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    commandAuthorized,
    defaultProvider,
    defaultModel,
    aliasIndex,
    provider,
    model,
    hasResolvedHeartbeatModelOverride,
    typing,
    opts: resolvedOpts,
    skillFilter: mergedSkillFilter,
  });
  if (directiveResult.kind === "reply") {
    return directiveResult.reply;
  }

  let {
    commandSource,
    command,
    allowTextCommands,
    skillCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    provider: resolvedProvider,
    model: resolvedModel,
    modelState,
    contextTokens,
    inlineStatusRequested,
    directiveAck,
    perMessageQueueMode,
    perMessageQueueOptions,
  } = directiveResult.result;
  provider = resolvedProvider;
  model = resolvedModel;

  const maybeEmitMissingResetHooks = async () => {
    if (!resetTriggered || !command.isAuthorizedSender || command.resetHookTriggered) {
      return;
    }
    const resetMatch = command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
    if (!resetMatch) {
      return;
    }
    const { emitResetCommandHooks } =
      resolvedDeps.emitResetCommandHooks != null
        ? { emitResetCommandHooks: resolvedDeps.emitResetCommandHooks }
        : await import("./commands-core.runtime.js");
    const action: ResetCommandAction = resetMatch[1] === "reset" ? "reset" : "new";
    await emitResetCommandHooks({
      action,
      ctx,
      cfg,
      command,
      sessionKey,
      sessionEntry,
      previousSessionEntry,
      workspaceDir,
    });
  };

  const inlineActionResult = await resolvedDeps.handleInlineActions({
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    isGroup,
    opts: resolvedOpts,
    typing,
    allowTextCommands,
    inlineStatusRequested,
    command,
    skillCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation: () => defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    directiveAck,
    abortedLastRun,
    skillFilter: mergedSkillFilter,
  });
  if (inlineActionResult.kind === "reply") {
    await maybeEmitMissingResetHooks();
    return inlineActionResult.reply;
  }
  await maybeEmitMissingResetHooks();
  directives = inlineActionResult.directives;
  abortedLastRun = inlineActionResult.abortedLastRun ?? abortedLastRun;

  // Allow plugins to intercept and return a synthetic reply before the LLM runs.
  const getGlobalHookRunnerFn =
    resolvedDeps.getGlobalHookRunner ?? (await loadHookRunnerGlobal()).getGlobalHookRunner;
  const hookRunner = getGlobalHookRunnerFn();
  if (hookRunner?.hasHooks("before_agent_reply")) {
    const { resolveOriginMessageProvider } = await loadOriginRouting();
    const hookMessageProvider = resolveOriginMessageProvider({
      originatingChannel: sessionCtx.OriginatingChannel,
      provider: sessionCtx.Provider,
    });
    const hookResult = await hookRunner.runBeforeAgentReply(
      { cleanedBody },
      {
        agentId,
        sessionKey: agentSessionKey,
        sessionId,
        workspaceDir,
        messageProvider: hookMessageProvider,
        trigger: opts?.isHeartbeat ? "heartbeat" : "user",
        channelId: hookMessageProvider,
      },
    );
    if (hookResult?.handled) {
      return hookResult.reply ?? { text: SILENT_REPLY_TOKEN };
    }
  }

  if (sessionKey && hasInboundMedia(ctx)) {
    const { stageSandboxMedia } = await loadStageSandboxMediaRuntime();
    await stageSandboxMedia({
      ctx,
      sessionCtx,
      cfg,
      sessionKey,
      workspaceDir,
    });
  }

  return resolvedDeps.runPreparedReply({
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    sessionCfg,
    commandAuthorized,
    command,
    commandSource,
    allowTextCommands,
    directives,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    elevatedEnabled,
    elevatedAllowed,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    modelState,
    provider,
    model,
    perMessageQueueMode,
    perMessageQueueOptions,
    typing,
    opts: resolvedOpts,
    defaultProvider,
    defaultModel,
    timeoutMs,
    isNewSession,
    resetTriggered,
    systemSent,
    sessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    storePath,
    workspaceDir,
    abortedLastRun,
  });
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import { runBeforeToolCallHook } from "../agents/pi-tools.before-tool-call.js";
import { resolveToolLoopDetectionConfig } from "../agents/pi-tools.js";
import { isKnownCoreToolId } from "../agents/tool-catalog.js";
import { applyOwnerOnlyToolPolicy } from "../agents/tool-policy.js";
import { ToolInputError } from "../agents/tools/common.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { loadConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { logWarn } from "../logger.js";
import { isTestDefaultMemorySlotDisabled } from "../plugins/config-state.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
} from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  getHeader,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const DEFAULT_BODY_BYTES = 2 * 1024 * 1024;
const MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);

type ToolsInvokeBody = {
  tool?: unknown;
  action?: unknown;
  args?: unknown;
  sessionKey?: unknown;
  dryRun?: unknown;
};

function resolveSessionKeyFromBody(body: ToolsInvokeBody): string | undefined {
  if (typeof body.sessionKey === "string" && body.sessionKey.trim()) {
    return body.sessionKey.trim();
  }
  return undefined;
}

function resolveMemoryToolDisableReasons(
  cfg: ReturnType<typeof loadConfig>,
  isTestDefaultMemorySlotDisabledImpl: typeof isTestDefaultMemorySlotDisabled = isTestDefaultMemorySlotDisabled,
): string[] {
  if (!process.env.VITEST) {
    return [];
  }
  const reasons: string[] = [];
  const plugins = cfg.plugins;
  const slotRaw = plugins?.slots?.memory;
  const slotDisabled =
    slotRaw === null || (typeof slotRaw === "string" && slotRaw.trim().toLowerCase() === "none");
  const pluginsDisabled = plugins?.enabled === false;
  const defaultDisabled = isTestDefaultMemorySlotDisabledImpl(cfg);

  if (pluginsDisabled) {
    reasons.push("plugins.enabled=false");
  }
  if (slotDisabled) {
    reasons.push(slotRaw === null ? "plugins.slots.memory=null" : 'plugins.slots.memory="none"');
  }
  if (!pluginsDisabled && !slotDisabled && defaultDisabled) {
    reasons.push("memory plugin disabled by test default");
  }
  return reasons;
}

function mergeActionIntoArgsIfSupported(params: {
  toolSchema: unknown;
  action: string | undefined;
  args: Record<string, unknown>;
}): Record<string, unknown> {
  const { toolSchema, action, args } = params;
  if (!action) {
    return args;
  }
  if (args.action !== undefined) {
    return args;
  }
  // TypeBox schemas are plain objects; many tools define an `action` property.
  const schemaObj = toolSchema as { properties?: Record<string, unknown> } | null;
  const hasAction = Boolean(
    schemaObj &&
    typeof schemaObj === "object" &&
    schemaObj.properties &&
    "action" in schemaObj.properties,
  );
  if (!hasAction) {
    return args;
  }
  return { ...args, action };
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || String(err);
  }
  if (typeof err === "string") {
    return err;
  }
  return String(err);
}

function resolveToolInputErrorStatus(err: unknown): number | null {
  if (err instanceof ToolInputError) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : 400;
  }
  if (typeof err !== "object" || err === null || !("name" in err)) {
    return null;
  }
  const name = (err as { name?: unknown }).name;
  if (name !== "ToolInputError" && name !== "ToolAuthorizationError") {
    return null;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") {
    return status;
  }
  return name === "ToolAuthorizationError" ? 403 : 400;
}

export type ToolsInvokeHttpDeps = {
  authorizeHttpGatewayConnect?: typeof authorizeHttpGatewayConnect;
  loadConfig?: typeof loadConfig;
  resolveMainSessionKey?: typeof resolveMainSessionKey;
  resolveToolLoopDetectionConfig?: typeof resolveToolLoopDetectionConfig;
  runBeforeToolCallHook?: typeof runBeforeToolCallHook;
  isTestDefaultMemorySlotDisabled?: typeof isTestDefaultMemorySlotDisabled;
  createOpenClawTools?: typeof createOpenClawTools;
  logWarn?: typeof logWarn;
};

const defaultToolsInvokeHttpDeps: Required<ToolsInvokeHttpDeps> = {
  authorizeHttpGatewayConnect,
  loadConfig,
  resolveMainSessionKey,
  resolveToolLoopDetectionConfig,
  runBeforeToolCallHook,
  isTestDefaultMemorySlotDisabled,
  createOpenClawTools,
  logWarn,
};

export async function handleToolsInvokeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    maxBodyBytes?: number;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    deps?: ToolsInvokeHttpDeps;
  },
): Promise<boolean> {
  const deps = { ...defaultToolsInvokeHttpDeps, ...opts.deps };
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad_request", message: "Invalid request URL" }));
    return true;
  }
  if (url.pathname !== "/tools/invoke") {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const cfg = deps.loadConfig();
  const requestAuth = await authorizeGatewayHttpRequestOrReply(
    {
      req,
      res,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    },
    { authorizeHttpGatewayConnect: deps.authorizeHttpGatewayConnect },
  );
  if (!requestAuth) {
    return true;
  }

  // /tools/invoke intentionally uses the same shared-secret HTTP trust model as
  // the OpenAI-compatible APIs: token/password bearer auth is full operator
  // access for the gateway, not a narrower per-request scope boundary.
  const requestedScopes = resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod("agent", requestedScopes);
  if (!scopeAuth.allowed) {
    sendJson(res, 403, {
      ok: false,
      error: {
        type: "forbidden",
        message: `missing scope: ${scopeAuth.missingScope}`,
      },
    });
    return true;
  }

  const bodyUnknown = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? DEFAULT_BODY_BYTES);
  if (bodyUnknown === undefined) {
    return true;
  }
  const body = (bodyUnknown ?? {}) as ToolsInvokeBody;

  const toolName = typeof body.tool === "string" ? body.tool.trim() : "";
  if (!toolName) {
    sendInvalidRequest(res, "tools.invoke requires body.tool");
    return true;
  }

  if (process.env.VITEST && MEMORY_TOOL_NAMES.has(toolName)) {
    const reasons = resolveMemoryToolDisableReasons(cfg, deps.isTestDefaultMemorySlotDisabled);
    if (reasons.length > 0) {
      const suffix = reasons.length > 0 ? ` (${reasons.join(", ")})` : "";
      sendJson(res, 400, {
        ok: false,
        error: {
          type: "invalid_request",
          message: `memory tools are disabled in tests${suffix}.`,
        },
      });
      return true;
    }
  }

  const action = typeof body.action === "string" ? body.action.trim() : undefined;

  const argsRaw = body.args;
  const args =
    argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
      ? (argsRaw as Record<string, unknown>)
      : {};

  const rawSessionKey = resolveSessionKeyFromBody(body);
  const sessionKey =
    !rawSessionKey || rawSessionKey === "main" ? deps.resolveMainSessionKey(cfg) : rawSessionKey;

  // Resolve message channel/account hints (optional headers) for policy inheritance.
  const messageChannel = normalizeMessageChannel(getHeader(req, "x-dennou-message-channel") ?? "");
  const accountId = getHeader(req, "x-dennou-account-id")?.trim() || undefined;
  const agentTo = getHeader(req, "x-dennou-message-to")?.trim() || undefined;
  const agentThreadId = getHeader(req, "x-dennou-thread-id")?.trim() || undefined;
  const { agentId, tools } = resolveGatewayScopedTools(
    {
      cfg,
      sessionKey,
      messageProvider: messageChannel ?? undefined,
      accountId,
      agentTo,
      agentThreadId,
      allowGatewaySubagentBinding: true,
      allowMediaInvokeCommands: true,
      disablePluginTools: isKnownCoreToolId(toolName),
    },
    { createOpenClawTools: deps.createOpenClawTools },
  );
  // Owner semantics intentionally follow the same shared-secret HTTP contract
  // on this direct tool surface; SECURITY.md documents this as designed-as-is.
  const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, requestAuth);
  const gatewayFiltered = applyOwnerOnlyToolPolicy(tools, senderIsOwner);

  const tool = gatewayFiltered.find((t) => t.name === toolName);
  if (!tool) {
    sendJson(res, 404, {
      ok: false,
      error: { type: "not_found", message: `Tool not available: ${toolName}` },
    });
    return true;
  }

  try {
    const toolCallId = `http-${Date.now()}`;
    const toolArgs = mergeActionIntoArgsIfSupported({
      toolSchema: (tool as AnyAgentTool).parameters,
      action,
      args,
    });
    const hookResult = await deps.runBeforeToolCallHook({
      toolName,
      params: toolArgs,
      toolCallId,
      ctx: {
        agentId,
        sessionKey,
        loopDetection: deps.resolveToolLoopDetectionConfig({ cfg, agentId }),
      },
    });
    if (hookResult.blocked) {
      sendJson(res, 403, {
        ok: false,
        error: { type: "tool_call_blocked", message: hookResult.reason },
      });
      return true;
    }
    const result = await (tool as AnyAgentTool).execute?.(toolCallId, hookResult.params);
    sendJson(res, 200, { ok: true, result });
  } catch (err) {
    const inputStatus = resolveToolInputErrorStatus(err);
    if (inputStatus !== null) {
      sendJson(res, inputStatus, {
        ok: false,
        error: { type: "tool_error", message: getErrorMessage(err) || "invalid tool arguments" },
      });
      return true;
    }
    deps.logWarn(`tools-invoke: tool execution failed: ${String(err)}`);
    sendJson(res, 500, {
      ok: false,
      error: { type: "tool_error", message: "tool execution failed" },
    });
  }

  return true;
}

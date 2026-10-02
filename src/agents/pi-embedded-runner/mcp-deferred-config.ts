import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionContext,
  type LoadedMcpConfig,
  type McpExposure,
  type McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";

/**
 * MCP tools stay in the box (`exposure: "deferred"`) unless a server opts out.
 * The model only sees box labels (server name + one-line summary) via the Pi
 * SDK's automatic `mcp_servers` system-prompt section, and pulls tools out with
 * `tool_search` (BM25) when needed. This keeps full MCP tool schemas out of
 * every request.
 *
 * Note: label rendering needs no manual `## MCP Servers` section here. The MCP
 * extension fills `sections[MCP_SERVERS_SECTION]` on every `before_agent_start`
 * from the servers returned by `loadDeferredMcpConfig`, so adding our own
 * section would only duplicate the same labels for extra tokens.
 */

export const DEFERRED_MCP_EXPOSURE = "deferred" as const;

const VALID_EXPOSURES: ReadonlySet<string> = new Set(["codemode", "deferred", "direct", "hidden"]);

/** Discovery tools that reach boxed (non-direct) MCP tools. */
const DISCOVERY_TOOL_NAMES = ["codemode", "tool_search"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pi namespace of a server's tools: `mcp__<server>` with `-` replaced by `_`. Mirrors the SDK. */
function mcpNamespace(server: string): string {
  return server.replace(/-/g, "_");
}

function normalizeExposure(raw: unknown, ref: string, errors: string[]): McpExposure | undefined {
  const value =
    raw === undefined ? DEFERRED_MCP_EXPOSURE : raw === "codemode-deferred" ? "codemode" : raw;
  if (typeof value !== "string" || !VALID_EXPOSURES.has(value)) {
    errors.push(`${ref}: exposure must be one of codemode/deferred/direct/hidden`);
    return undefined;
  }
  return value as McpExposure;
}

function ingestServerRecord(params: {
  name: string;
  raw: unknown;
  ref: string;
  scope: McpServerEntry["scope"];
  source: string;
  forbidAuth: boolean;
  servers: Map<string, McpServerEntry>;
  errors: string[];
}): void {
  const { name, raw, ref, scope, source, forbidAuth, servers, errors } = params;
  if (!isRecord(raw)) {
    errors.push(`${ref}: server "${name}" must be an object`);
    return;
  }
  const exposure = normalizeExposure(raw.exposure, `${ref}: server "${name}"`, errors);
  if (!exposure) {
    return;
  }
  if (forbidAuth && raw.auth !== undefined) {
    errors.push(`${ref}: server "${name}": auth is only allowed in the global mcp.json`);
    return;
  }
  if (typeof raw.command !== "string" && typeof raw.url !== "string") {
    errors.push(`${ref}: server "${name}" needs a "command" (stdio) or "url" (http)`);
    return;
  }
  const clash = [...servers.keys()].find(
    (other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
  );
  if (clash) {
    errors.push(`${ref}: server "${name}" conflicts with "${clash}"`);
    return;
  }
  servers.set(name, {
    name,
    config: { ...raw, exposure } as McpServerEntry["config"],
    source,
    scope,
  });
}

function ingestMcpJsonFile(params: {
  filePath: string;
  scope: "global" | "project";
  forbidAuth: boolean;
  servers: Map<string, McpServerEntry>;
  errors: string[];
  autoEnableCodemode: { value?: boolean };
}): void {
  const { filePath, scope, forbidAuth, servers, errors, autoEnableCodemode } = params;
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    errors.push(`${filePath}: expected an object with an "mcpServers" object`);
    return;
  }
  if (typeof parsed.autoEnableCodemode === "boolean") {
    autoEnableCodemode.value = parsed.autoEnableCodemode;
  } else if (parsed.autoEnableCodemode !== undefined) {
    errors.push(`${filePath}: autoEnableCodemode must be a boolean`);
  }
  for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) {
    ingestServerRecord({
      name,
      raw,
      ref: filePath,
      scope,
      source: filePath,
      forbidAuth,
      servers,
      errors,
    });
  }
}

export function loadDeferredMcpConfig(params: {
  cfg?: OpenClawConfig;
  cwd: string;
  projectTrusted: boolean;
  /** Test seam. Defaults to the Pi SDK agent dir. */
  agentDir?: string;
  /** Test seam. Defaults to the OpenClaw state dir (`~/.openclaw/mcp.json`). */
  stateDir?: string;
}): LoadedMcpConfig {
  const agentDir = params.agentDir ?? getAgentDir();
  const stateDir = params.stateDir ?? resolveStateDir();
  const servers = new Map<string, McpServerEntry>();
  const errors: string[] = [];
  const autoEnableCodemode: { value?: boolean } = {};

  // Later sources win on name conflicts: global files, then state dir,
  // then OpenClaw config, then the trusted project file (most specific).
  ingestMcpJsonFile({
    filePath: path.join(agentDir, "mcp.json"),
    scope: "global",
    forbidAuth: false,
    servers,
    errors,
    autoEnableCodemode,
  });
  ingestMcpJsonFile({
    filePath: path.join(stateDir, "mcp.json"),
    scope: "global",
    forbidAuth: false,
    servers,
    errors,
    autoEnableCodemode,
  });

  const configured = params.cfg?.mcp?.servers;
  if (isRecord(configured)) {
    // Note: scope "extension" so /mcp edits to these servers stay session-local
    // instead of trying to rewrite a non-mcp.json source.
    for (const [name, raw] of Object.entries(configured)) {
      // Replace an earlier file entry of the same name (later source wins).
      const clash = [...servers.keys()].find(
        (other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
      );
      if (clash) {
        servers.delete(clash);
      }
      servers.delete(name);
      ingestServerRecord({
        name,
        raw,
        ref: "openclaw-config:mcp.servers",
        scope: "extension",
        source: "openclaw-config:mcp.servers",
        forbidAuth: false,
        servers,
        errors,
      });
    }
  }

  if (params.projectTrusted) {
    ingestMcpJsonFile({
      filePath: path.join(params.cwd, CONFIG_DIR_NAME, "mcp.json"),
      scope: "project",
      forbidAuth: true,
      servers,
      errors,
      autoEnableCodemode,
    });
  }

  return {
    servers: [...servers.values()],
    ...(autoEnableCodemode.value === undefined
      ? {}
      : { autoEnableCodemode: autoEnableCodemode.value }),
    errors,
  };
}

/** `loadConfig` for `createMcpExtension`: files plus `cfg.mcp.servers`, deferred by default. */
export function createDeferredMcpLoadConfig(cfg: OpenClawConfig | undefined) {
  return (ctx: ExtensionContext): LoadedMcpConfig =>
    loadDeferredMcpConfig({
      cfg,
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    });
}

type DiscoveryToolSession = {
  getAllTools(): Array<{ name: string }>;
  getActiveToolNames(): string[];
  setActiveToolsByName?(toolNames: string[]): void;
};

/**
 * Make sure the discovery tools (`codemode`, `tool_search`) are active when
 * registered, so boxed MCP tools are reachable. The MCP extension also
 * self-activates them from config on session start; this is the
 * belt-and-suspenders right after `bindExtensions({})`.
 */
export function ensureDiscoveryToolsActive(session: DiscoveryToolSession): void {
  const available = new Set(session.getAllTools().map((tool) => tool.name));
  const active = session.getActiveToolNames();
  const missing = DISCOVERY_TOOL_NAMES.filter(
    (name) => available.has(name) && !active.includes(name),
  );
  if (missing.length > 0) {
    session.setActiveToolsByName?.([...active, ...missing]);
  }
}

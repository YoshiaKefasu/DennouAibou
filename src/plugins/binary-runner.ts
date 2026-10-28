import { spawn as spawnChildProcess } from "node:child_process";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { PluginManifestToolDefinition } from "./manifest.js";
import { isPathInside, safeStatSync } from "./path-safety.js";
import type { OpenClawPluginDefinition, PluginLogger } from "./types.js";

/**
 * Stdio JSON-RPC bridge for `kind: "binary"` plugins (for example Go binaries).
 *
 * Wire format: newline-delimited JSON-RPC 2.0 over the child's stdin/stdout.
 * stderr is treated as host-visible diagnostics and forwarded to the plugin
 * logger.
 *
 * Host -> binary methods:
 * - `initialize` (best effort; ignored when the binary does not implement it)
 * - `tool.execute` `{ tool, arguments }` -> tool result
 * - `shutdown` (best effort before the process is terminated)
 */
const BINARY_PLUGIN_PROTOCOL_VERSION = 1;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 5_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

/** Optional timeout overrides (useful for slow daemons and for tests). */
export type BinaryPluginTimeouts = {
  initializeMs?: number;
  toolMs?: number;
  shutdownMs?: number;
  shutdownGraceMs?: number;
};

type ResolvedTimeouts = {
  initializeMs: number;
  toolMs: number;
  shutdownMs: number;
  shutdownGraceMs: number;
};

function resolveTimeouts(timeouts?: BinaryPluginTimeouts): ResolvedTimeouts {
  return {
    initializeMs: timeouts?.initializeMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
    toolMs: timeouts?.toolMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    shutdownMs: timeouts?.shutdownMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    shutdownGraceMs: timeouts?.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
  };
}

type BinaryStream = {
  write?: (chunk: string) => unknown;
  end?: () => unknown;
  on?: (event: "data" | "error", listener: (payload: unknown) => void) => void;
};

export type BinaryChildProcess = {
  stdin: BinaryStream | null;
  stdout: BinaryStream | null;
  stderr: BinaryStream | null;
  on: (event: "exit" | "error", listener: (...args: unknown[]) => void) => void;
  kill?: (signal?: NodeJS.Signals) => unknown;
};

export type BinarySpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: "pipe";
  windowsHide: boolean;
};

/** Test seam: defaults to `child_process.spawn`. */
export type BinarySpawn = (
  command: string,
  args: readonly string[],
  options: BinarySpawnOptions,
) => BinaryChildProcess;

const defaultBinarySpawn: BinarySpawn = (command, args, options) =>
  spawnChildProcess(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: "pipe",
    windowsHide: options.windowsHide,
  }) as unknown as BinaryChildProcess;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type JsonRpcMessage = {
  id?: number | string | null;
  method?: unknown;
  result?: unknown;
  error?: unknown;
};

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readRpcErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return asText(error);
}

function toToolResult(payload: unknown): AgentToolResult<unknown> {
  if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { content?: unknown }).content)
  ) {
    const raw = payload as { content: unknown[]; details?: unknown };
    const content = raw.content.flatMap((entry) => {
      if (typeof entry === "string") {
        return [{ type: "text" as const, text: entry }];
      }
      if (entry && typeof entry === "object" && "text" in entry) {
        const text = (entry as { text?: unknown }).text;
        if (typeof text === "string") {
          return [{ type: "text" as const, text }];
        }
      }
      return [{ type: "text" as const, text: asText(entry) }];
    });
    return {
      content: content.length > 0 ? content : [{ type: "text" as const, text: "" }],
      details: raw.details ?? {},
    };
  }
  const text =
    payload && typeof payload === "object" && "text" in payload
      ? asText((payload as { text?: unknown }).text)
      : asText(payload ?? "");
  return { content: [{ type: "text", text }], details: {} };
}

class BinaryPluginBridge {
  private child: BinaryChildProcess | null = null;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private startPromise: Promise<void> | null = null;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;

  constructor(
    private readonly params: {
      pluginId: string;
      executablePath: string;
      cwd: string;
      env: NodeJS.ProcessEnv;
      toolNames: readonly string[];
      logger: PluginLogger;
      spawn: BinarySpawn;
      timeouts: ResolvedTimeouts;
    },
  ) {}

  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    this.stdoutBuffer = "";
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    const child = this.params.spawn(this.params.executablePath, [], {
      cwd: this.params.cwd,
      env: this.params.env,
      stdio: "pipe",
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on?.("data", (chunk) => this.onStdout(chunk));
    child.stderr?.on?.("data", (chunk) => this.onStderr(chunk));
    child.on("error", (error) => {
      this.params.logger.warn(
        `[plugins] ${this.params.pluginId} binary plugin process error: ${readRpcErrorMessage(error)}`,
      );
      this.failAll(new Error(`binary plugin process error: ${readRpcErrorMessage(error)}`));
    });
    child.on("exit", (code, signal) => {
      this.child = null;
      this.resolveExit?.();
      this.resolveExit = null;
      if (this.pending.size > 0) {
        this.params.logger.warn(
          `[plugins] ${this.params.pluginId} binary plugin exited (code=${String(code)}, signal=${String(signal)}) with ${this.pending.size} pending request(s)`,
        );
      }
      this.failAll(
        new Error(
          `binary plugin exited (code=${String(code)}, signal=${String(signal)}) before responding`,
        ),
      );
    });

    // Optional handshake. Binaries that do not implement `initialize` still work.
    try {
      await this.request(
        "initialize",
        {
          protocolVersion: BINARY_PLUGIN_PROTOCOL_VERSION,
          pluginId: this.params.pluginId,
          tools: [...this.params.toolNames],
        },
        this.params.timeouts.initializeMs,
      );
    } catch (error) {
      this.params.logger.debug?.(
        `[plugins] ${this.params.pluginId} binary plugin initialize skipped: ${readRpcErrorMessage(error)}`,
      );
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || !stdin?.write) {
      return Promise.reject(new Error("binary plugin is not running"));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`binary plugin request timed out after ${timeoutMs}ms (${method})`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        stdin.write?.(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`failed to write to binary plugin stdin: ${readRpcErrorMessage(error)}`));
      }
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.startPromise = null;
    if (!child) {
      return;
    }
    try {
      await this.request("shutdown", {}, this.params.timeouts.shutdownMs);
    } catch {
      // The binary may not implement `shutdown`; fall through to termination.
    }
    try {
      child.stdin?.end?.();
    } catch {
      // ignore
    }
    const exited = await this.waitForExit(this.params.timeouts.shutdownGraceMs);
    if (!exited) {
      try {
        child.kill?.();
      } catch (error) {
        this.params.logger.warn(
          `[plugins] ${this.params.pluginId} binary plugin kill failed: ${readRpcErrorMessage(error)}`,
        );
      }
      await this.waitForExit(this.params.timeouts.shutdownGraceMs);
    }
    this.child = null;
    this.failAll(new Error("binary plugin stopped"));
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const exitPromise = this.exitPromise;
    if (!exitPromise) {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([exitPromise.then(() => true), timeout]);
    if (timer) {
      clearTimeout(timer);
    }
    return result;
  }

  private onStdout(chunk: unknown): void {
    this.stdoutBuffer += typeof chunk === "string" ? chunk : String(chunk);
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private onStderr(chunk: unknown): void {
    const text = (typeof chunk === "string" ? chunk : String(chunk)).trimEnd();
    if (text) {
      this.params.logger.warn(`[plugins] ${this.params.pluginId} binary stderr: ${text}`);
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.params.logger.warn(
        `[plugins] ${this.params.pluginId} binary plugin emitted non-JSON stdout: ${line}`,
      );
      return;
    }
    const rawId = message.id;
    const id =
      typeof rawId === "number"
        ? rawId
        : typeof rawId === "string" && rawId.trim() !== ""
          ? Number(rawId)
          : Number.NaN;
    if (!Number.isFinite(id)) {
      // Notification / server-initiated message: nothing to correlate.
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error != null) {
      pending.reject(new Error(readRpcErrorMessage(message.error)));
      return;
    }
    pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function createBinaryTool(params: {
  bridge: BinaryPluginBridge;
  pluginId: string;
  definition: PluginManifestToolDefinition;
  timeouts: ResolvedTimeouts;
}): AnyAgentTool {
  const parameters = (params.definition.parameters ?? {
    type: "object",
    properties: {},
  }) as TSchema;
  return {
    name: params.definition.name,
    label: params.definition.name,
    description:
      params.definition.description ??
      `${params.definition.name} (${params.pluginId} binary plugin tool)`,
    parameters,
    execute: async (_toolCallId: string, args: unknown) => {
      const result = await params.bridge.request(
        "tool.execute",
        { tool: params.definition.name, arguments: args ?? {} },
        params.timeouts.toolMs,
      );
      return toToolResult(result);
    },
  } as unknown as AnyAgentTool;
}

export type BinaryPluginDefinitionResult =
  | { ok: true; definition: OpenClawPluginDefinition }
  | { ok: false; error: string };

/**
 * Builds a synthetic plugin definition for a `kind: "binary"` manifest entry.
 *
 * `register()` only declares tools and the service; the subprocess is spawned
 * when the gateway starts plugin services and terminated on graceful shutdown.
 */
export function createBinaryPluginDefinition(params: {
  pluginId: string;
  name?: string;
  rootDir: string;
  executable?: string;
  tools?: readonly PluginManifestToolDefinition[];
  logger: PluginLogger;
  env?: NodeJS.ProcessEnv;
  spawn?: BinarySpawn;
  timeouts?: BinaryPluginTimeouts;
}): BinaryPluginDefinitionResult {
  const rawExecutable = params.executable?.trim();
  if (!rawExecutable) {
    return {
      ok: false,
      error: 'binary plugin requires a manifest "executable" path',
    };
  }
  const executablePath = path.resolve(params.rootDir, rawExecutable);
  if (!isPathInside(params.rootDir, executablePath)) {
    return {
      ok: false,
      error: `binary plugin executable escapes plugin root: ${rawExecutable}`,
    };
  }
  const stat = safeStatSync(executablePath);
  if (!stat || !stat.isFile()) {
    return {
      ok: false,
      error: `binary plugin executable not found: ${rawExecutable}`,
    };
  }

  const tools = params.tools ?? [];
  const timeouts = resolveTimeouts(params.timeouts);
  const bridge = new BinaryPluginBridge({
    pluginId: params.pluginId,
    executablePath,
    cwd: params.rootDir,
    env: params.env ?? process.env,
    toolNames: tools.map((tool) => tool.name),
    logger: params.logger,
    spawn: params.spawn ?? defaultBinarySpawn,
    timeouts,
  });

  return {
    ok: true,
    definition: {
      id: params.pluginId,
      name: params.name ?? params.pluginId,
      kind: "binary",
      register(api) {
        for (const tool of tools) {
          api.registerTool(
            createBinaryTool({
              bridge,
              pluginId: params.pluginId,
              definition: tool,
              timeouts,
            }),
            { names: [tool.name] },
          );
        }
        api.registerService({
          id: `${params.pluginId}-binary`,
          async start(ctx) {
            await bridge.start();
            ctx.logger.info(
              `[plugins] ${params.pluginId} binary plugin started (${executablePath})`,
            );
          },
          async stop() {
            await bridge.stop();
          },
        });
      },
    },
  };
}

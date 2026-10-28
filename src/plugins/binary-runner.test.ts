import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createBinaryPluginDefinition,
  type BinaryChildProcess,
  type BinarySpawn,
} from "./binary-runner.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makeTempDir,
  mkdirSafe,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "./loader.test-fixtures.js";
import type { OpenClawPluginApi, OpenClawPluginService, PluginLogger } from "./types.js";

const silentLogger: PluginLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

type RpcRequest = { id: number; method: string; params?: unknown };

type FakeStream = {
  written: string[];
  ended: boolean;
  write: (chunk: string) => boolean;
  end: () => void;
  on: (event: "data" | "error", listener: (payload: unknown) => void) => void;
  emit: (payload: unknown) => void;
};

function createFakeStream(): FakeStream {
  const listeners: Array<(payload: unknown) => void> = [];
  return {
    written: [],
    ended: false,
    write(chunk: string) {
      this.written.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
    on(event, listener) {
      if (event === "data") {
        listeners.push(listener);
      }
    },
    emit(payload: unknown) {
      for (const listener of listeners) {
        listener(payload);
      }
    },
  };
}

type FakeBinary = {
  child: BinaryChildProcess;
  spawn: BinarySpawn;
  requests: RpcRequest[];
  stdin: FakeStream;
  stdout: FakeStream;
  stderr: FakeStream;
  exit: (code?: number) => void;
  /** Respond to a request method; return false to leave it unanswered. */
  respond: (method: string, handler: (request: RpcRequest) => unknown | null) => void;
};

function createFakeBinary(): FakeBinary {
  const stdin = createFakeStream();
  const stdout = createFakeStream();
  const stderr = createFakeStream();
  const requests: RpcRequest[] = [];
  const responders = new Map<string, (request: RpcRequest) => unknown | null>();
  const exitHandlers: Array<(...args: unknown[]) => void> = [];

  const reply = (payload: unknown) => {
    stdout.emit(`${JSON.stringify(payload)}\n`);
  };

  stdin.write = (chunk: string) => {
    stdin.written.push(chunk);
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const request = JSON.parse(trimmed) as RpcRequest;
      requests.push(request);
      const responder = responders.get(request.method);
      const response = responder ? responder(request) : null;
      if (response) {
        reply({ jsonrpc: "2.0", id: request.id, result: response });
      }
    }
    return true;
  };

  const child = {
    stdin,
    stdout,
    stderr,
    on(event: "exit" | "error", listener: (...args: unknown[]) => void) {
      if (event === "exit") {
        exitHandlers.push(listener);
      }
    },
    kill() {
      for (const handler of exitHandlers) {
        handler(0, null);
      }
      return true;
    },
  } as unknown as BinaryChildProcess;

  return {
    child,
    spawn: () => child,
    requests,
    stdin,
    stdout,
    stderr,
    exit(code = 0) {
      for (const handler of exitHandlers) {
        handler(code, null);
      }
    },
    respond(method, handler) {
      responders.set(method, handler);
    },
  };
}

function createExecutableFixture(): { rootDir: string; executable: string } {
  const rootDir = makeTempDir();
  const executable = "bin/demo-binary";
  mkdirSafe(path.join(rootDir, "bin"));
  fs.writeFileSync(path.join(rootDir, executable), "#!/bin/sh\nexit 0\n", "utf-8");
  return { rootDir, executable };
}

function createApiCapture() {
  const tools: Array<{ tool: unknown; opts?: { names?: string[] } }> = [];
  const services: OpenClawPluginService[] = [];
  const api = {
    id: "demo-binary",
    name: "demo-binary",
    source: "fixture",
    registrationMode: "full",
    config: {},
    runtime: {},
    logger: silentLogger,
    registerTool(tool: unknown, opts?: { names?: string[] }) {
      tools.push({ tool, opts });
    },
    registerService(service: OpenClawPluginService) {
      services.push(service);
    },
  } as unknown as OpenClawPluginApi;
  return { api, tools, services };
}

const serviceContext = {
  config: {},
  stateDir: ".",
  logger: silentLogger,
} as unknown as Parameters<OpenClawPluginService["start"]>[0];

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

describe("createBinaryPluginDefinition", () => {
  it("rejects manifests without an executable path", () => {
    const rootDir = makeTempDir();
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      rootDir,
      logger: silentLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("executable");
    }
  });

  it("rejects an executable that escapes the plugin root", () => {
    const rootDir = makeTempDir();
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      rootDir,
      executable: "../outside-binary",
      logger: silentLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("escapes plugin root");
    }
  });

  it("rejects an executable that does not exist", () => {
    const rootDir = makeTempDir();
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      rootDir,
      executable: "bin/missing",
      logger: silentLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not found");
    }
  });

  it("builds a binary definition that declares tools and one service", () => {
    const { rootDir, executable } = createExecutableFixture();
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      name: "Demo Binary",
      rootDir,
      executable,
      tools: [{ name: "demo_ping", description: "ping", parameters: { type: "object" } }],
      logger: silentLogger,
      spawn: createFakeBinary().spawn,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.definition.kind).toBe("binary");
    expect(result.definition.id).toBe("demo-binary");

    const capture = createApiCapture();
    result.definition.register?.(capture.api);
    expect(capture.tools.map((entry) => entry.opts?.names?.[0])).toEqual(["demo_ping"]);
    expect(capture.services.map((service) => service.id)).toEqual(["demo-binary-binary"]);
  });

  it("round-trips tool calls over stdio JSON-RPC", async () => {
    const { rootDir, executable } = createExecutableFixture();
    const fake = createFakeBinary();
    fake.respond("initialize", () => ({}));
    fake.respond("tool.execute", (request) => {
      const params = request.params as { tool: string; arguments: { text: string } };
      return {
        content: [{ type: "text", text: `pong:${params.tool}:${params.arguments.text}` }],
        details: { bridged: true },
      };
    });
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      rootDir,
      executable,
      tools: [{ name: "demo_ping" }],
      logger: silentLogger,
      spawn: fake.spawn,
      timeouts: { initializeMs: 50, toolMs: 50, shutdownMs: 50, shutdownGraceMs: 50 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const capture = createApiCapture();
    result.definition.register?.(capture.api);
    const service = capture.services[0];
    await service.start(serviceContext);

    expect(fake.requests.map((request) => request.method)).toEqual(["initialize"]);
    const tool = capture.tools[0].tool as {
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
    };
    const toolResult = await tool.execute("call-1", { text: "hello" });
    expect(toolResult.content[0]?.text).toBe("pong:demo_ping:hello");
    expect(fake.requests.map((request) => request.method)).toEqual(["initialize", "tool.execute"]);

    fake.respond("shutdown", () => ({}));
    await service.stop?.(serviceContext);
    expect(fake.requests.map((request) => request.method)).toEqual([
      "initialize",
      "tool.execute",
      "shutdown",
    ]);
    expect(fake.stdin.ended).toBe(true);
  });

  it("surfaces JSON-RPC errors as tool failures", async () => {
    const { rootDir, executable } = createExecutableFixture();
    const fake = createFakeBinary();
    fake.respond("initialize", () => ({}));
    fake.respond("tool.execute", () => null);
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      rootDir,
      executable,
      tools: [{ name: "demo_ping" }],
      logger: silentLogger,
      spawn: fake.spawn,
      timeouts: { initializeMs: 50, toolMs: 50, shutdownMs: 50, shutdownGraceMs: 50 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const capture = createApiCapture();
    result.definition.register?.(capture.api);
    await capture.services[0].start(serviceContext);

    const tool = capture.tools[0].tool as {
      execute: (id: string, args: unknown) => Promise<unknown>;
    };
    // Unanswered request: the pending call must reject when the process exits.
    const pending = tool.execute("call-1", {});
    fake.exit(1);
    await expect(pending).rejects.toThrow(/exited/);
  });

  it("times out unanswered tool calls instead of hanging the agent", async () => {
    const { rootDir, executable } = createExecutableFixture();
    const fake = createFakeBinary();
    fake.respond("initialize", () => ({}));
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      rootDir,
      executable,
      tools: [{ name: "demo_ping" }],
      logger: silentLogger,
      spawn: fake.spawn,
      timeouts: { initializeMs: 50, toolMs: 20, shutdownMs: 20, shutdownGraceMs: 20 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const capture = createApiCapture();
    result.definition.register?.(capture.api);
    await capture.services[0].start(serviceContext);
    const tool = capture.tools[0].tool as {
      execute: (id: string, args: unknown) => Promise<unknown>;
    };
    await expect(tool.execute("call-1", {})).rejects.toThrow(/timed out/);
  });

  it("rejects tool calls when the binary is not running", async () => {
    const { rootDir, executable } = createExecutableFixture();
    const fake = createFakeBinary();
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      rootDir,
      executable,
      tools: [{ name: "demo_ping" }],
      logger: silentLogger,
      spawn: fake.spawn,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const capture = createApiCapture();
    result.definition.register?.(capture.api);
    const tool = capture.tools[0].tool as {
      execute: (id: string, args: unknown) => Promise<unknown>;
    };
    await expect(tool.execute("call-1", {})).rejects.toThrow(/not running/);
  });

  it("tolerates binaries without an initialize handler", async () => {
    const { rootDir, executable } = createExecutableFixture();
    const fake = createFakeBinary();
    fake.respond("tool.execute", () => ({ text: "ok" }));
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      rootDir,
      executable,
      tools: [{ name: "demo_ping" }],
      logger: silentLogger,
      spawn: fake.spawn,
      timeouts: { initializeMs: 20, toolMs: 50, shutdownMs: 20, shutdownGraceMs: 20 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const capture = createApiCapture();
    result.definition.register?.(capture.api);
    await capture.services[0].start(serviceContext);
    const tool = capture.tools[0].tool as {
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
    };
    const toolResult = await tool.execute("call-1", {});
    expect(toolResult.content[0]?.text).toBe("ok");
  });
});

describe("binary plugin loading", () => {
  function writeBinaryPluginFixture(params: { withExecutable: boolean }) {
    useNoBundledPlugins();
    const workspaceDir = makeTempDir();
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "demo-binary");
    mkdirSafe(path.join(pluginDir, "bin"));
    const executablePath = path.join(pluginDir, "bin", "demo-binary");
    fs.writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", "utf-8");
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        { name: "@openclaw/demo-binary", openclaw: { extensions: ["./bin/demo-binary"] } },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "dennou.plugin.json"),
      JSON.stringify(
        {
          id: "demo-binary",
          kind: "binary",
          ...(params.withExecutable ? { executable: "bin/demo-binary" } : {}),
          configSchema: { type: "object", additionalProperties: false, properties: {} },
          tools: [{ name: "demo_ping", description: "ping", parameters: { type: "object" } }],
        },
        null,
        2,
      ),
      "utf-8",
    );
    return { workspaceDir, pluginDir };
  }

  it("registers manifest tools and a service for kind: binary plugins", () => {
    const { workspaceDir } = writeBinaryPluginFixture({ withExecutable: true });
    const registry = loadOpenClawPlugins({
      workspaceDir,
      cache: false,
      onlyPluginIds: ["demo-binary"],
      config: { plugins: { entries: { "demo-binary": { enabled: true } } } },
    });

    const record = registry.plugins.find((plugin) => plugin.id === "demo-binary");
    expect(record?.status).toBe("loaded");
    expect(registry.tools.map((entry) => entry.names).flat()).toContain("demo_ping");
    expect(registry.services.map((entry) => entry.service.id)).toEqual(["demo-binary-binary"]);
  });

  it("fails the plugin load when the executable is missing from the manifest", () => {
    const { workspaceDir } = writeBinaryPluginFixture({ withExecutable: false });
    const registry = loadOpenClawPlugins({
      workspaceDir,
      cache: false,
      onlyPluginIds: ["demo-binary"],
      config: { plugins: { entries: { "demo-binary": { enabled: true } } } },
    });

    const record = registry.plugins.find((plugin) => plugin.id === "demo-binary");
    expect(record?.status).toBe("error");
    expect(record?.error).toContain("executable");
  });
});

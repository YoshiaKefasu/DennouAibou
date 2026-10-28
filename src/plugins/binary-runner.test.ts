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
  encoding: string | undefined;
  write: (chunk: string) => boolean;
  end: () => void;
  setEncoding: (encoding: string) => void;
  on: (event: "data" | "error", listener: (payload: unknown) => void) => void;
  emit: (payload: unknown) => void;
  emitError: (error: unknown) => void;
};

function createFakeStream(): FakeStream {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const stream: FakeStream = {
    written: [],
    ended: false,
    encoding: undefined,
    write(chunk: string) {
      stream.written.push(chunk);
      return true;
    },
    end() {
      stream.ended = true;
    },
    setEncoding(encoding: string) {
      stream.encoding = encoding;
    },
    on(event, listener) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
    },
    emit(payload: unknown) {
      for (const listener of listeners.get("data") ?? []) {
        listener(payload);
      }
    },
    emitError(error: unknown) {
      for (const listener of listeners.get("error") ?? []) {
        listener(error);
      }
    },
  };
  return stream;
}

type FakeChild = {
  child: BinaryChildProcess;
  requests: RpcRequest[];
  stdin: FakeStream;
  stdout: FakeStream;
  stderr: FakeStream;
  exit: (code?: number) => void;
  fail: (error: unknown) => void;
  /** Respond to a request method; return null to leave it unanswered. */
  respond: (method: string, handler: (request: RpcRequest) => unknown | null) => void;
};

type FakeBinary = FakeChild & { spawn: BinarySpawn };

function createFakeChild(): FakeChild {
  const stdin = createFakeStream();
  const stdout = createFakeStream();
  const stderr = createFakeStream();
  const requests: RpcRequest[] = [];
  const responders = new Map<string, (request: RpcRequest) => unknown | null>();
  const exitHandlers: Array<(...args: unknown[]) => void> = [];
  const errorHandlers: Array<(...args: unknown[]) => void> = [];

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
        return;
      }
      errorHandlers.push(listener);
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
    requests,
    stdin,
    stdout,
    stderr,
    exit(code = 0) {
      for (const handler of exitHandlers) {
        handler(code, null);
      }
    },
    fail(error: unknown) {
      for (const handler of errorHandlers) {
        handler(error);
      }
    },
    respond(method, handler) {
      responders.set(method, handler);
    },
  };
}

function createFakeBinary(): FakeBinary {
  const fakeChild = createFakeChild();
  return { ...fakeChild, spawn: () => fakeChild.child };
}

function createCaptureLogger() {
  const warnings: string[] = [];
  const logger: PluginLogger = {
    debug: () => {},
    info: () => {},
    warn: (message) => {
      warnings.push(message);
    },
    error: () => {},
  };
  return { logger, warnings };
}

function createExecutableFixture(): { rootDir: string; executable: string } {
  const rootDir = makeTempDir();
  const executable = "bin/demo-binary";
  mkdirSafe(path.join(rootDir, "bin"));
  fs.writeFileSync(path.join(rootDir, executable), "#!/bin/sh\nexit 0\n", "utf-8");
  return { rootDir, executable };
}

function createApiCapture(params: { pluginConfig?: Record<string, unknown> } = {}) {
  const tools: Array<{ tool: unknown; opts?: { names?: string[] } }> = [];
  const services: OpenClawPluginService[] = [];
  const api = {
    id: "demo-binary",
    name: "demo-binary",
    source: "fixture",
    registrationMode: "full",
    config: {},
    pluginConfig: params.pluginConfig,
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

  it("resolves the .exe sibling so platform-neutral manifests spawn on Windows", async () => {
    if (process.platform !== "win32") {
      return; // Windows-only: other platforms use the manifest path as-is.
    }
    const rootDir = makeTempDir();
    mkdirSafe(path.join(rootDir, "bin"));
    // `go build -o bin/kaden` writes `bin/kaden.exe` on Windows, and
    // child_process.spawn cannot start a PE file without the extension.
    const executablePath = path.join(rootDir, "bin", "kaden.exe");
    fs.writeFileSync(executablePath, "", "utf-8");
    const fake = createFakeBinary();
    fake.respond("initialize", () => ({}));
    const spawned: string[] = [];
    const spawn: BinarySpawn = (command) => {
      spawned.push(command);
      return fake.child;
    };
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      rootDir,
      executable: "bin/kaden",
      logger: silentLogger,
      spawn,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const capture = createApiCapture();
    result.definition.register?.(capture.api);
    await capture.services[0].start(serviceContext);
    expect(spawned).toEqual([executablePath]);
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
    expect(capture.tools.map((entry) => (entry.tool as { name: string }).name)).toEqual([
      "demo_ping",
    ]);
    // The registry adopts `tool.name`; passing an explicit `names` array would
    // register the same tool name twice.
    expect(capture.tools[0].opts).toBeUndefined();
    expect(capture.services.map((service) => service.id)).toEqual(["demo-binary-binary"]);
  });

  it("forwards the validated plugin config to the binary on initialize", async () => {
    const { rootDir, executable } = createExecutableFixture();
    const fake = createFakeBinary();
    fake.respond("initialize", () => ({}));
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      rootDir,
      executable,
      logger: silentLogger,
      spawn: fake.spawn,
      timeouts: { initializeMs: 50, toolMs: 50, shutdownMs: 20, shutdownGraceMs: 20 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const capture = createApiCapture({ pluginConfig: { voiceId: "aoi", retries: 3 } });
    result.definition.register?.(capture.api);
    await capture.services[0].start(serviceContext);

    const initialize = fake.requests.find((request) => request.method === "initialize");
    expect(initialize?.params).toMatchObject({
      pluginId: "demo-binary",
      config: { voiceId: "aoi", retries: 3 },
    });
  });

  it("decodes multi-byte UTF-8 split across stream chunks without mojibake", async () => {
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
      timeouts: { initializeMs: 50, toolMs: 50, shutdownMs: 20, shutdownGraceMs: 20 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const capture = createApiCapture();
    result.definition.register?.(capture.api);
    await capture.services[0].start(serviceContext);
    expect(fake.stdout.encoding).toBe("utf8");

    const tool = capture.tools[0].tool as {
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
    };
    const pending = tool.execute("call-1", {});
    const requestId = fake.requests.at(-1)?.id;
    expect(requestId).toBeTypeOf("number");

    const text = "こんにちは世界";
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { text } })}\n`;
    const bytes = Buffer.from(payload, "utf8");
    // Split inside the first 3-byte character so the first chunk ends with an
    // incomplete UTF-8 sequence.
    const splitAt = bytes.indexOf(Buffer.from("こ", "utf8")) + 1;
    expect(splitAt).toBeGreaterThan(0);
    fake.stdout.emit(bytes.subarray(0, splitAt));
    fake.stdout.emit(bytes.subarray(splitAt, splitAt + 2));
    fake.stdout.emit(bytes.subarray(splitAt + 2));

    const toolResult = await pending;
    expect(toolResult.content[0]?.text).toBe(text);
    expect(toolResult.content[0]?.text).not.toContain("\uFFFD");
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

  it("rejects start() when the process cannot be spawned and clears the child", async () => {
    const { rootDir, executable } = createExecutableFixture();
    const fake = createFakeBinary();
    const { logger } = createCaptureLogger();
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      rootDir,
      executable,
      tools: [{ name: "demo_ping" }],
      logger,
      spawn: fake.spawn,
      timeouts: { initializeMs: 20, toolMs: 20, shutdownMs: 20, shutdownGraceMs: 20 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const capture = createApiCapture();
    result.definition.register?.(capture.api);

    const startPromise = capture.services[0].start(serviceContext);
    fake.fail(new Error("spawn ENOENT"));

    await expect(startPromise).rejects.toThrow(/failed to start.*spawn ENOENT/);
    // The failed child must not stay registered as the live process.
    const tool = capture.tools[0].tool as {
      execute: (id: string, args: unknown) => Promise<unknown>;
    };
    await expect(tool.execute("call-1", {})).rejects.toThrow(/not running/);
  });

  it("logs stream errors instead of crashing on EPIPE", async () => {
    const { rootDir, executable } = createExecutableFixture();
    const fake = createFakeBinary();
    fake.respond("initialize", () => ({}));
    const { logger, warnings } = createCaptureLogger();
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      rootDir,
      executable,
      logger,
      spawn: fake.spawn,
      timeouts: { initializeMs: 20, toolMs: 20, shutdownMs: 20, shutdownGraceMs: 20 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const capture = createApiCapture();
    result.definition.register?.(capture.api);
    await capture.services[0].start(serviceContext);

    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => fake.stdin.emitError(epipe)).not.toThrow();
    expect(() => fake.stdout.emitError(epipe)).not.toThrow();
    expect(warnings.some((message) => message.includes("stdin error"))).toBe(true);
  });

  it("ignores exit events from a superseded child process", async () => {
    const { rootDir, executable } = createExecutableFixture();
    const first = createFakeChild();
    const second = createFakeChild();
    for (const fakeChild of [first, second]) {
      fakeChild.respond("initialize", () => ({}));
      fakeChild.respond("tool.execute", () => ({ text: "second-child" }));
      fakeChild.respond("shutdown", () => ({}));
    }
    const queue = [first, second];
    const spawn: BinarySpawn = () => (queue.shift() ?? second).child;
    const result = createBinaryPluginDefinition({
      pluginId: "demo-binary",
      rootDir,
      executable,
      tools: [{ name: "demo_ping" }],
      logger: silentLogger,
      spawn,
      timeouts: { initializeMs: 20, toolMs: 50, shutdownMs: 20, shutdownGraceMs: 20 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const capture = createApiCapture();
    result.definition.register?.(capture.api);
    const service = capture.services[0];
    await service.start(serviceContext);
    await service.stop?.(serviceContext);
    await service.start(serviceContext);

    // The first child's late exit must not tear down the restarted process.
    first.exit(1);
    const tool = capture.tools[0].tool as {
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
    };
    const toolResult = await tool.execute("call-1", {});
    expect(toolResult.content[0]?.text).toBe("second-child");
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
    expect(registry.tools.flatMap((entry) => entry.names)).toContain("demo_ping");
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

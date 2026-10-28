import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createBinaryPluginDefinition } from "./binary-runner.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makeTempDir,
  mkdirSafe,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "./loader.test-fixtures.js";
import type { OpenClawPluginApi, OpenClawPluginService, PluginLogger } from "./types.js";

/**
 * End-to-end coverage for the `kind: "binary"` plugin path using the real Go
 * daemon in `extensions/dennou-kaden`.
 *
 * The daemon binary lives in the gitignored `bin/` directory, so the suite
 * builds it with `build.mjs` when the toolchain is available and skips the
 * process tests otherwise.
 */
const KADEN_ROOT = path.resolve(process.cwd(), "extensions", "dennou-kaden");
const MANIFEST_PATH = path.join(KADEN_ROOT, "dennou.plugin.json");
const PACKAGE_PATH = path.join(KADEN_ROOT, "package.json");
const BIN_DIR = path.join(KADEN_ROOT, "bin");

type KadenTool = {
  name: string;
  execute: (
    toolCallId: string,
    args: unknown,
  ) => Promise<{ content: Array<{ type?: string; text?: string }>; details?: unknown }>;
};

type KadenManifest = {
  id: string;
  name: string;
  description: string;
  kind: string;
  executable: string;
  tools: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>;
  configSchema: { properties: Record<string, unknown> };
};

const silentLogger: PluginLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const serviceContext = {
  config: {},
  stateDir: ".",
  logger: silentLogger,
} as unknown as Parameters<OpenClawPluginService["start"]>[0];

function readManifest(): KadenManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as KadenManifest;
}

function findKadenBinary(): string | null {
  // `go build` writes `bin/kaden.exe` on Windows and `bin/kaden` elsewhere.
  for (const name of ["kaden.exe", "kaden"]) {
    const candidate = path.join(BIN_DIR, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function hasGoToolchain(): boolean {
  const result = spawnSync("go", ["version"], { encoding: "utf-8" });
  return result.status === 0;
}

function ensureKadenBinary(): string | null {
  const existing = findKadenBinary();
  if (existing) {
    return existing;
  }
  if (!hasGoToolchain()) {
    return null;
  }
  const build = spawnSync(process.execPath, ["build.mjs"], {
    cwd: KADEN_ROOT,
    encoding: "utf-8",
  });
  if (build.status !== 0) {
    throw new Error(
      `failed to build dennou-kaden: ${build.error?.message ?? build.stderr ?? build.stdout ?? "unknown error"}`,
    );
  }
  return findKadenBinary();
}

const kadenBinary = ensureKadenBinary();
const binarySkipReason =
  kadenBinary === null
    ? "extensions/dennou-kaden/bin is empty and the go toolchain is unavailable"
    : null;

/** Non-null accessor for the binary tests, which are skipped when it is absent. */
function requireKadenBinary(): string {
  if (!kadenBinary) {
    throw new Error(binarySkipReason ?? "dennou-kaden binary is unavailable");
  }
  return kadenBinary;
}

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

describe("dennou-kaden manifest", () => {
  it("declares a binary plugin with the daemon tools and config schema", () => {
    const manifest = readManifest();
    expect(manifest.id).toBe("dennou-kaden");
    expect(manifest.kind).toBe("binary");
    expect(manifest.executable).toBe("./bin/kaden");
    expect(manifest.tools.map((tool) => tool.name)).toEqual(["kaden_status", "kaden_call"]);
    expect(Object.keys(manifest.configSchema.properties).toSorted()).toEqual(["enabled", "port"]);
    for (const tool of manifest.tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(0);
      expect(tool.parameters?.type).toBe("object");
    }
  });

  it("publishes only the implemented kaden_call actions", () => {
    const manifest = readManifest();
    const call = manifest.tools.find((tool) => tool.name === "kaden_call");
    const properties = call?.parameters?.properties as { action?: { enum?: string[] } } | undefined;
    expect(call?.description).toBe("Report daemon status or ping it");
    expect(properties?.action?.enum).toEqual(["status", "ping"]);
  });

  it("ships a workspace package that points discovery at the daemon binary", () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf-8")) as {
      name: string;
      version: string;
      openclaw?: { extensions?: string[] };
    };
    expect(pkg.name).toBe("@openclaw/dennou-kaden");
    expect(pkg.version).toBe("2026.4.6");
    expect(pkg.openclaw?.extensions).toEqual(["./bin/kaden"]);
  });
});

describe.skipIf(binarySkipReason !== null)("dennou-kaden binary lifecycle", () => {
  it("spawns the real daemon, serves tools over stdio JSON-RPC, and shuts down", async () => {
    const manifest = readManifest();
    const tools: Array<{ tool: KadenTool }> = [];
    const services: OpenClawPluginService[] = [];
    const warnings: string[] = [];
    const logger: PluginLogger = {
      debug: () => {},
      info: () => {},
      warn: (message) => {
        warnings.push(message);
      },
      error: (message) => {
        warnings.push(message);
      },
    };
    const api = {
      id: "dennou-kaden",
      name: "dennou-kaden",
      source: "extensions/dennou-kaden",
      registrationMode: "full",
      config: {},
      pluginConfig: {},
      runtime: {},
      logger,
      registerTool(tool: KadenTool) {
        tools.push({ tool });
      },
      registerService(service: OpenClawPluginService) {
        services.push(service);
      },
    } as unknown as OpenClawPluginApi;

    const result = createBinaryPluginDefinition({
      pluginId: manifest.id,
      name: manifest.name,
      rootDir: KADEN_ROOT,
      executable: manifest.executable,
      tools: manifest.tools,
      logger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.definition.kind).toBe("binary");

    result.definition.register?.(api);
    expect(tools.map((entry) => entry.tool.name)).toEqual(["kaden_status", "kaden_call"]);
    expect(services.map((service) => service.id)).toEqual(["dennou-kaden-binary"]);

    const service = services[0];
    await service.start(serviceContext);
    try {
      const status = await tools[0].tool.execute("call-status", {});
      const statusText = status.content[0]?.text ?? "";
      expect(status.content[0]?.type).toBe("text");
      expect(statusText).toContain("dennou-kaden: ready");
      expect(statusText).toContain("go: go");
      expect(statusText).toContain("platform: ");
      expect(statusText).toContain("goroutines: ");
      expect(statusText).toContain("protocol: 1");
      expect(statusText).toContain("config: enabled=true port=0");
      const details = status.details as { pluginId?: string; state?: string } | undefined;
      expect(details?.pluginId).toBe("dennou-kaden");
      expect(details?.state).toContain("ready");

      const ping = await tools[1].tool.execute("call-ping", { action: "ping" });
      expect(ping.content[0]?.text).toContain("pong");

      const sessionStatus = await tools[1].tool.execute("call-status-action", { action: "status" });
      expect(sessionStatus.content[0]?.text).toContain("call session: idle");

      const unsupported = await tools[1].tool.execute("call-dial", { action: "dial" });
      expect(unsupported.content[0]?.text).toContain("unsupported action");
    } finally {
      await service.stop?.(serviceContext);
    }

    // `shutdown` must terminate the child process; further calls have no bridge.
    await expect(tools[0].tool.execute("call-after-stop", {})).rejects.toThrow("not running");
    // Only the daemon's own stderr diagnostics may reach the logger.
    expect(warnings.every((message) => message.includes("binary stderr:"))).toBe(true);
  });

  it("is discovered by the plugin loader as a binary plugin", async () => {
    const manifest = readManifest();
    const workspaceDir = makeTempDir();
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "dennou-kaden");
    const binDir = path.join(pluginDir, "bin");
    mkdirSafe(binDir);
    fs.copyFileSync(MANIFEST_PATH, path.join(pluginDir, "dennou.plugin.json"));
    fs.copyFileSync(PACKAGE_PATH, path.join(pluginDir, "package.json"));
    const binary = requireKadenBinary();
    for (const name of fs.readdirSync(BIN_DIR)) {
      fs.copyFileSync(path.join(BIN_DIR, name), path.join(binDir, name));
    }
    // Discovery probes the manifest path exactly, so guarantee it is present.
    const declaredBinary = path.join(binDir, path.basename(manifest.executable));
    if (!fs.existsSync(declaredBinary)) {
      fs.copyFileSync(binary, declaredBinary);
    }

    useNoBundledPlugins();
    const registry = loadOpenClawPlugins({
      workspaceDir,
      cache: false,
      onlyPluginIds: ["dennou-kaden"],
      logger: silentLogger,
      config: { plugins: { entries: { "dennou-kaden": { enabled: true } } } },
    });

    const record = registry.plugins.find((plugin) => plugin.id === "dennou-kaden");
    expect(record?.status).toBe("loaded");
    expect(registry.tools.flatMap((entry) => entry.names).toSorted()).toEqual([
      "kaden_call",
      "kaden_status",
    ]);
    expect(registry.services.map((entry) => entry.service.id)).toEqual(["dennou-kaden-binary"]);

    const registration = registry.tools.find((entry) => entry.names.includes("kaden_status"));
    expect(registration).toBeDefined();
    if (!registration) {
      return;
    }
    const tool = registration.factory(
      {} as Parameters<typeof registration.factory>[0],
    ) as KadenTool;
    expect(tool.name).toBe("kaden_status");

    const service = registry.services[0].service;
    await service.start(serviceContext);
    try {
      const status = await tool.execute("call-loader-status", {});
      expect(status.content[0]?.text).toContain("dennou-kaden: ready");
      expect(status.content[0]?.text).toContain("tools: kaden_call, kaden_status");
    } finally {
      await service.stop?.(serviceContext);
    }
  });
});

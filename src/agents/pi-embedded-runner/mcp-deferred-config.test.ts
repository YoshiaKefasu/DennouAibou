import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { ensureDiscoveryToolsActive, loadDeferredMcpConfig } from "./mcp-deferred-config.js";

function makeRoots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-deferred-"));
  const agentDir = path.join(root, "agent");
  const stateDir = path.join(root, "state");
  const cwd = path.join(root, "proj");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { root, agentDir, stateDir, cwd };
}

function load(params: {
  cfg?: OpenClawConfig;
  cwd: string;
  projectTrusted: boolean;
  agentDir: string;
  stateDir: string;
}) {
  return loadDeferredMcpConfig(params);
}

describe("loadDeferredMcpConfig", () => {
  it("defaults unspecified file exposure to deferred", () => {
    const { agentDir, stateDir, cwd } = makeRoots();
    fs.writeFileSync(
      path.join(stateDir, "mcp.json"),
      JSON.stringify({ mcpServers: { box: { command: "box-server" } } }),
    );
    const loaded = load({ cwd, projectTrusted: true, agentDir, stateDir });
    expect(loaded.errors).toEqual([]);
    expect(loaded.servers.map((s) => [s.name, s.config.exposure])).toEqual([["box", "deferred"]]);
  });

  it("defaults unspecified cfg exposure to deferred and keeps explicit exposure", () => {
    const { agentDir, stateDir, cwd } = makeRoots();
    const cfg = {
      mcp: {
        servers: {
          quiet: { command: "quiet-server" },
          loud: { command: "loud-server", exposure: "direct" },
        },
      },
    } as OpenClawConfig;
    const loaded = load({ cfg, cwd, projectTrusted: false, agentDir, stateDir });
    expect(loaded.errors).toEqual([]);
    const byName = new Map(loaded.servers.map((s) => [s.name, s.config.exposure]));
    expect(byName.get("quiet")).toBe("deferred");
    expect(byName.get("loud")).toBe("direct");
  });

  it("resolves the codemode-deferred alias and rejects bad exposure", () => {
    const { agentDir, stateDir, cwd } = makeRoots();
    const cfg = {
      mcp: {
        servers: {
          alias: { command: "a", exposure: "codemode-deferred" },
          bad: { command: "b", exposure: "everywhere" },
          nocommand: { exposure: "direct" },
        },
      },
    } as unknown as OpenClawConfig;
    const loaded = load({ cfg, cwd, projectTrusted: false, agentDir, stateDir });
    const byName = new Map(loaded.servers.map((s) => [s.name, s.config.exposure]));
    expect(byName.get("alias")).toBe("codemode");
    expect(byName.has("bad")).toBe(false);
    expect(byName.has("nocommand")).toBe(false);
    expect(loaded.errors.length).toBe(2);
  });

  it("loads the project file only when trusted and rejects project auth", () => {
    const { agentDir, stateDir, cwd } = makeRoots();
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "mcp.json"),
      JSON.stringify({
        mcpServers: { proj: { url: "https://example.test/mcp", auth: { provider: "x" } } },
      }),
    );
    const untrusted = load({ cwd, projectTrusted: false, agentDir, stateDir });
    expect(untrusted.servers).toEqual([]);
    const trusted = load({ cwd, projectTrusted: true, agentDir, stateDir });
    expect(trusted.servers).toEqual([]);
    expect(trusted.errors.join("\n")).toMatch(/auth is only allowed/);
  });

  it("lets cfg servers override file servers of the same name", () => {
    const { agentDir, stateDir, cwd } = makeRoots();
    fs.writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { dup: { command: "file-server" } } }),
    );
    const cfg = { mcp: { servers: { dup: { command: "cfg-server" } } } } as OpenClawConfig;
    const loaded = load({ cfg, cwd, projectTrusted: false, agentDir, stateDir });
    expect(loaded.errors).toEqual([]);
    expect(loaded.servers).toHaveLength(1);
    expect(loaded.servers[0]?.name).toBe("dup");
    expect(loaded.servers[0]?.config).toMatchObject({
      command: "cfg-server",
      exposure: "deferred",
    });
  });

  it("passes autoEnableCodemode through", () => {
    const { agentDir, stateDir, cwd } = makeRoots();
    fs.writeFileSync(
      path.join(stateDir, "mcp.json"),
      JSON.stringify({ autoEnableCodemode: false, mcpServers: {} }),
    );
    const loaded = load({ cwd, projectTrusted: false, agentDir, stateDir });
    expect(loaded.autoEnableCodemode).toBe(false);
  });
});

describe("ensureDiscoveryToolsActive", () => {
  function fakeSession(all: string[], active: string[]) {
    let current = [...active];
    return {
      getAllTools: () => all.map((name) => ({ name })),
      getActiveToolNames: () => [...current],
      setActiveToolsByName: (names: string[]) => {
        current = [...names];
      },
      current: () => current,
    };
  }

  it("activates tool_search when registered but inactive", () => {
    const session = fakeSession(["read", "tool_search"], ["read"]);
    ensureDiscoveryToolsActive(session);
    expect(session.current()).toEqual(["read", "tool_search"]);
  });

  it("activates codemode and tool_search together", () => {
    const session = fakeSession(["codemode", "tool_search"], []);
    ensureDiscoveryToolsActive(session);
    expect(session.current()).toEqual(["codemode", "tool_search"]);
  });

  it("leaves already-active tools alone and ignores missing ones", () => {
    const session = fakeSession(["tool_search"], ["tool_search"]);
    const before = session.getActiveToolNames();
    ensureDiscoveryToolsActive(session);
    expect(session.current()).toEqual(before);
    const noBox = fakeSession(["read"], ["read"]);
    ensureDiscoveryToolsActive(noBox);
    expect(noBox.current()).toEqual(["read"]);
  });
});

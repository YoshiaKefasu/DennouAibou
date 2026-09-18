import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quoteCmdScriptArg } from "./cmd-argv.js";
import "./test-helpers/schtasks-base-mocks.js";
import {
  baseSchtasksTestDeps,
  inspectPortUsage,
  killProcessTree,
  resetSchtasksBaseMocks,
  schtasksResponses,
  withWindowsEnv,
  writeGatewayScript,
} from "./test-helpers/schtasks-fixtures.js";
const timeState = { now: 0 };
const sleepMock = vi.fn(async (ms: number) => {
  timeState.now += ms;
});
const childUnref = vi.fn();
const spawn = vi.fn(() => ({ unref: childUnref }));
const spawnSync = vi.fn(() => ({
  pid: 0,
  output: [null, "", ""],
  stdout: "",
  stderr: "",
  status: 0,
  signal: null,
}));

const {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskRuntime,
  restartScheduledTask,
  resolveTaskScriptPath,
  setSchtasksTestDeps,
  stopScheduledTask,
} = await import("./schtasks.js");
type SchtasksDeps = NonNullable<Parameters<typeof setSchtasksTestDeps>[0]>;

function resolveStartupEntryPath(env: Record<string, string>) {
  return path.join(
    env.APPDATA,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "OpenClaw Gateway.cmd",
  );
}

async function writeStartupFallbackEntry(env: Record<string, string>) {
  const startupEntryPath = resolveStartupEntryPath(env);
  await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
  await fs.writeFile(startupEntryPath, "@echo off\r\n", "utf8");
  return startupEntryPath;
}

function expectStartupFallbackSpawn(env: Record<string, string>) {
  expect(spawn).toHaveBeenCalledWith(
    "cmd.exe",
    ["/d", "/s", "/c", quoteCmdScriptArg(resolveTaskScriptPath(env))],
    expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
  );
}

function expectGatewayTermination(pid: number) {
  if (process.platform === "win32") {
    expect(killProcessTree).not.toHaveBeenCalled();
    return;
  }
  expect(killProcessTree).toHaveBeenCalledWith(pid, { graceMs: 300 });
}

function addStartupFallbackMissingResponses(
  extraResponses: Array<{ code: number; stdout: string; stderr: string }> = [],
) {
  schtasksResponses.push(
    { code: 0, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "not found" },
    ...extraResponses,
  );
}
beforeEach(() => {
  resetSchtasksBaseMocks();
  spawn.mockClear();
  spawnSync.mockClear();
  childUnref.mockClear();
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
  sleepMock.mockReset();
  sleepMock.mockImplementation(async (ms: number) => {
    timeState.now += ms;
  });
  setSchtasksTestDeps({
    ...baseSchtasksTestDeps(),
    spawn: spawn as unknown as SchtasksDeps["spawn"],
    spawnSync: spawnSync as unknown as SchtasksDeps["spawnSync"],
    sleep: sleepMock as unknown as SchtasksDeps["sleep"],
    findVerifiedGatewayListenerPidsOnPortSync:
      (() => []) as unknown as SchtasksDeps["findVerifiedGatewayListenerPidsOnPortSync"],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Windows startup fallback", () => {
  it("falls back to a Startup-folder launcher when schtasks create is denied", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
        { code: 5, stdout: "", stderr: "ERROR: Access is denied." },
      );

      const stdout = new PassThrough();
      let printed = "";
      stdout.on("data", (chunk) => {
        printed += String(chunk);
      });

      const result = await installScheduledTask({
        env,
        stdout,
        programArguments: ["node", "gateway.js", "--port", "18789"],
        environment: { DENNOU_GATEWAY_PORT: "18789" },
      });

      const startupEntryPath = resolveStartupEntryPath(env);
      const startupScript = await fs.readFile(startupEntryPath, "utf8");
      expect(result.scriptPath).toBe(resolveTaskScriptPath(env));
      expect(startupScript).toContain('start "" /min cmd.exe /d /c');
      expect(startupScript).toContain("gateway.cmd");
      expect(spawn).toHaveBeenCalledWith(
        "cmd.exe",
        ["/d", "/s", "/c", quoteCmdScriptArg(resolveTaskScriptPath(env))],
        expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
      );
      expect(childUnref).toHaveBeenCalled();
      expect(printed).toContain("Installed Windows login item");
    });
  });

  it("falls back to a Startup-folder launcher when schtasks create hangs", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
        { code: 124, stdout: "", stderr: "schtasks timed out after 15000ms" },
      );

      const stdout = new PassThrough();
      await installScheduledTask({
        env,
        stdout,
        programArguments: ["node", "gateway.js", "--port", "18789"],
        environment: { DENNOU_GATEWAY_PORT: "18789" },
      });

      await fs.access(resolveStartupEntryPath(env));
      expectStartupFallbackSpawn(env);
    });
  });

  it("treats an installed Startup-folder launcher as loaded", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(env);

      await expect(isScheduledTaskInstalled({ env })).resolves.toBe(true);
    });
  });

  it("reports runtime from the gateway listener when using the Startup fallback", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(env);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 4242, command: "node.exe" }],
        hints: [],
      });

      await expect(readScheduledTaskRuntime(env)).resolves.toMatchObject({
        status: "running",
        pid: 4242,
      });
    });
  });

  it("restarts the Startup fallback by killing the current pid and relaunching the entry", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
      ]);
      await writeStartupFallbackEntry(env);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 5151, command: "node.exe" }],
        hints: [],
      });

      const stdout = new PassThrough();
      await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
        outcome: "completed",
      });
      expectGatewayTermination(5151);
      expectStartupFallbackSpawn(env);
    });
  });

  it("kills the Startup fallback runtime even when the CLI env omits the gateway port", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      schtasksResponses.push({ code: 0, stdout: "", stderr: "" });
      await writeGatewayScript(env);
      await writeStartupFallbackEntry(env);
      inspectPortUsage
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 5151, command: "node.exe" }],
          hints: [],
        })
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 5151, command: "node.exe" }],
          hints: [],
        })
        .mockResolvedValueOnce({
          port: 18789,
          status: "free",
          listeners: [],
          hints: [],
        });

      const stdout = new PassThrough();
      const envWithoutPort = { ...env };
      delete envWithoutPort.DENNOU_GATEWAY_PORT;
      await stopScheduledTask({ env: envWithoutPort, stdout });

      expectGatewayTermination(5151);
    });
  });
});

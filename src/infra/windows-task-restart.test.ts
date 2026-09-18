import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";
import { relaunchGatewayScheduledTask } from "./windows-task-restart.js";

const envSnapshot = captureFullEnv();
const createdScriptPaths = new Set<string>();
const createdTmpDirs = new Set<string>();

let spawnMock: ReturnType<typeof vi.fn>;
let tmpDirRoot: string;
let taskScriptPathOverride: string | null;

function defaultTaskScriptPath(env: Record<string, string | undefined>): string {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, ".openclaw", "gateway.cmd");
}

function relaunch(
  env: Record<string, string | undefined>,
  spawnImpl: ReturnType<typeof vi.fn> = spawnMock,
) {
  return relaunchGatewayScheduledTask(env, {
    spawn: spawnImpl as unknown as typeof import("node:child_process").spawn,
    resolvePreferredOpenClawTmpDir: () => tmpDirRoot,
    resolveTaskScriptPath: (taskEnv) =>
      taskScriptPathOverride ?? defaultTaskScriptPath(taskEnv ?? {}),
  });
}

function decodeCmdPathArg(value: string): string {
  const trimmed = value.trim();
  const withoutQuotes =
    trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return withoutQuotes.replace(/\^!/g, "!").replace(/%%/g, "%");
}

function captureSpawnedScript(): ReturnType<typeof vi.fn> {
  const spawnImpl = vi.fn((_file: string, args: string[]) => {
    createdScriptPaths.add(decodeCmdPathArg(args[3]));
    return { unref: vi.fn() };
  });
  return spawnImpl;
}

afterEach(() => {
  envSnapshot.restore();
  for (const scriptPath of createdScriptPaths) {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Best-effort cleanup for temp helper scripts created in tests.
    }
  }
  createdScriptPaths.clear();
  for (const tmpDir of createdTmpDirs) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for test temp roots.
    }
  }
  createdTmpDirs.clear();
});

describe("relaunchGatewayScheduledTask", () => {
  beforeEach(() => {
    spawnMock = vi.fn();
    tmpDirRoot = os.tmpdir();
    taskScriptPathOverride = null;
  });

  it("writes a detached schtasks relaunch helper", () => {
    const unref = vi.fn();
    let seenCommandArg = "";
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      seenCommandArg = args[3];
      createdScriptPaths.add(decodeCmdPathArg(args[3]));
      return { unref };
    });

    const result = relaunch({ DENNOU_PROFILE: "work" });

    expect(result).toMatchObject({
      ok: true,
      method: "schtasks",
    });
    // NOTE: Bun's `toMatchObject` corrupts an array when the expectation uses
    // `expect.arrayContaining`, so `tried` is asserted with explicit checks.
    const tried = result.tried ?? [];
    expect(tried).toHaveLength(2);
    expect(tried[0]).toBe('schtasks /Run /TN "OpenClaw Gateway (work)"');
    expect(tried).toContain(`cmd.exe /d /s /c ${seenCommandArg}`);
    expect(spawnMock).toHaveBeenCalledWith(
      "cmd.exe",
      ["/d", "/s", "/c", expect.any(String)],
      expect.objectContaining({
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }),
    );
    expect(unref).toHaveBeenCalledOnce();

    const scriptPath = [...createdScriptPaths][0];
    expect(scriptPath).toBeTruthy();
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toContain("timeout /t 1 /nobreak >nul");
    expect(script).toContain('schtasks /Run /TN "OpenClaw Gateway (work)" >nul 2>&1');
    expect(script).toContain('del "%~f0" >nul 2>&1');
  });

  it("prefers DENNOU_WINDOWS_TASK_NAME overrides", () => {
    spawnMock = captureSpawnedScript();

    relaunch({
      DENNOU_PROFILE: "work",
      DENNOU_WINDOWS_TASK_NAME: "OpenClaw Gateway (custom)",
    });

    const scriptPath = [...createdScriptPaths][0];
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toContain('schtasks /Run /TN "OpenClaw Gateway (custom)" >nul 2>&1');
  });

  it("returns failed when the helper cannot be spawned", () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    const result = relaunch({ DENNOU_PROFILE: "work" });

    expect(result.ok).toBe(false);
    expect(result.method).toBe("schtasks");
    expect(result.detail).toContain("spawn failed");
  });

  it("quotes the cmd /c script path when temp paths contain metacharacters", () => {
    const unref = vi.fn();
    const metacharTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw&(restart)-"));
    createdTmpDirs.add(metacharTmpDir);
    tmpDirRoot = metacharTmpDir;
    spawnMock.mockReturnValue({ unref });

    relaunch({ DENNOU_PROFILE: "work" });

    expect(spawnMock).toHaveBeenCalledWith(
      "cmd.exe",
      ["/d", "/s", "/c", expect.stringMatching(/^".*&.*"$/)],
      expect.any(Object),
    );
  });

  it("includes startup fallback", () => {
    const taskScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-"));
    createdTmpDirs.add(taskScriptDir);
    const taskScriptPath = path.join(taskScriptDir, "gateway.cmd");
    fs.writeFileSync(taskScriptPath, "@echo off\r\nrem placeholder\r\n", "utf8");
    taskScriptPathOverride = taskScriptPath;
    spawnMock = captureSpawnedScript();

    const result = relaunch({ DENNOU_PROFILE: "work" });

    expect(result.ok).toBe(true);
    const scriptPath = [...createdScriptPaths][0];
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toContain(`schtasks /Query /TN`);
    expect(script).toContain(":fallback");
    expect(script).toContain(`start "" /min cmd.exe /d /c`);
    expect(script).toContain(taskScriptPath);
  });
});

import { describe, expect, it, vi } from "vitest";
import { restartGatewayProcessWithFreshPid, type ProcessRespawnDeps } from "./process-respawn.js";
import type { RestartAttempt } from "./restart.js";

const EXEC_PATH = "/usr/local/bin/node";

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; detached: true; stdio: "inherit" },
) => { pid?: number | null; unref: () => void };

type RespawnOverrides = Omit<ProcessRespawnDeps, "spawn" | "triggerRestart">;

function createFixture(overrides: RespawnOverrides = {}) {
  const spawn = vi.fn<SpawnFn>();
  const triggerRestart = vi.fn<() => RestartAttempt>();
  const deps: RespawnOverrides = {
    env: {},
    platform: "linux",
    argv: [EXEC_PATH, "/repo/dist/index.js", "gateway", "run"],
    execArgv: [],
    execPath: EXEC_PATH,
    ...overrides,
  };
  const run = () => restartGatewayProcessWithFreshPid({ ...deps, spawn, triggerRestart });
  return { deps, spawn, triggerRestart, run };
}

function createEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

function expectLaunchdSupervisedWithoutKickstart(params?: { launchJobLabel?: string }) {
  const env = createEnv({ DENNOU_LAUNCHD_LABEL: "ai.openclaw.gateway" });
  if (params?.launchJobLabel) {
    env.LAUNCH_JOB_LABEL = params.launchJobLabel;
  }
  const { spawn, triggerRestart, run } = createFixture({ env, platform: "darwin" });
  const result = run();
  expect(result).toEqual({ mode: "supervised" });
  expect(triggerRestart).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
}

describe("restartGatewayProcessWithFreshPid", () => {
  it("returns disabled when DENNOU_NO_RESPAWN is set", () => {
    const { spawn, run } = createFixture({ env: createEnv({ DENNOU_NO_RESPAWN: "1" }) });
    const result = run();
    expect(result.mode).toBe("disabled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps DENNOU_NO_RESPAWN ahead of inherited supervisor hints", () => {
    const { spawn, triggerRestart, run } = createFixture({
      env: createEnv({
        DENNOU_NO_RESPAWN: "1",
        LAUNCH_JOB_LABEL: "ai.openclaw.gateway",
      }),
      platform: "darwin",
    });

    const result = run();

    expect(result).toEqual({ mode: "disabled" });
    expect(triggerRestart).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns supervised when launchd hints are present on macOS (no kickstart)", () => {
    expectLaunchdSupervisedWithoutKickstart({ launchJobLabel: "ai.openclaw.gateway" });
  });

  it("returns supervised on macOS when launchd label is set (no kickstart)", () => {
    expectLaunchdSupervisedWithoutKickstart({ launchJobLabel: "ai.openclaw.gateway" });
  });

  it("launchd supervisor never returns failed regardless of triggerOpenClawRestart outcome", () => {
    const { triggerRestart, run } = createFixture({
      env: createEnv({ DENNOU_LAUNCHD_LABEL: "ai.openclaw.gateway" }),
      platform: "darwin",
    });
    // Even if triggerOpenClawRestart *would* fail, launchd path must not call it.
    triggerRestart.mockReturnValue({
      ok: false,
      method: "launchctl",
      detail: "Bootstrap failed: 5: Input/output error",
    });
    const result = run();
    expect(result.mode).toBe("supervised");
    expect(result.mode).not.toBe("failed");
    expect(triggerRestart).not.toHaveBeenCalled();
  });

  it("does not schedule kickstart on non-darwin platforms", () => {
    const { spawn, triggerRestart, run } = createFixture({
      env: createEnv({
        INVOCATION_ID: "abc123",
        DENNOU_LAUNCHD_LABEL: "ai.openclaw.gateway",
      }),
      platform: "linux",
    });

    const result = run();

    expect(result.mode).toBe("supervised");
    expect(triggerRestart).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns supervised when XPC_SERVICE_NAME is set by launchd", () => {
    const { spawn, triggerRestart, run } = createFixture({
      env: createEnv({ XPC_SERVICE_NAME: "ai.openclaw.gateway" }),
      platform: "darwin",
    });
    const result = run();
    expect(result.mode).toBe("supervised");
    expect(triggerRestart).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns detached child with current exec argv", () => {
    const unref = vi.fn();
    const { spawn, run } = createFixture({
      env: createEnv(),
      platform: "linux",
      execArgv: ["--import", "tsx"],
      argv: [EXEC_PATH, "/repo/dist/index.js", "gateway", "run"],
    });
    spawn.mockReturnValue({ pid: 4242, unref });

    const result = run();

    expect(result).toEqual({ mode: "spawned", pid: 4242 });
    expect(spawn).toHaveBeenCalledWith(
      EXEC_PATH,
      ["--import", "tsx", "/repo/dist/index.js", "gateway", "run"],
      expect.objectContaining({
        detached: true,
        stdio: "inherit",
      }),
    );
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("returns supervised when DENNOU_LAUNCHD_LABEL is set (stock launchd plist)", () => {
    expectLaunchdSupervisedWithoutKickstart();
  });

  it("returns supervised when DENNOU_SYSTEMD_UNIT is set", () => {
    const { spawn, run } = createFixture({
      env: createEnv({ DENNOU_SYSTEMD_UNIT: "openclaw-gateway.service" }),
      platform: "linux",
    });
    const result = run();
    expect(result.mode).toBe("supervised");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns supervised when OpenClaw gateway task markers are set on Windows", () => {
    const { spawn, triggerRestart, run } = createFixture({
      env: createEnv({ DENNOU_SERVICE_MARKER: "openclaw", DENNOU_SERVICE_KIND: "gateway" }),
      platform: "win32",
    });
    triggerRestart.mockReturnValue({ ok: true, method: "schtasks" });
    const result = run();
    expect(result.mode).toBe("supervised");
    expect(triggerRestart).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps generic service markers out of non-Windows supervisor detection", () => {
    const { spawn, triggerRestart, run } = createFixture({
      env: createEnv({ DENNOU_SERVICE_MARKER: "openclaw", DENNOU_SERVICE_KIND: "gateway" }),
      platform: "linux",
    });
    spawn.mockReturnValue({ pid: 4242, unref: vi.fn() });

    const result = run();

    expect(result).toEqual({ mode: "spawned", pid: 4242 });
    expect(triggerRestart).not.toHaveBeenCalled();
  });

  it("returns disabled on Windows without Scheduled Task markers", () => {
    const { spawn, run } = createFixture({ env: createEnv(), platform: "win32" });

    const result = run();

    expect(result.mode).toBe("disabled");
    expect(result.detail).toContain("Scheduled Task");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("ignores node task script hints for gateway restart detection on Windows", () => {
    const { spawn, triggerRestart, run } = createFixture({
      env: createEnv({
        DENNOU_TASK_SCRIPT: "C:\\openclaw\\node.cmd",
        DENNOU_TASK_SCRIPT_NAME: "node.cmd",
        DENNOU_SERVICE_MARKER: "openclaw",
        DENNOU_SERVICE_KIND: "node",
      }),
      platform: "win32",
    });

    const result = run();

    expect(result.mode).toBe("disabled");
    expect(triggerRestart).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns failed when spawn throws", () => {
    const { spawn, run } = createFixture({ env: createEnv(), platform: "linux" });

    spawn.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const result = run();
    expect(result.mode).toBe("failed");
    expect(result.detail).toContain("spawn failed");
  });
});

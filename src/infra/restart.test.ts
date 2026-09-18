import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  cleanStaleGatewayProcessesSync,
  findGatewayPidsOnPortSync,
  type RestartStalePidsDeps,
} from "./restart-stale-pids.js";

let currentTimeMs = 0;
let spawnSyncMock: ReturnType<typeof vi.fn>;
let resolveGatewayPortMock: ReturnType<typeof vi.fn>;

/**
 * The lsof-backed code paths are POSIX-only in production, but they only ever
 * touch injected seams here, so the platform is pinned to `linux` and the tests
 * run on every host OS instead of being skipped on Windows.
 */
function createDeps(overrides: Partial<RestartStalePidsDeps> = {}): RestartStalePidsDeps {
  return {
    platform: "linux",
    spawnSync: spawnSyncMock as unknown as RestartStalePidsDeps["spawnSync"],
    resolveLsofCommandSync: () => "/usr/sbin/lsof",
    resolveGatewayPort:
      resolveGatewayPortMock as unknown as RestartStalePidsDeps["resolveGatewayPort"],
    ...overrides,
  };
}

beforeEach(() => {
  spawnSyncMock = vi.fn();
  resolveGatewayPortMock = vi.fn(() => 18789);

  currentTimeMs = 0;
  __testing.setSleepSyncOverride((ms) => {
    currentTimeMs += ms;
  });
  __testing.setDateNowOverride(() => currentTimeMs);
});

afterEach(() => {
  __testing.setSleepSyncOverride(null);
  __testing.setDateNowOverride(null);
  vi.restoreAllMocks();
});

describe("findGatewayPidsOnPortSync", () => {
  it("parses lsof output and filters non-openclaw/current processes", () => {
    const gatewayPidA = process.pid + 1000;
    const gatewayPidB = process.pid + 2000;
    const foreignPid = process.pid + 3000;
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: [
        `p${process.pid}`,
        "copenclaw",
        `p${gatewayPidA}`,
        "copenclaw-gateway",
        `p${foreignPid}`,
        "cnode",
        `p${gatewayPidB}`,
        "cOpenClaw",
      ].join("\n"),
    });

    const pids = findGatewayPidsOnPortSync(18789, undefined, createDeps());

    expect(pids).toEqual([gatewayPidA, gatewayPidB]);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/usr/sbin/lsof",
      ["-nP", "-iTCP:18789", "-sTCP:LISTEN", "-Fpc"],
      expect.objectContaining({ encoding: "utf8", timeout: 2000 }),
    );
  });

  it("returns empty when lsof fails", () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 1,
      stdout: "",
      stderr: "lsof failed",
    });

    expect(findGatewayPidsOnPortSync(18789, undefined, createDeps())).toEqual([]);
  });
});

describe("cleanStaleGatewayProcessesSync", () => {
  it("kills stale gateway pids discovered on the gateway port", () => {
    const stalePidA = process.pid + 1000;
    const stalePidB = process.pid + 2000;
    spawnSyncMock
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: [`p${stalePidA}`, "copenclaw", `p${stalePidB}`, "copenclaw-gateway"].join("\n"),
      })
      .mockReturnValue({
        error: undefined,
        status: 1,
        stdout: "",
      });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync(undefined, createDeps());

    expect(killed).toEqual([stalePidA, stalePidB]);
    expect(resolveGatewayPortMock).toHaveBeenCalledWith(undefined, process.env);
    expect(killSpy).toHaveBeenCalledWith(stalePidA, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(stalePidB, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(stalePidA, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(stalePidB, "SIGKILL");
  });

  it("uses explicit port override when provided", () => {
    const stalePid = process.pid + 1000;
    spawnSyncMock
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: [`p${stalePid}`, "copenclaw"].join("\n"),
      })
      .mockReturnValue({
        error: undefined,
        status: 1,
        stdout: "",
      });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync(19999, createDeps());

    expect(killed).toEqual([stalePid]);
    expect(resolveGatewayPortMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/usr/sbin/lsof",
      ["-nP", "-iTCP:19999", "-sTCP:LISTEN", "-Fpc"],
      expect.objectContaining({ encoding: "utf8", timeout: 2000 }),
    );
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGKILL");
  });

  it("returns empty when no stale listeners are found", () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "",
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync(undefined, createDeps());

    expect(killed).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });
});

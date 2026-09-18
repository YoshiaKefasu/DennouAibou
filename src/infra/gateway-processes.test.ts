import { describe, expect, it, vi } from "vitest";
import {
  findVerifiedGatewayListenerPidsOnPortSync,
  formatGatewayPidList,
  readGatewayProcessArgsSync,
  signalVerifiedGatewayPidSync,
  type GatewayProcessesDeps,
} from "./gateway-processes.js";

const spawnSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const parseCmdScriptCommandLineMock = vi.fn();
const parseProcCmdlineMock = vi.fn();
const isGatewayArgvMock = vi.fn();
const findGatewayPidsOnPortSyncMock = vi.fn();
const killMock = vi.fn();

type WindowsPortDeps = NonNullable<GatewayProcessesDeps["windowsPortPids"]>;

/**
 * All OS/process boundaries are injected so the suite runs on every host OS
 * without patching `process.platform`, `node:fs`, or `node:child_process`.
 */
function createDeps(overrides: Partial<GatewayProcessesDeps> = {}): GatewayProcessesDeps {
  const windowsPortPids: WindowsPortDeps = {
    spawnSync: spawnSyncMock as unknown as WindowsPortDeps["spawnSync"],
    parseCmdScriptCommandLine:
      parseCmdScriptCommandLineMock as unknown as WindowsPortDeps["parseCmdScriptCommandLine"],
  };
  return {
    readFileSync: readFileSyncMock as unknown as GatewayProcessesDeps["readFileSync"],
    spawnSync: spawnSyncMock as unknown as GatewayProcessesDeps["spawnSync"],
    kill: killMock as unknown as GatewayProcessesDeps["kill"],
    parseProcCmdline: parseProcCmdlineMock as unknown as GatewayProcessesDeps["parseProcCmdline"],
    isGatewayArgv: isGatewayArgvMock as unknown as GatewayProcessesDeps["isGatewayArgv"],
    findUnixGatewayPidsOnPortSync:
      findGatewayPidsOnPortSyncMock as unknown as GatewayProcessesDeps["findUnixGatewayPidsOnPortSync"],
    windowsPortPids,
    ...overrides,
  };
}

function resetMocks(): void {
  spawnSyncMock.mockReset();
  readFileSyncMock.mockReset();
  parseCmdScriptCommandLineMock.mockReset();
  parseProcCmdlineMock.mockReset();
  isGatewayArgvMock.mockReset();
  findGatewayPidsOnPortSyncMock.mockReset();
  killMock.mockReset();
}

describe("gateway-processes", () => {
  it("reads linux process args from /proc and parses cmdlines", () => {
    resetMocks();
    readFileSyncMock.mockReturnValue("node\0dist/index.js\0gateway\0run\0");
    parseProcCmdlineMock.mockReturnValue(["node", "dist/index.js", "gateway", "run"]);

    expect(readGatewayProcessArgsSync(4242, createDeps({ platform: "linux" }))).toEqual([
      "node",
      "dist/index.js",
      "gateway",
      "run",
    ]);
    expect(readFileSyncMock).toHaveBeenCalledWith("/proc/4242/cmdline", "utf8");
    expect(parseProcCmdlineMock).toHaveBeenCalledWith("node\0dist/index.js\0gateway\0run\0");
  });

  it("reads darwin process args from ps output and returns null on ps failure", () => {
    resetMocks();
    spawnSyncMock
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "node /repo/dist/index.js gateway run\n",
      })
      .mockReturnValueOnce({
        error: null,
        status: 1,
        stdout: "",
      });

    const deps = createDeps({ platform: "darwin" });
    expect(readGatewayProcessArgsSync(123, deps)).toEqual([
      "node",
      "/repo/dist/index.js",
      "gateway",
      "run",
    ]);
    expect(readGatewayProcessArgsSync(124, deps)).toBeNull();
  });

  it("falls back from powershell to wmic for windows process args", () => {
    resetMocks();
    spawnSyncMock
      .mockReturnValueOnce({
        error: new Error("powershell missing"),
        status: null,
        stdout: "",
      })
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "CommandLine=node.exe gateway run\r\n",
      });
    parseCmdScriptCommandLineMock.mockReturnValue(["node.exe", "gateway", "run"]);

    expect(readGatewayProcessArgsSync(77, createDeps({ platform: "win32" }))).toEqual([
      "node.exe",
      "gateway",
      "run",
    ]);
    expect(parseCmdScriptCommandLineMock).toHaveBeenCalledWith("node.exe gateway run");
  });

  it("signals only verified gateway processes", () => {
    resetMocks();
    readFileSyncMock.mockReturnValue("node\0gateway\0");
    parseProcCmdlineMock.mockReturnValue(["node", "gateway"]);
    isGatewayArgvMock.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const deps = createDeps({ platform: "linux" });
    signalVerifiedGatewayPidSync(500, "SIGTERM", deps);
    expect(killMock).toHaveBeenCalledWith(500, "SIGTERM");

    expect(() => signalVerifiedGatewayPidSync(501, "SIGUSR1", deps)).toThrow(
      /refusing to signal non-gateway process pid 501/,
    );
  });

  it("dedupes and filters verified gateway listener pids on unix and windows", () => {
    resetMocks();
    findGatewayPidsOnPortSyncMock.mockReturnValue([process.pid, 200, 200, 300, -1]);
    readFileSyncMock.mockReturnValueOnce("openclaw-gateway\0gateway\0");
    readFileSyncMock.mockReturnValueOnce("python\0-m\0http.server\0");
    parseProcCmdlineMock
      .mockReturnValueOnce(["openclaw-gateway", "gateway"])
      .mockReturnValueOnce(["python", "-m", "http.server"]);
    isGatewayArgvMock.mockReturnValueOnce(true).mockReturnValueOnce(false);

    expect(
      findVerifiedGatewayListenerPidsOnPortSync(18789, createDeps({ platform: "linux" })),
    ).toEqual([200]);

    resetMocks();
    spawnSyncMock
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "200\r\n200\r\n0\r\n",
      })
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "node.exe gateway run",
      });
    parseCmdScriptCommandLineMock.mockReturnValue(["node.exe", "gateway", "run"]);
    isGatewayArgvMock.mockReturnValue(true);

    expect(
      findVerifiedGatewayListenerPidsOnPortSync(18789, createDeps({ platform: "win32" })),
    ).toEqual([200]);
  });

  it("formats pid lists as comma-separated output", () => {
    expect(formatGatewayPidList([1, 2, 3])).toBe("1, 2, 3");
  });
});

import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import { isGatewayArgv, parseProcCmdline } from "./gateway-process-argv.js";
import { findGatewayPidsOnPortSync as findUnixGatewayPidsOnPortSync } from "./restart-stale-pids.js";
import {
  readWindowsListeningPidsOnPortSync,
  readWindowsProcessArgsSync,
  type WindowsPortPidsDeps,
} from "./windows-port-pids.js";

/**
 * Injectable seams for the OS/process boundaries this module touches. Tests
 * supply fixtures instead of mocking `node:child_process`, `node:fs`,
 * `./gateway-process-argv.js`, and `./restart-stale-pids.js` at module level.
 */
export type GatewayProcessesDeps = {
  platform?: NodeJS.Platform;
  selfPid?: number;
  readFileSync?: typeof fsSync.readFileSync;
  spawnSync?: typeof spawnSync;
  kill?: typeof process.kill;
  parseProcCmdline?: typeof parseProcCmdline;
  isGatewayArgv?: typeof isGatewayArgv;
  findUnixGatewayPidsOnPortSync?: typeof findUnixGatewayPidsOnPortSync;
  windowsPortPids?: WindowsPortPidsDeps;
};

type ResolvedGatewayProcessesDeps = {
  platform: NodeJS.Platform;
  selfPid: number;
  readFileSync: typeof fsSync.readFileSync;
  spawnSync: typeof spawnSync;
  kill: typeof process.kill;
  parseProcCmdline: typeof parseProcCmdline;
  isGatewayArgv: typeof isGatewayArgv;
  findUnixGatewayPidsOnPortSync: typeof findUnixGatewayPidsOnPortSync;
  windowsPortPids: WindowsPortPidsDeps;
};

function resolveDeps(deps: GatewayProcessesDeps = {}): ResolvedGatewayProcessesDeps {
  return {
    platform: deps.platform ?? process.platform,
    selfPid: deps.selfPid ?? process.pid,
    readFileSync: deps.readFileSync ?? fsSync.readFileSync,
    spawnSync: deps.spawnSync ?? spawnSync,
    kill: deps.kill ?? process.kill,
    parseProcCmdline: deps.parseProcCmdline ?? parseProcCmdline,
    isGatewayArgv: deps.isGatewayArgv ?? isGatewayArgv,
    findUnixGatewayPidsOnPortSync:
      deps.findUnixGatewayPidsOnPortSync ?? findUnixGatewayPidsOnPortSync,
    windowsPortPids: deps.windowsPortPids ?? {},
  };
}

export function readGatewayProcessArgsSync(
  pid: number,
  deps: GatewayProcessesDeps = {},
): string[] | null {
  const resolved = resolveDeps(deps);
  if (resolved.platform === "linux") {
    try {
      return resolved.parseProcCmdline(resolved.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    } catch {
      return null;
    }
  }
  if (resolved.platform === "darwin") {
    const ps = resolved.spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
    });
    if (ps.error || ps.status !== 0) {
      return null;
    }
    const command = ps.stdout.trim();
    return command ? command.split(/\s+/) : null;
  }
  if (resolved.platform === "win32") {
    return readWindowsProcessArgsSync(pid, undefined, resolved.windowsPortPids);
  }
  return null;
}

export function signalVerifiedGatewayPidSync(
  pid: number,
  signal: "SIGTERM" | "SIGUSR1",
  deps: GatewayProcessesDeps = {},
): void {
  const resolved = resolveDeps(deps);
  const args = readGatewayProcessArgsSync(pid, deps);
  if (!args || !resolved.isGatewayArgv(args, { allowGatewayBinary: true })) {
    throw new Error(`refusing to signal non-gateway process pid ${pid}`);
  }
  resolved.kill(pid, signal);
}

export function findVerifiedGatewayListenerPidsOnPortSync(
  port: number,
  deps: GatewayProcessesDeps = {},
): number[] {
  const resolved = resolveDeps(deps);
  const rawPids =
    resolved.platform === "win32"
      ? readWindowsListeningPidsOnPortSync(port, undefined, resolved.windowsPortPids)
      : resolved.findUnixGatewayPidsOnPortSync(port);

  return Array.from(new Set(rawPids))
    .filter((pid): pid is number => Number.isFinite(pid) && pid > 0 && pid !== resolved.selfPid)
    .filter((pid) => {
      const args = readGatewayProcessArgsSync(pid, deps);
      return args != null && resolved.isGatewayArgv(args, { allowGatewayBinary: true });
    });
}

export function formatGatewayPidList(pids: number[]): string {
  return pids.join(", ");
}

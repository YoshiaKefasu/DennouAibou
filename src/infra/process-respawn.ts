import { spawn as defaultSpawn } from "node:child_process";
import { triggerOpenClawRestart as defaultTriggerOpenClawRestart } from "./restart.js";
import { detectRespawnSupervisor } from "./supervisor-markers.js";

type DetachedSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; detached: true; stdio: "inherit" },
) => { pid?: number | null; unref: () => void };

export type ProcessRespawnDeps = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  argv?: readonly string[];
  execArgv?: readonly string[];
  execPath?: string;
  spawn?: DetachedSpawn;
  triggerRestart?: typeof defaultTriggerOpenClawRestart;
};

type RespawnMode = "spawned" | "supervised" | "disabled" | "failed";

export type GatewayRespawnResult = {
  mode: RespawnMode;
  pid?: number;
  detail?: string;
};

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Attempt to restart this process with a fresh PID.
 * - supervised environments (launchd/systemd/schtasks): caller should exit and let supervisor restart
 * - DENNOU_NO_RESPAWN=1: caller should keep in-process restart behavior (tests/dev)
 * - otherwise: spawn detached child with current argv/execArgv, then caller exits
 */
export function restartGatewayProcessWithFreshPid(
  deps: ProcessRespawnDeps = {},
): GatewayRespawnResult {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const spawnProcess = deps.spawn ?? defaultSpawn;
  const triggerRestart = deps.triggerRestart ?? defaultTriggerOpenClawRestart;

  if (isTruthy(env.DENNOU_NO_RESPAWN)) {
    return { mode: "disabled" };
  }
  const supervisor = detectRespawnSupervisor(env, platform);
  if (supervisor) {
    // On macOS launchd, exit cleanly and let KeepAlive relaunch the service.
    // Avoid detached kickstart/start handoffs here so restart timing stays tied
    // to launchd's native supervision rather than a second helper process.
    if (supervisor === "schtasks") {
      const restart = triggerRestart();
      if (!restart.ok) {
        return {
          mode: "failed",
          detail: restart.detail ?? `${restart.method} restart failed`,
        };
      }
    }
    return { mode: "supervised" };
  }
  if (platform === "win32") {
    // Detached respawn is unsafe on Windows without an identified Scheduled Task:
    // the child becomes orphaned if the original process exits.
    return {
      mode: "disabled",
      detail: "win32: detached respawn unsupported without Scheduled Task markers",
    };
  }

  try {
    const argv = deps.argv ?? process.argv;
    const execArgv = deps.execArgv ?? process.execArgv;
    const execPath = deps.execPath ?? process.execPath;
    const args = [...execArgv, ...argv.slice(1)];
    const child = spawnProcess(execPath, args, {
      env,
      detached: true,
      stdio: "inherit",
    });
    child.unref();
    return { mode: "spawned", pid: child.pid ?? undefined };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { mode: "failed", detail };
  }
}

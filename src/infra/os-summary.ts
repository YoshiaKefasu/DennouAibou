import { spawnSync as defaultSpawnSync } from "node:child_process";
import os from "node:os";

export type OsSummary = {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  label: string;
};

export type OsSummaryDeps = {
  platform?: () => NodeJS.Platform;
  release?: () => string;
  arch?: () => string;
  spawnSync?: typeof defaultSpawnSync;
};

function safeTrim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function macosVersion(spawnSync: typeof defaultSpawnSync, release: string): string {
  const res = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf-8" });
  const out = safeTrim(res.stdout);
  return out || release;
}

export function resolveOsSummary(deps: OsSummaryDeps = {}): OsSummary {
  const platform = deps.platform ?? os.platform;
  const release = deps.release ?? os.release;
  const arch = deps.arch ?? os.arch;
  const spawnSync = deps.spawnSync ?? defaultSpawnSync;
  const platformValue = platform();
  const releaseValue = release();
  const archValue = arch();
  const label = (() => {
    if (platformValue === "darwin") {
      return `macos ${macosVersion(spawnSync, releaseValue)} (${archValue})`;
    }
    if (platformValue === "win32") {
      return `windows ${releaseValue} (${archValue})`;
    }
    return `${platformValue} ${releaseValue} (${archValue})`;
  })();
  return { platform: platformValue, arch: archValue, release: releaseValue, label };
}

import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalTsgoPolicy,
} from "./lib/local-heavy-check-runtime.mjs";

const { args: finalArgs, env } = applyLocalTsgoPolicy(process.argv.slice(2), process.env);

const tsgoPath = path.resolve("node_modules", ".bin", "tsgo");
const releaseLock = acquireLocalHeavyCheckLockSync({
  cwd: process.cwd(),
  env,
  toolName: "tsgo",
});

try {
  // Note: On Windows, `shell: true` makes Node invoke `cmd.exe /d /s /c "<command>"`.
  // Node does not escape spaces inside `command`, so paths containing spaces
  // (e.g. `D:\GitHub\OpenClaw Related Repos\...`) must be quoted manually to
  // prevent cmd.exe from splitting the path on the first space.
  const command = process.platform === "win32" ? `"${tsgoPath}"` : tsgoPath;
  const result = spawnSync(command, finalArgs, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
} finally {
  releaseLock();
}

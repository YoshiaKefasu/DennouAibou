// Builds the kaden daemon into `bin/kaden` (`bin/kaden.exe` on Windows).
//
// `bin/` is gitignored, so run this once per checkout before the host can load
// the plugin: `node build.mjs` (or `pnpm --dir extensions/dennou-kaden build`).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const outputName = process.platform === "win32" ? "kaden.exe" : "kaden";
const outputPath = path.join(rootDir, "bin", outputName);
fs.mkdirSync(path.join(rootDir, "bin"), { recursive: true });

const result = spawnSync("go", ["build", "-o", outputPath, "."], {
  cwd: rootDir,
  stdio: "inherit",
});

if (result.error) {
  console.error(`[dennou-kaden] go build failed to start: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// Plugin discovery probes the manifest `executable` path exactly (`./bin/kaden`)
// while child_process.spawn needs the `.exe` suffix on Windows, so publish the
// same binary under both names. The spawn path always prefers `.exe`.
if (process.platform === "win32") {
  fs.copyFileSync(outputPath, path.join(rootDir, "bin", "kaden"));
}

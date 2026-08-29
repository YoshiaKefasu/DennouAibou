/**
 * Regression guard for the `process is not defined` browser crash fixed in
 * 0cbd5ad29 ("[SOUL] Fix WebUI bundle importing Node-only home-dir module").
 *
 * Why this test exists
 * --------------------
 * The `dist/control-ui/assets/index-*.js` bundle is loaded by the gateway and
 * served to the browser. Several shared command/thinking modules transitively
 * reach `src/utils.ts`, which used to evaluate `process.env` / `fs.existsSync`
 * at module load time. That blew up the browser tab with
 * `ReferenceError: process is not defined` before any UI code could run.
 *
 * The fix moved the eager resolution into a guarded factory and wrapped the
 * other Node-only branches in try/catch. The 12 `process.*` references that
 * remain in the bundle (process.pid / cwd / argv / platform / ...) are now
 * inside function bodies, so they only resolve when actually called from the
 * Node side. UI code paths never call them.
 *
 * What this test asserts
 * ----------------------
 * 1. A child Node process is forked with `process` replaced by a Proxy that
 *    throws `ReferenceError: process is not defined` on every property access,
 *    simulating a browser tab (where the Node global simply does not exist).
 * 2. The forked process dynamically imports the built bundle.
 * 3. The child reports a structured result via a result file (we use a file
 *    rather than stdout because `process.stdout` itself goes through the
 *    trap once the proxy is installed). The parent only fails when the
 *    child observed `process is not defined` during module load — anything
 *    else (jsdom missing APIs, lit warnings, etc.) is tolerated.
 *
 * Why a child process?
 * --------------------
 * Replacing `process` inside the Vitest worker breaks the worker itself
 * (`processTicksAndRejections` and friends touch it before any test code
 * runs). A fresh child process gives us an isolated `globalThis` so the
 * trap can fire safely.
 *
 * Test placement
 * --------------
 * This is a `*.node.test.ts` file on purpose:
 *   - The `unit-node` Vitest project runs in jsdom (no Playwright / Chromium).
 *   - Playwright + Chromium is not available on KASOU hosts, so a real
 *     `*.browser.test.ts` would break `pnpm test:ui` there.
 *   - `*.test.ts` (unit) is jsdom but Vitest may try to evaluate unrelated
 *     module side effects; `unit-node` keeps this isolated.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const distDir = path.join(repoRoot, "dist", "control-ui", "assets");
const probeSource = /* ts */ `
  // The bundle is launched as \`node <probe> <bundle-path> <result-file>\`,
  // so argv[2] is the bundle entry point and argv[3] is where we dump the
  // structured outcome (we use a file because \`process.stdout\` is itself
  // trapped after we install the browser-environment proxy).
  const argv = process.argv.slice();
  const cwd = process.cwd();

  // Replace \`process\` BEFORE importing anything else. We use a Proxy so that
  // any property access — read, has, or call — throws the canonical browser
  // ReferenceError. This is closer to a real browser tab than setting
  // \`process = undefined\`, which would yield a TypeError that bundle code
  // could legitimately try/catch around.
  const trap = new Proxy(function () {
    throw new ReferenceError("process is not defined");
  }, {
    get() { throw new ReferenceError("process is not defined"); },
    has() { throw new ReferenceError("process is not defined"); },
  });
  globalThis.process = trap;
  // We also try to invalidate the \`process\` module in the CommonJS require
  // cache so that bundlers going through createRequire pick up the trap too.
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    req.cache && delete req.cache[req.resolve("process")];
  } catch {
    // Best-effort: a failure here is fine on older Node versions.
  }

  const target = argv[2];
  let outcome;
  try {
    // Re-enter cwd if it changed during module side effects, otherwise
    // resolved relative paths inside the bundle can drift unexpectedly.
    void cwd;
    await import(target);
    outcome = { kind: "loaded" };
  } catch (err) {
    const e = err ?? {};
    const message = String(e.message ?? e);
    const stack = String(e.stack ?? "");
    const causeMessage = e.cause !== undefined && e.cause !== null
      ? String((e.cause && e.cause.message) ?? e.cause)
      : "";
    const leaked = message.includes("process is not defined")
      || stack.includes("process is not defined")
      || causeMessage.includes("process is not defined");
    outcome = {
      kind: leaked ? "leaked-process" : "non-process-error",
      message,
      cause: causeMessage,
    };
  }
  // \`process.stdout.write\` would itself throw under the trap, so we write
  // the outcome through \`fs\` to keep this script dependency-free of any
  // Node-only global access after the trap is installed.
  const fs = await import("node:fs");
  fs.writeFileSync(argv[3], "__WEBUI_BUNDLE_OUTCOME__" + JSON.stringify(outcome));
`;

function findBundleEntry(): string | null {
  if (!fs.existsSync(distDir)) {
    return null;
  }
  const entries = fs.readdirSync(distDir);
  // Vite emits the SPA entry as `index-<hash>.js`.
  const entry = entries.find(
    (name) => name.startsWith("index-") && name.endsWith(".js") && !name.endsWith(".map"),
  );
  return entry ? path.join(distDir, entry) : null;
}

type Outcome =
  | { kind: "loaded" }
  | { kind: "non-process-error"; message: string; cause: string }
  | { kind: "leaked-process"; message: string; cause: string };

async function runProbeInChild(bundlePath: string): Promise<Outcome> {
  const probeFile = path.join(repoRoot, ".tmp-webui-bundle-probe.mjs");
  const resultFile = path.join(repoRoot, ".tmp-webui-bundle-probe.out");
  await fs.promises.rm(resultFile, { force: true });
  await fs.promises.writeFile(probeFile, probeSource, "utf8");

  try {
    return await new Promise<Outcome>((resolve, reject) => {
      const child = spawn(process.execPath, [probeFile, bundlePath, resultFile], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", async (code) => {
        let raw: string;
        try {
          raw = await fs.promises.readFile(resultFile, "utf8");
        } catch (err) {
          reject(
            new Error(
              `probe child exited with code ${code} but result file was not written.\n` +
                `stderr:\n${stderr}\nread error: ${(err as Error).message}`,
            ),
          );
          return;
        }
        const marker = "__WEBUI_BUNDLE_OUTCOME__";
        const idx = raw.lastIndexOf(marker);
        if (idx === -1) {
          reject(
            new Error(
              `probe child exited with code ${code} but result file did not contain an outcome marker.\n` +
                `raw: ${raw}\nstderr:\n${stderr}`,
            ),
          );
          return;
        }
        const json = raw.slice(idx + marker.length).trim();
        try {
          resolve(JSON.parse(json) as Outcome);
        } catch (err) {
          reject(new Error(`could not parse probe JSON: ${(err as Error).message}\nraw: ${json}`));
        }
      });
    });
  } finally {
    await fs.promises.rm(probeFile, { force: true });
    await fs.promises.rm(path.join(repoRoot, ".tmp-webui-bundle-probe.out"), { force: true });
  }
}

describe("WebUI bundle does not throw ReferenceError on module load (browser environment)", () => {
  it("imports the built SPA entry without raising ReferenceError: process is not defined", async () => {
    const bundlePath = findBundleEntry();
    if (bundlePath === null) {
      // The build artefact is absent. We do not fail here so a developer who
      // has not yet run `pnpm ui:build` is not blocked, but we surface a clear
      // warning so the omission does not stay silent.
      // eslint-disable-next-line no-console
      console.warn(
        `[webui-bundle-browser-load] dist/control-ui/assets/index-*.js not found under ${distDir}. ` +
          `Run \`pnpm ui:build\` before running this test if you want the assertion executed.`,
      );
      return;
    }

    const outcome = await runProbeInChild(bundlePath);

    if (outcome.kind === "loaded") {
      // Best case: the bundle loaded and evaluated without any error. The
      // contract holds — no Node-only global leaked into module scope.
      return;
    }

    if (outcome.kind === "leaked-process") {
      expect.fail(
        `WebUI bundle leaked a Node-only \`process\` global during module load.\n` +
          `Original error: ${outcome.message}\n` +
          (outcome.cause ? `Cause: ${outcome.cause}\n` : "") +
          `This regresses the fix in 0cbd5ad29: keep Node-only references ` +
          `(\`process.env\`, \`fs.*\`, \`os.homedir()\`, etc.) out of code that the ` +
          `ui bundle transitively imports.`,
      );
      return;
    }

    // outcome.kind === "non-process-error": module load raised some other
    // browser-API error. That is acceptable on a Node host (jsdom is not a
    // perfect browser). The thing we care about is process-only.
    return;
  });
});

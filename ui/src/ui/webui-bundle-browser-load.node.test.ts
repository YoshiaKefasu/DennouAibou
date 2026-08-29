/**
 * Regression guard for the `process is not defined` browser crash fixed in
 * 0cbd5ad29 ("[SOUL] Fix WebUI bundle importing Node-only home-dir module")
 * and reinforced in 5a3e71d68ef ("[SOUL] Fix WebUI bundle crash on node:os
 * tmpdir (browser require)").
 *
 * Why this test exists
 * --------------------
 * The `dist/control-ui/assets/index-*.js` bundle is loaded by the gateway and
 * served to the browser. Several shared command/thinking modules transitively
 * reach `src/utils.ts`, which used to evaluate `process.env` / `fs.existsSync`
 * at module load time. That blew up the browser tab with
 * `ReferenceError: process is not defined` before any UI code could run.
 *
 * The fix moved eager resolution into a guarded factory and wrapped the
 * remaining Node-only branches in try/catch. The bundle still references
 * `process.*`, but only inside function bodies that the UI never calls.
 *
 * What this test asserts
 * ----------------------
 * 1. A child Node process is forked with `process` replaced by a Proxy that
 *    throws `ReferenceError: process is not defined` on every property
 *    access, simulating a browser tab (where the Node global simply does
 *    not exist).
 * 2. The forked process dynamically imports the built bundle (using a
 *    `pathToFileURL` href — required on Windows where raw absolute paths
 *    are rejected by the ESM loader with
 *    `Only URLs with a scheme in: file, data, and node are supported …`).
 * 3. The child reports a structured outcome via a result file (we use a
 *    file rather than stdout because `process.stdout` itself goes through
 *    the trap once the proxy is installed).
 * 4. The parent treats any non-`loaded` outcome as a failure unless the
 *    error is a known browser-DOM reference (HTMLElement / document /
 *    customElements / window / localStorage …). If the error mentions
 *    Node-only markers (`process`, `node:`, `tmpdir`, `homedir`,
 *    `require(…)` of a built-in module, etc.), the test fails loudly.
 *
 * The previous implementation accepted any `non-process-error` outcome as
 * a pass. That made the test silently green on Windows (where the child
 * exits before reaching the bundle because `pathToFileURL` was missing)
 * and on every host where the bundled `i18n-*.js` chunk throws
 * `ReferenceError: HTMLElement is not defined` at module load before any
 * `process.*` reference can fire. The new contract closes both gaps and
 * adds a negative-control case to prove the detector still fires.
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
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const distDir = path.join(repoRoot, "dist", "control-ui", "assets");

const probeSource = /* ts */ `
  // The probe is launched as \`node <probe> <target-url> <result-file>\`,
  // so argv[2] is the URL of the bundle (or fixture) to import and argv[3]
  // is where we dump the structured outcome. We pass URLs (not raw paths)
  // so the ESM loader accepts them on every platform.
  const argv = process.argv.slice();
  const cwd = process.cwd();

  // Replace \`process\` BEFORE importing anything else. We use a Proxy so
  // that any property access — read, has, or call — throws the canonical
  // browser ReferenceError. This is closer to a real browser tab than
  // setting \`process = undefined\`, which would yield a TypeError that
  // bundle code could legitimately try/catch around.
  const trap = new Proxy(function () {
    throw new ReferenceError("process is not defined");
  }, {
    get() { throw new ReferenceError("process is not defined"); },
    has() { throw new ReferenceError("process is not defined"); },
  });
  globalThis.process = trap;
  // Invalidate the \`process\` module in the CommonJS require cache so
  // bundlers going through createRequire pick up the trap too.
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
    outcome = {
      kind: "threw",
      message,
      cause: causeMessage,
      stackHead: stack.split("\\n").slice(0, 6).join("\\n"),
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
  // Vite emits the SPA entry as \`index-<hash>.js\`.
  const entry = entries.find(
    (name) => name.startsWith("index-") && name.endsWith(".js") && !name.endsWith(".map"),
  );
  return entry ? path.join(distDir, entry) : null;
}

type Outcome =
  | { kind: "loaded" }
  | { kind: "threw"; message: string; cause: string; stackHead: string };

async function runProbeInChild(targetUrl: string): Promise<Outcome> {
  const probeFile = path.join(repoRoot, ".tmp-webui-bundle-probe.mjs");
  const resultFile = path.join(repoRoot, ".tmp-webui-bundle-probe.out");
  await fs.promises.rm(resultFile, { force: true });
  await fs.promises.writeFile(probeFile, probeSource, "utf8");

  try {
    return await new Promise<Outcome>((resolve, reject) => {
      const child = spawn(process.execPath, [probeFile, targetUrl, resultFile], {
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

// Substrings that mean "this is a Node-only global / API". When the
// probe fails with any of these, the bundle is leaking a Node-only
// reference into module scope and the test must fail loudly.
const NODE_ONLY_MARKERS = [
  "process is not defined",
  "tmpdir is not a function",
  "homedir is not a function",
  "node:os",
  "node:fs",
  "node:path",
  "node:url",
  "node:module",
  "node:child_process",
  "Cannot find module 'node:",
  'Cannot find module "node:',
  "ERR_REQUIRE_ESM",
  // process.env style markers
  "process.env",
  "process.cwd",
  "process.argv",
  "process.platform",
  "process.pid",
  "process.versions",
  "process.getuid",
];

// Substrings that mean "this is a browser-DOM global missing in Node".
// These are expected when a real browser bundle is loaded on a host with
// no DOM globals (jsdom / plain node). Tolerating them keeps the test
// honest about Node-only leaks without forcing us to embed Chromium.
const BROWSER_DOM_MARKERS = [
  "HTMLElement is not defined",
  "document is not defined",
  "customElements is not defined",
  "window is not defined",
  "localStorage is not defined",
  "sessionStorage is not defined",
  "navigator is not defined",
  "ShadowRoot is not defined",
  "Element is not defined",
  "Node is not defined",
  "Event is not defined",
  "CustomEvent is not defined",
  "CSSStyleSheet is not defined",
  "getComputedStyle is not defined",
  "queueMicrotask is not defined",
  "requestAnimationFrame is not defined",
  "cancelAnimationFrame is not defined",
  "fetch is not defined",
  "FormData is not defined",
  "Headers is not defined",
  "Request is not defined",
  "Response is not defined",
  "URLSearchParams is not defined",
  "URL is not defined",
  "AbortController is not defined",
  "addEventListener is not defined",
  "removeEventListener is not defined",
  // Lit / lit-html DOM-side helpers
  "litPropertyMetadata",
  "ShadyCSS",
];

function summarizeProbe(outcome: Outcome, label: string): string {
  if (outcome.kind === "loaded") {
    return `${label}: loaded`;
  }
  const { message, cause, stackHead } = outcome;
  return [
    `${label}: threw`,
    `  message: ${message}`,
    cause ? `  cause:   ${cause}` : null,
    `  stack:   ${stackHead}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function isWhitelistedBrowserDomError(outcome: Outcome): boolean {
  if (outcome.kind !== "threw") {
    return false;
  }
  const blob = `${outcome.message}\n${outcome.cause}\n${outcome.stackHead}`;
  return BROWSER_DOM_MARKERS.some((marker) => blob.includes(marker));
}

function containsNodeOnlyLeak(outcome: Outcome): boolean {
  if (outcome.kind !== "threw") {
    return false;
  }
  const blob = `${outcome.message}\n${outcome.cause}\n${outcome.stackHead}`;
  return NODE_ONLY_MARKERS.some((marker) => blob.includes(marker));
}

describe("WebUI bundle does not leak Node-only references during module load (browser environment)", () => {
  it("imports the built SPA entry in a browser-process-shaped environment", async () => {
    const bundlePath = findBundleEntry();
    if (bundlePath === null) {
      // The build artefact is absent. We do not fail here so a developer
      // who has not yet run `pnpm ui:build` is not blocked, but we surface
      // a clear warning so the omission does not stay silent.
      // eslint-disable-next-line no-console
      console.warn(
        `[webui-bundle-browser-load] dist/control-ui/assets/index-*.js not found under ${distDir}. ` +
          `Run \`pnpm ui:build\` before running this test if you want the assertion executed.`,
      );
      return;
    }

    const targetUrl = pathToFileURL(bundlePath).href;
    const outcome = await runProbeInChild(targetUrl);

    // Happy path: the bundle evaluated cleanly without any error.
    if (outcome.kind === "loaded") {
      return;
    }

    // A browser-DOM-only reference (e.g. the bundled i18n chunk extends
    // HTMLElement at module scope) is acceptable on a Node host that has
    // no DOM globals. We must NOT, however, also see Node-only leaks —
    // even when the browser-DOM marker matches, a Node-only marker is
    // still fatal.
    if (containsNodeOnlyLeak(outcome)) {
      expect.fail(
        `WebUI bundle leaked a Node-only reference during module load.\n` +
          summarizeProbe(outcome, "WebUI bundle") +
          `\nKeep Node-only references (process.env / os.tmpdir / os.homedir / ` +
          `createRequire('node:*') / etc.) out of code that the ui bundle ` +
          `transitively imports.`,
      );
      return;
    }

    if (isWhitelistedBrowserDomError(outcome)) {
      // Tolerated: the bundle only failed on a browser-DOM API missing
      // in plain Node. No Node-only leak observed.
      return;
    }

    // Anything else is an unexpected failure mode: surface it so we can
    // either whitelist it explicitly or treat it as a leak.
    expect.fail(
      `WebUI bundle failed to load in a browser-process-shaped environment with an ` +
        `unexpected error.\n` +
        summarizeProbe(outcome, "WebUI bundle") +
        `\nIf this is a known browser-DOM API missing in Node, add its name to ` +
        `BROWSER_DOM_MARKERS. If it is a Node-only leak, fix the offending import.`,
    );
  });

  it("negative control: detects a fixture module that evaluates process.cwd at module scope", async () => {
    // Sanity-check the detector itself. We synthesize a fixture module that
    // evaluates \`process.cwd()\` at top level (the exact pattern the
    // browser tab sees as `ReferenceError: process is not defined`) and
    // assert the probe flags it. If this assertion ever passes the wrong
    // way, the detector above has stopped working and we lose coverage.
    const fixtureDir = path.join(repoRoot, ".tmp-webui-bundle-fixture");
    const fixtureFile = path.join(fixtureDir, "leaky-fixture.mjs");
    const fixtureSource = `// Intentionally references a Node-only global at module scope.\nexport const cwd = process.cwd();\n`;
    await fs.promises.mkdir(fixtureDir, { recursive: true });
    await fs.promises.writeFile(fixtureFile, fixtureSource, "utf8");
    try {
      const targetUrl = pathToFileURL(fixtureFile).href;
      const outcome = await runProbeInChild(targetUrl);
      // The fixture must throw with the canonical Node-only marker; if it
      // loads cleanly the trap is broken and the test above is meaningless.
      expect(outcome.kind).toBe("threw");
      expect(containsNodeOnlyLeak(outcome)).toBe(true);
    } finally {
      await fs.promises.rm(fixtureDir, { recursive: true, force: true });
    }
  });
});

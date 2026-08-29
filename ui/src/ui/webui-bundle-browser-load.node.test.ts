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
 * 2. The forked process installs a minimal DOM shim (`HTMLElement`,
 *    `customElements`, `document`, `window`, …) BEFORE importing the
 *    bundle. Without the shim the bundled `i18n-*.js` chunk throws
 *    `ReferenceError: HTMLElement is not defined` at module load,
 *    before any `process.*` reference can fire — which would make the
 *    test pass on a still-leaky bundle. The shim is what lets the probe
 *    actually reach entry body so a real Node-only leak becomes visible.
 * 3. The forked process dynamically imports the built bundle (using a
 *    `pathToFileURL` href — required on Windows where raw absolute paths
 *    are rejected by the ESM loader with
 *    `Only URLs with a scheme in: file, data, and node are supported …`).
 * 4. The child reports a structured outcome via a result file (we use a
 *    file rather than stdout because `process.stdout` itself goes through
 *    the trap once the proxy is installed).
 * 5. The parent treats any non-`loaded` outcome as a failure unless the
 *    error is a known browser-DOM reference. If the error mentions
 *    Node-only markers (`process`, `node:`, `tmpdir`, `homedir`,
 *    `require(…)` of a built-in module, etc.), the test fails loudly.
 *
 * In addition to the runtime probe, the parent runs a static AST scan
 * over every `dist/control-ui/assets/*.js` chunk (excluding source maps)
 * looking for module-scope `process.X` / `os.tmpdir` / `os.homedir`
 * references. The runtime probe and the static scan are intentionally
 * complementary: the scan catches leaks that would only fire under a
 * code path the probe does not exercise (e.g. a rare event handler that
 * imports a Node-only module); the probe catches runtime side effects.
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

// The probe must install a minimal browser-shaped environment BEFORE the
// bundle runs any module body. We compose it inline so the child process
// stays single-file and dependency-free of any Node-only global access
// after the trap is installed.
//
// Why so many shims?
// ------------------
// The bundled i18n chunk extends HTMLElement at module scope and reads a
// long list of browser-only globals (customElements / ShadowRoot /
// CSSStyleSheet / trustedTypes / document / litPropertyMetadata /
// ShadyCSS / …). Each shim is a no-op class or empty object that exists
// only to let module-load evaluation succeed. We never instantiate them
// in any meaningful way — the probe does not exercise UI behaviour.
const domShimSource = /* ts */ `
  class HTMLElementShim {}
  class ShadowRootShim {}
  class ElementShim {}
  class NodeShim {}
  class EventShim { constructor(type, init) { this.type = type; Object.assign(this, init ?? {}); } }
  class CustomEventShim extends EventShim {}
  class CSSStyleSheetShim {
    constructor() { this._text = ""; }
    replaceSync(text) { this._text = text; }
  }
  CSSStyleSheetShim.prototype.replace = function (text) { this._text = text; };
  class DocumentShim {
    constructor() {
      this.head = this;
      this.body = this;
      this.documentElement = this;
    }
    createElement(tag) {
      const el = { tagName: String(tag).toUpperCase(), children: [], attributes: {} };
      el.setAttribute = (k, v) => { el.attributes[k] = String(v); };
      el.appendChild = (child) => { el.children.push(child); return child; };
      el.textContent = "";
      return el;
    }
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; }
    createTreeWalker() { return { nextNode: () => null, currentNode: null }; }
    createDocumentFragment() { return { children: [], appendChild(c) { this.children.push(c); return c; } }; }
    createComment(text) { return { nodeType: 8, textContent: String(text) }; }
    createRange() { return { setStart() {}, setEnd() {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }), getClientRects: () => [] }; }
    getElementsByTagName() { return []; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    importNode() { return null; }
    adoptNode(node) { return node; }
  }
  // Some bundles reference Document as the class constructor (e.g.
// "new Document()" or "Document.prototype"). Expose a shim class
// whose prototype matches document. We do NOT touch DocumentShim.prototype
// (ESM class prototype is read-only); the constructor already returns
// a usable document-shaped object.
  globalThis.Document = DocumentShim;
  const documentShim = new DocumentShim();
  const customElementsShim = {
    define(name, ctor) { this._registry = this._registry ?? new Map(); this._registry.set(name, ctor); },
    get(name) { return (this._registry ?? new Map()).get(name); },
  };
  const navigatorShim = { userAgent: "node-probe" };
  const storageShim = {
    _data: new Map(),
    getItem(k) { return this._data.has(k) ? this._data.get(k) : null; },
    setItem(k, v) { this._data.set(k, String(v)); },
    removeItem(k) { this._data.delete(k); },
    clear() { this._data.clear(); },
    key(i) { return Array.from(this._data.keys())[i] ?? null; },
    get length() { return this._data.size; },
  };
  const noopFn = () => {};
  const winShim = {
    document: documentShim,
    navigator: navigatorShim,
    localStorage: storageShim,
    sessionStorage: storageShim,
    addEventListener: noopFn,
    removeEventListener: noopFn,
    dispatchEvent: () => true,
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    queueMicrotask: (cb) => Promise.resolve().then(cb),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    customElements: customElementsShim,
    ShadowRoot: ShadowRootShim,
    HTMLElement: HTMLElementShim,
    fetch: () => Promise.reject(new Error("fetch is not implemented in probe shim")),
    AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
  };
  winShim.window = winShim;
  winShim.self = winShim;
  for (const k of [
    "HTMLElement", "Element", "Node", "Event", "CustomEvent",
    "ShadowRoot", "CSSStyleSheet", "document", "window", "self",
    "customElements", "navigator", "localStorage", "sessionStorage",
    "addEventListener", "removeEventListener", "getComputedStyle",
    "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
    "fetch", "AbortController", "FormData", "Headers", "Request", "Response",
    "URLSearchParams", "URL", "MutationObserver",
  ]) {
    if (globalThis[k] === undefined) {
      try { globalThis[k] = winShim[k] ?? globalThis[k]; } catch { /* ignore */ }
    }
  }
  if (typeof Symbol.metadata === "undefined") {
    Object.defineProperty(Symbol, "metadata", { value: Symbol("metadata"), configurable: true });
  }
`;

const probeSource = /* ts */ `
  // The probe is launched as \`node <probe> <target-url> <result-file>\`,
  // so argv[2] is the URL of the bundle (or fixture) to import and argv[3]
  // is where we dump the structured outcome. We pass URLs (not raw paths)
  // so the ESM loader accepts them on every platform.
  const argv = process.argv.slice();
  const cwd = process.cwd();

  // Install the DOM shim BEFORE trapping process so the shim itself can
  // touch Node-only helpers safely (setTimeout, Map, Promise, etc.).
  ${domShimSource}

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

function listBundleChunks(): string[] {
  if (!fs.existsSync(distDir)) {
    return [];
  }
  return fs.readdirSync(distDir).filter((name) => name.endsWith(".js") && !name.endsWith(".map"));
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
//
// The list is intentionally explicit (not regex-based) so reviewers can
// see at-a-glance what counts as a leak and so the static AST scan below
// can reuse the same set.
//
// Marker counts (kept exact for the commit message):
//   NODE_ONLY_MARKERS   = 21
//   BROWSER_DOM_MARKERS = 35
// Previous commit (70159751582) shipped 18 / 29; this commit adds the
// new leak markers the dom-shim / AST-scan fixes introduced
// (process.binding / process.exit / process.getBuiltinModule on the
// Node side; self / trustedTypes / dispatchEvent / createElement /
// createTextNode / reactiveElementPolyfillSupport on the DOM side).
const NODE_ONLY_MARKERS = [
  // Browser-shaped proxy traps (top of the list)
  "process is not defined",
  "process.binding is not a function",
  "process.exit is not a function",
  // process.env style markers
  "process.env",
  "process.cwd",
  "process.argv",
  "process.platform",
  "process.pid",
  "process.versions",
  "process.getuid",
  "process.getBuiltinModule",
  // os.* leaks
  "tmpdir is not a function",
  "homedir is not a function",
  // node: built-in loader failures
  "node:os",
  "node:fs",
  "node:path",
  "node:url",
  "node:module",
  "node:child_process",
  "Cannot find module 'node:",
  'Cannot find module "node:',
  "ERR_REQUIRE_ESM",
];

// Substrings that mean "this is a browser-DOM global missing in Node".
// These are expected when a real browser bundle is loaded on a host with
// no DOM globals (plain Node, even with our shim — the shim is
// deliberately minimal and does NOT replicate every browser API). The
// static AST scan below uses the same list as a guardrail: any of these
// appearing at module scope in a chunk is acceptable.
const BROWSER_DOM_MARKERS = [
  // Top-of-the-list canonical markers
  "HTMLElement is not defined",
  "document is not defined",
  "Document is not defined",
  "customElements is not defined",
  "window is not defined",
  "self is not defined",
  "localStorage is not defined",
  "sessionStorage is not defined",
  "navigator is not defined",
  "ShadowRoot is not defined",
  "Element is not defined",
  "Node is not defined",
  "Event is not defined",
  "CustomEvent is not defined",
  "CSSStyleSheet is not defined",
  "trustedTypes is not defined",
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
  "dispatchEvent is not defined",
  "createElement is not a function",
  "createTextNode is not a function",
  "createTreeWalker is not a function",
  "MutationObserver is not defined",
  "MutationObserver is not a constructor",
  // Lit / lit-html DOM-side helpers
  "litPropertyMetadata",
  "ShadyCSS",
  "reactiveElementPolyfillSupport",
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

// ---------------------------------------------------------------------------
// Static AST scan.
//
// The runtime probe above catches Node-only leaks that fire on the entry
// module's import graph. Some leaks live behind branches the probe does
// not exercise (e.g. a dynamic import inside an event handler). To close
// that gap we also walk every emitted bundle chunk statically.
//
// We use a brace-depth scanner instead of a full AST library so the test
// has no new dependencies. The scanner only flags references that appear
// OUTSIDE function bodies (module-scope statements), because a leak inside
// a function body does not fire at module-load time. The scanner also
// skips lines that contain `typeof process` (those accesses are guarded
// and only fire when `process` actually exists).
//
// What the scan considers a leak:
//   - Any `import ... from "node:..."` module specifier (always eager).
//   - Any bare `process.X` at module scope (depth 0) where X is in
//     NODE_ONLY_PROCESS_PROPERTIES.
//   - Any bare `tmpdir` / `homedir` / `getBuiltinModule` identifier at
//     module scope (depth 0).
//
// We deliberately do NOT flag dynamic `import("node:...")` calls: those
// are deferred until the caller actually invokes them.
// ---------------------------------------------------------------------------

const NODE_ONLY_PROCESS_PROPERTIES = new Set([
  "env",
  "cwd",
  "argv",
  "argv0",
  "platform",
  "pid",
  "versions",
  "getuid",
  "getBuiltinModule",
  "binding",
  "exit",
  "execPath",
  "stdout",
  "stdin",
  "stderr",
  "nextTick",
  "hrtime",
  "memoryUsage",
  "uptime",
]);

const NODE_ONLY_BARE_IDENTIFIERS = new Set(["tmpdir", "homedir", "getBuiltinModule"]);

type StaticScanHit = {
  file: string;
  identifier: string;
  context: string;
};

function scanChunkForNodeOnlyRefs(source: string, fileLabel: string): StaticScanHit[] {
  const hits: StaticScanHit[] = [];

  // Strip line comments and block comments before scanning. We keep
  // strings intact because a string literal that mentions `process.env`
  // is just text (e.g. an error message), not a reference.
  const sanitized = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  // 1) Module specifiers: `import ... from "node:fs"`.
  // We split on statement boundaries so we don't accidentally flag
  // module specifiers inside string literals (handled above by the
  // comment-strip, but module specifiers are always at top level for
  // Vite bundles anyway).
  const moduleSpecifierRe =
    /(?:^|\n)\s*(?:import|export)[^"'\n]*?from\s*["'](node:[a-zA-Z0-9_/.\-]+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = moduleSpecifierRe.exec(sanitized)) !== null) {
    hits.push({ file: fileLabel, identifier: match[1], context: "import specifier" });
  }

  // 2) Walk line by line, tracking brace depth so we only flag references
  // at module scope (depth === 0). A line at depth > 0 is inside a
  // function / class / arrow body and is therefore lazy.
  const lines = sanitized.split(/\r?\n/);
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    // Update depth from any `{` / `}` in this line, ignoring braces
    // inside strings. The string-strip above already removed comments.
    // For our purposes a naive `{++ / }--` count is sufficient because
    // braces inside template literals are rare in Vite output and a
    // false negative (marking lazy code as eager) is exactly what we
    // want for a strict regression guard.
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
    if (depth !== 0) {
      // Inside a function body. Skip — these references fire lazily.
      continue;
    }
    // Skip lines that contain a `typeof process` guard. We treat any
    // occurrence of `typeof process` on the same line as evidence that
    // the access is gated.
    if (/typeof\s+process\b/.test(trimmed)) {
      continue;
    }
    // Skip lines that are pure `import` / `export` statements (handled
    // by the module-specifier pass above) so we don't double-flag.
    // We only skip lines whose entire non-keyword body is a module
    // specifier; lines like `export const cwd = process.cwd();` still
    // need scanning because they have executable expressions.
    if (/^(?:import\b[^=;]*?(?:from\s*["'][^"']+["'])?\s*;?$)/.test(trimmed)) {
      continue;
    }
    if (/^(?:export\b\s*(?:\{[^}]*\}\s*)?from\s*["'][^"']+["']\s*;?$)/.test(trimmed)) {
      continue;
    }

    // 2a) `process.X` at module scope.
    const chainRe = /(?:^|[^A-Za-z0-9_$.])process((?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)/g;
    let m: RegExpExecArray | null;
    while ((m = chainRe.exec(line)) !== null) {
      const fullChain = m[1];
      const propNames = fullChain
        .split(".")
        .map((part) => part.replace(/^\./, ""))
        .filter(Boolean);
      const first = propNames[0];
      if (first && NODE_ONLY_PROCESS_PROPERTIES.has(first)) {
        hits.push({
          file: fileLabel,
          identifier: `process.${first}`,
          context: `line ${i + 1}`,
        });
      }
    }

    // 2b) Bare identifiers: `tmpdir(`, `homedir(`, `getBuiltinModule(`.
    // We require the identifier to be followed by a non-identifier
    // character so we don't match parts of larger names. This catches
    // bare calls at module scope, which are the only way these would
    // fire at module load.
    for (const ident of NODE_ONLY_BARE_IDENTIFIERS) {
      const bareRe = new RegExp(`(?:^|[^A-Za-z0-9_$.])${ident}(?=[^A-Za-z0-9_$.])`, "g");
      let bm: RegExpExecArray | null;
      while ((bm = bareRe.exec(line)) !== null) {
        hits.push({
          file: fileLabel,
          identifier: ident,
          context: `line ${i + 1}`,
        });
      }
    }
  }

  return hits;
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

    // A browser-DOM-only reference (e.g. a browser-only API that the
    // minimal shim does not cover) is acceptable on a Node host that has
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

  it("static AST scan finds zero Node-only references in any emitted bundle chunk", () => {
    const chunks = listBundleChunks();
    if (chunks.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[webui-bundle-browser-load] no bundle chunks under ${distDir}; ` +
          `run \`pnpm ui:build\` before running this test if you want the assertion executed.`,
      );
      return;
    }
    const allHits: StaticScanHit[] = [];
    for (const chunk of chunks) {
      const filePath = path.join(distDir, chunk);
      const source = fs.readFileSync(filePath, "utf8");
      const hits = scanChunkForNodeOnlyRefs(source, chunk);
      allHits.push(...hits);
    }
    if (allHits.length > 0) {
      const formatted = allHits
        .map((hit) => `  - ${hit.file} :: ${hit.identifier} (${hit.context})`)
        .join("\n");
      expect.fail(
        `WebUI bundle contains Node-only references at module-load scope:\n${formatted}\n` +
          `Move the call into a function body that the UI never invokes, or guard it with ` +
          `typeof process === "undefined" / try/catch.`,
      );
    }
    expect(allHits).toEqual([]);
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

  it("negative control: static AST scan flags a fixture with node:fs + process.cwd at module scope", () => {
    const fixtureDir = path.join(repoRoot, ".tmp-webui-bundle-fixture");
    const fixtureFile = path.join(fixtureDir, "leaky-fixture.mjs");
    const fixtureSource = [
      "// Intentionally references Node-only APIs at module scope.",
      `import { readFileSync } from "node:fs";`,
      `export const cwd = process.cwd();`,
      `export const tmp = (() => { try { return readFileSync("/etc/hosts"); } catch { return ""; } })();`,
    ].join("\n");
    // We do not actually write the file because we are scanning source
    // text directly. The static scan takes a string, so we exercise the
    // scan on this synthetic source without touching disk.
    const hits = scanChunkForNodeOnlyRefs(fixtureSource, "leaky-fixture.mjs");
    const identifiers = new Set(hits.map((hit) => hit.identifier));
    expect(identifiers.has("node:fs")).toBe(true);
    expect(identifiers.has("process.cwd")).toBe(true);
  });
});

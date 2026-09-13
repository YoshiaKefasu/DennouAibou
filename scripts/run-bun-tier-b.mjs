#!/usr/bin/env node
// Run the "Tier B" subset of the test suite under `bun test`.
//
// Tier B is the part of the suite that uses only the `vi.*` API that Bun 1.4.0
// actually implements (`vi.fn` / `vi.spyOn` / `vi.mock` plus the timer and
// mock-reset helpers). It is the safe tier of the vitest -> bun test migration:
// no source changes are needed for these files.
//
// Why a script instead of a glob in package.json:
//   1. `bun test` has no `--config`, and it rejects globs for these paths
//      (`bun test "extensions/discord/**/*.test.ts"` reports "no matches").
//      Only directories, substrings, or concrete file paths are accepted.
//   2. Tier B spans 400+ files across `src/`, `extensions/` and `test/`
//      (~17 KB of paths), past the Windows 8191-char cmd.exe limit.
//   3. The classification must be *transitive*: a test that only calls
//      `vi.fn` still crashes when it imports a local helper that calls
//      `vi.hoisted` (`vi.hoisted is not a function`). One such helper is
//      `extensions/discord/src/test-support/component-runtime.ts`.
// So the file list is computed here and passed to bun as an argv array.
//
// Usage:
//   node scripts/run-bun-tier-b.mjs            # Tier B minus known failures
//   node scripts/run-bun-tier-b.mjs --all      # every Tier B file
//   node scripts/run-bun-tier-b.mjs --list     # print the selection, run nothing
//   node scripts/run-bun-tier-b.mjs --verbose  # log the classification tally
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const KNOWN_FAILING_PATH = "test/bun-tier-b-known-failing.txt";

// `vi.*` members Bun 1.4.0 exposes. Measured with `Object.keys((await
// import("bun:test")).vi)`. Anything outside this set is vitest-only.
const BUN_VI = new Set([
  "vi.fn",
  "vi.mock",
  "vi.spyOn",
  "vi.restoreAllMocks",
  "vi.resetAllMocks",
  "vi.clearAllMocks",
  "vi.useFakeTimers",
  "vi.useRealTimers",
  "vi.advanceTimersToNextTimer",
  "vi.advanceTimersByTime",
  "vi.runOnlyPendingTimers",
  "vi.runAllTimers",
  "vi.getTimerCount",
  "vi.clearAllTimers",
  "vi.isFakeTimers",
]);

// live/e2e/browser/vendor suites are out of scope for the migration (Tier S),
// and the UI lane needs jsdom, which `bun test` does not provide.
const OUT_OF_SCOPE_PATH =
  /(^|\/)(vendor|fixtures)(\/|$)|\.live\.test\.|\.e2e\.test\.|^ui\/|^apps\//;
// vitest-only globals that are not reached through `vi`. `expect.poll` and
// `it.runIf` are evaluated at call time and throw under bun:test.
const VITEST_GLOBAL_RE =
  /expect\s*\.\s*(?:poll|soft)\b|import\s*\.\s*meta\s*\.\s*vitest\b|\b(?:it|test|describe)\s*\.\s*(?:runIf|skipIf|todo)\b|\bvi\s*\.\s*(?:hoisted|mocked|waitFor|waitUntil|dynamicImportSettled)\b/;
const IMPORT_RE =
  /(?:import|export)[^"'`;]*?from\s*["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)|require\(\s*["'](\.[^"']+)["']\s*\)/g;

function listTestFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "*.test.ts", "*.test.tsx", "*.test.js", "*.test.mjs"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

const sourceCache = new Map();
function source(rel) {
  if (!sourceCache.has(rel)) {
    sourceCache.set(rel, fs.readFileSync(path.join(ROOT, rel), "utf8"));
  }
  return sourceCache.get(rel);
}

const existsCache = new Map();
function exists(rel) {
  if (!existsCache.has(rel)) {
    existsCache.set(rel, fs.existsSync(path.join(ROOT, rel)));
  }
  return existsCache.get(rel);
}

function viApis(src) {
  return [...new Set([...src.matchAll(/\bvi\.[A-Za-z_$][A-Za-z0-9_$]*/g)].map((m) => m[0]))];
}

// Resolve local imports the way bun does: explicit path, `.js` -> `.ts`, or index.
function localDeps(rel) {
  const dir = path.posix.dirname(rel);
  const out = [];
  for (const m of source(rel).matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec) {
      continue;
    }
    const base = path.posix.normalize(path.posix.join(dir, spec));
    const candidates = [
      base,
      base.replace(/\.js$/, ".ts"),
      base.replace(/\.js$/, ".tsx"),
      `${base}.ts`,
      `${base}.tsx`,
      path.posix.join(base, "index.ts"),
    ];
    for (const c of candidates) {
      if (exists(c)) {
        out.push(c);
        break;
      }
    }
  }
  return out;
}

// Memoized transitive check: does this file (or any local helper it pulls in)
// use a vitest-only API?
const memo = new Map();
function analyze(rel, stack = new Set()) {
  if (memo.has(rel)) {
    return memo.get(rel);
  }
  if (stack.has(rel) || !exists(rel)) {
    return { ok: true, usesVi: false };
  }
  stack.add(rel);
  const src = source(rel);
  const apis = viApis(src);
  let ok = apis.every((a) => BUN_VI.has(a)) && !VITEST_GLOBAL_RE.test(src);
  let usesVi = apis.length > 0;
  if (ok) {
    for (const d of localDeps(rel)) {
      const child = analyze(d, stack);
      if (!child.ok) {
        ok = false;
      }
      usesVi ||= child.usesVi;
    }
  }
  stack.delete(rel);
  const res = { ok, usesVi };
  memo.set(rel, res);
  return res;
}

function classify() {
  const tier = [];
  const skipped = { outOfScope: 0, vitestOnly: 0, tierA: 0 };
  for (const f of listTestFiles()) {
    if (OUT_OF_SCOPE_PATH.test(f)) {
      skipped.outOfScope++;
      continue;
    }
    const { ok, usesVi } = analyze(f);
    if (!ok) {
      skipped.vitestOnly++;
      continue;
    }
    // A file that reaches no `vi.*` at all (not even through a helper) is
    // Tier A: viable under bun, but it exercises none of the mock surface this
    // tier exists to validate.
    if (!usesVi) {
      skipped.tierA++;
      continue;
    }
    tier.push(f);
  }
  return { tier, skipped };
}

function readKnownFailing() {
  const abs = path.join(ROOT, KNOWN_FAILING_PATH);
  if (!fs.existsSync(abs)) {
    return new Set();
  }
  return new Set(
    fs
      .readFileSync(abs, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}

function main() {
  const args = new Set(process.argv.slice(2));
  const { tier, skipped } = classify();
  const knownFailing = readKnownFailing();
  const includeAll = args.has("--all");
  const known = tier.filter((f) => knownFailing.has(f));
  const selected = includeAll ? tier : tier.filter((f) => !knownFailing.has(f));

  if (args.has("--verbose") || args.has("--list")) {
    const lines = [
      `Tier B: ${tier.length} files (${skipped.vitestOnly} vitest-only, ${skipped.tierA} tier-A, ${skipped.outOfScope} out-of-scope skipped)`,
      `${KNOWN_FAILING_PATH}: ${known.length} matching Tier B files (${knownFailing.size} entries listed)`,
      `selected: ${selected.length} files${includeAll ? " (--all)" : ""}`,
    ];
    // On --list keep stdout to bare paths so the output can be piped.
    console.error(lines.join("\n"));
  }

  if (args.has("--list")) {
    console.log(selected.join("\n"));
    return 0;
  }

  if (selected.length === 0) {
    console.error("No Tier B test files selected.");
    return 1;
  }

  // `--isolate` is required: without it bun shares one module registry across
  // files, and Tier B files leak module-level state into each other (the
  // discord subset alone shows 17 spurious failures). Every file gets a fresh
  // global plus a re-run of the bunfig preload, matching vitest's default.
  const child = spawnSync("bun", ["test", "--isolate", ...selected], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (child.error) {
    console.error(`Failed to launch bun: ${child.error.message}`);
    return 1;
  }
  return child.status ?? 1;
}

process.exit(main());

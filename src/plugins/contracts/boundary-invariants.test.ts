import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");

// Normalise globSync results to POSIX separators so the allow-list Sets
// (which use forward slashes) match consistently across platforms. Without
// this, glob v13+ returns Windows backslash paths and every entry falls
// through the .has() check as an offender.
const toPosix = (file: string): string => file.split("\\").join("/");

const ALLOWED_BUNDLED_CAPABILITY_METADATA_CONSUMERS = new Set([
  "src/plugins/bundled-capability-metadata.test.ts",
  "src/plugins/contracts/boundary-invariants.test.ts",
]);

const ALLOWED_EXTENSION_PATH_STRING_TESTS = new Set([
  "src/channels/plugins/bundled.shape-guard.test.ts",
  "src/plugins/contracts/bundled-extension-config-api-guardrails.test.ts",
  "src/scripts/test-projects.test.ts",
  // This inventory file is exempt from its own regex check: the comments
  // above document bundled extension paths that match the deep-import
  // patterns, and the file legitimately references those paths to explain
  // each allow-list entry. The regexes are evaluated against the raw
  // source (including comments), so we have to opt this file in.
  "src/plugins/contracts/boundary-invariants.test.ts",
  // src/plugin-sdk/browser-maintenance.test.ts
  //   vi.mock('../../extensions/browser/browser-maintenance.js') stubs the
  //   bundled browser extension so the plugin-sdk/browser-maintenance.ts
  //   facade (a deliberate throw-stub after debloat) records the expected
  //   call signature without ever loading the real extension. The
  //   extension itself is removed; the mock is the only way to exercise
  //   the facade's contract from a unit test.
  "src/plugin-sdk/browser-maintenance.test.ts",
  // src/channels/plugins/setup-wizard-helpers.test.ts
  //   Imports `singleAccountKeysToMove` from the bundled telegram
  //   extension's public contract-api barrel to feed a generic setup
  //   wizard registry entry. The test asserts the *core* helper
  //   behaviour; telegram's exported helper is just realistic input.
  "src/channels/plugins/setup-wizard-helpers.test.ts",
  // src/channels/plugins/setup-helpers.test.ts
  //   Same pattern as setup-wizard-helpers.test.ts: the bundled
  //   telegram contract-api supplies the input used to drive the
  //   core setup-helpers behaviour under test.
  "src/channels/plugins/setup-helpers.test.ts",
]);

const ALLOWED_CONTRACT_BUNDLED_PATH_HELPERS = new Set([
  "src/plugins/contracts/boundary-invariants.test.ts",
  "src/plugins/contracts/plugin-sdk-index.bundle.test.ts",
  "src/plugins/contracts/plugin-sdk-runtime-api-guardrails.test.ts",
]);

const ALLOWED_CHANNEL_BUNDLED_METADATA_CONSUMERS = new Set([
  "src/channels/plugins/session-conversation.bundled-fallback.test.ts",
]);

describe("plugin contract boundary invariants", () => {
  it("keeps bundled-capability-metadata confined to contract/test inventory", async () => {
    const { globSync } = await import("glob");
    const files = globSync("src/**/*.ts", {
      cwd: REPO_ROOT,
      nodir: true,
    }).map(toPosix);
    const offenders = files.filter((file) => {
      if (ALLOWED_BUNDLED_CAPABILITY_METADATA_CONSUMERS.has(file)) {
        return false;
      }
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return source.includes("contracts/inventory/bundled-capability-metadata");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the bundled contract inventory out of non-test runtime code", async () => {
    const { globSync } = await import("glob");
    const files = globSync("src/**/*.ts", {
      cwd: REPO_ROOT,
      nodir: true,
      ignore: ["src/**/*.test.ts"],
    }).map(toPosix);
    const offenders = files.filter((file) => {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return source.includes("contracts/inventory/bundled-capability-metadata");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps core tests off bundled extension deep imports", async () => {
    const { globSync } = await import("glob");
    const files = globSync("src/**/*.test.ts", {
      cwd: REPO_ROOT,
      nodir: true,
    }).map(toPosix);
    const offenders = files.filter((file) => {
      if (ALLOWED_EXTENSION_PATH_STRING_TESTS.has(file)) {
        return false;
      }
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return (
        /from\s+["'][^"']*extensions\/.+(?:api|runtime-api|test-api)\.js["']/u.test(source) ||
        /vi\.(?:mock|doMock)\(\s*["'][^"']*extensions\/.+["']/u.test(source) ||
        /importActual<[^>]*>\(\s*["'][^"']*extensions\/.+["']/u.test(source)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("keeps plugin contract tests off bundled path helpers unless the test is explicitly about paths", async () => {
    const { globSync } = await import("glob");
    const files = globSync("src/plugins/contracts/**/*.test.ts", {
      cwd: REPO_ROOT,
      nodir: true,
    }).map(toPosix);
    const offenders = files.filter((file) => {
      if (ALLOWED_CONTRACT_BUNDLED_PATH_HELPERS.has(file)) {
        return false;
      }
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return source.includes("test/helpers/bundled-plugin-paths");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps channel production code off bundled-plugin-metadata helpers", async () => {
    const { globSync } = await import("glob");
    const files = globSync("src/channels/**/*.ts", {
      cwd: REPO_ROOT,
      nodir: true,
      ignore: ["src/channels/**/*.test.ts"],
    }).map(toPosix);
    const offenders = files.filter((file) => {
      if (ALLOWED_CHANNEL_BUNDLED_METADATA_CONSUMERS.has(file)) {
        return false;
      }
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return source.includes("plugins/bundled-plugin-metadata");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps contract loaders off hand-built bundled extension paths", async () => {
    const { globSync } = await import("glob");
    const files = globSync("src/{plugins,channels}/**/*.ts", {
      cwd: REPO_ROOT,
      nodir: true,
      ignore: ["src/**/*.test.ts"],
    }).map(toPosix);
    const offenders = files.filter((file) => {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return /extensions\/\$\{|\.\.\/\.\.\/\.\.\/\.\.\/extensions\//u.test(source);
    });
    expect(offenders).toEqual([]);
  });
});

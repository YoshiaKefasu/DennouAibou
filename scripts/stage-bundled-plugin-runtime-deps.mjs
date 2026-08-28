import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semverSatisfies from "semver/functions/satisfies.js";
import semverValid from "semver/functions/valid.js";
import { resolveNpmRunner } from "./npm-runner.mjs";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function removePathIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function makeTempDir(parentDir, prefix) {
  return fs.mkdtempSync(path.join(parentDir, prefix));
}

function sanitizeTempPrefixSegment(value) {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return normalized.length > 0 ? normalized : "plugin";
}

function replaceDir(targetPath, sourcePath) {
  removePathIfExists(targetPath);
  try {
    fs.renameSync(sourcePath, targetPath);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
  }
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
  removePathIfExists(sourcePath);
}

function dependencyNodeModulesPath(nodeModulesDir, depName) {
  return path.join(nodeModulesDir, ...depName.split("/"));
}

function readInstalledDependencyVersion(nodeModulesDir, depName) {
  const packageJsonPath = path.join(
    dependencyNodeModulesPath(nodeModulesDir, depName),
    "package.json",
  );
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  const version = readJson(packageJsonPath).version;
  return typeof version === "string" ? version : null;
}

function dependencyVersionSatisfied(spec, installedVersion) {
  if (semverSatisfies(installedVersion, spec, { includePrerelease: false })) {
    return true;
  }
  // Transitive bare exact pins inside bundled plugins (e.g. @buape/carbon
  // pinning discord-api-types 0.38.37 while the workspace installs 0.38.44)
  // reject the exact-spec check even though the installed version is newer.
  // Accept ONLY bare exact pins (semverValid(spec) !== null) matched against a
  // caret range so a newer patch/minor within the same major passes, while
  // out-of-range newer versions (e.g. ^1.2.3 vs installed 2.5.0) still fall
  // back to a network npm install that resolves the right version.
  return (
    semverValid(spec) !== null &&
    semverSatisfies(installedVersion, `^${spec}`, { includePrerelease: false })
  );
}

const stagedRuntimeDepPruneRules = new Map([
  // Type declarations only; runtime resolves through lib/es entrypoints.
  ["@larksuiteoapi/node-sdk", ["types"]],
]);
const runtimeDepsStagingVersion = 2;

function collectInstalledRuntimeClosure(
  rootNodeModulesDir,
  dependencySpecs,
  dependencyOptionality,
) {
  const packageCache = new Map();
  const closure = new Set();
  const queue = Object.entries(dependencySpecs).map(([name, spec]) => [
    name,
    spec,
    dependencyOptionality.get(name) === true,
  ]);

  while (queue.length > 0) {
    const [depName, spec, optional] = queue.shift();
    const installedVersion = readInstalledDependencyVersion(rootNodeModulesDir, depName);
    if (installedVersion === null) {
      // Optional dependencies (and optional transitive deps, e.g. @snazzah/davey's
      // per-platform native binaries) may legitimately be absent from the hoisted
      // root install; skip them instead of failing the fast path.
      if (optional) {
        continue;
      }
      return null;
    }
    if (!dependencyVersionSatisfied(spec, installedVersion)) {
      // Same tolerance for optional deps pinned to versions overridden at the
      // workspace root (e.g. @buape/carbon pins ws 8.19.0 while the root override
      // installs 8.20.0). An installed newer version still satisfies runtime use;
      // a genuinely missing/mismatched required dep still falls back to npm.
      if (optional) {
        // Keep walking children so optional chains still contribute closure deps.
      } else {
        return null;
      }
    }
    if (closure.has(depName)) {
      continue;
    }

    const packageJsonPath = path.join(
      dependencyNodeModulesPath(rootNodeModulesDir, depName),
      "package.json",
    );
    const packageJson = packageCache.get(depName) ?? readJson(packageJsonPath);
    packageCache.set(depName, packageJson);
    closure.add(depName);

    for (const [childName, childSpec] of Object.entries(packageJson.dependencies ?? {})) {
      queue.push([childName, childSpec, false]);
    }
    for (const [childName, childSpec] of Object.entries(packageJson.optionalDependencies ?? {})) {
      queue.push([childName, childSpec, true]);
    }
  }

  return [...closure];
}

function pruneStagedInstalledDependencyCargo(nodeModulesDir, depName) {
  const prunePaths = stagedRuntimeDepPruneRules.get(depName);
  if (!prunePaths) {
    return;
  }
  const depRoot = dependencyNodeModulesPath(nodeModulesDir, depName);
  for (const relativePath of prunePaths) {
    removePathIfExists(path.join(depRoot, relativePath));
  }
}

function pruneStagedRuntimeDependencyCargo(nodeModulesDir) {
  for (const depName of stagedRuntimeDepPruneRules.keys()) {
    pruneStagedInstalledDependencyCargo(nodeModulesDir, depName);
  }
}

function listBundledPluginRuntimeDirs(repoRoot) {
  const extensionsRoot = path.join(repoRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return [];
  }

  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.join(extensionsRoot, dirent.name))
    .filter((pluginDir) => fs.existsSync(path.join(pluginDir, "package.json")));
}

function hasRuntimeDeps(packageJson) {
  return (
    Object.keys(packageJson.dependencies ?? {}).length > 0 ||
    Object.keys(packageJson.optionalDependencies ?? {}).length > 0
  );
}

function shouldStageRuntimeDeps(packageJson) {
  return packageJson.openclaw?.bundle?.stageRuntimeDependencies === true;
}

function sanitizeBundledManifestForRuntimeInstall(pluginDir) {
  const manifestPath = path.join(pluginDir, "package.json");
  const packageJson = readJson(manifestPath);
  let changed = false;

  if (packageJson.peerDependencies?.openclaw) {
    const nextPeerDependencies = { ...packageJson.peerDependencies };
    delete nextPeerDependencies.openclaw;
    if (Object.keys(nextPeerDependencies).length === 0) {
      delete packageJson.peerDependencies;
    } else {
      packageJson.peerDependencies = nextPeerDependencies;
    }
    changed = true;
  }

  if (packageJson.peerDependenciesMeta?.openclaw) {
    const nextPeerDependenciesMeta = { ...packageJson.peerDependenciesMeta };
    delete nextPeerDependenciesMeta.openclaw;
    if (Object.keys(nextPeerDependenciesMeta).length === 0) {
      delete packageJson.peerDependenciesMeta;
    } else {
      packageJson.peerDependenciesMeta = nextPeerDependenciesMeta;
    }
    changed = true;
  }

  if (packageJson.devDependencies?.openclaw) {
    const nextDevDependencies = { ...packageJson.devDependencies };
    delete nextDevDependencies.openclaw;
    if (Object.keys(nextDevDependencies).length === 0) {
      delete packageJson.devDependencies;
    } else {
      packageJson.devDependencies = nextDevDependencies;
    }
    changed = true;
  }

  if (changed) {
    writeJson(manifestPath, packageJson);
  }

  return packageJson;
}

function resolveRuntimeDepsStampPath(pluginDir) {
  return path.join(pluginDir, ".openclaw-runtime-deps-stamp.json");
}

function createRuntimeDepsFingerprint(packageJson) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        packageJson,
        pruneRules: [...stagedRuntimeDepPruneRules.entries()],
        version: runtimeDepsStagingVersion,
      }),
    )
    .digest("hex");
}

function readRuntimeDepsStamp(stampPath) {
  if (!fs.existsSync(stampPath)) {
    return null;
  }
  try {
    return readJson(stampPath);
  } catch {
    return null;
  }
}

function stageInstalledRootRuntimeDeps(params) {
  const { fingerprint, packageJson, pluginDir, repoRoot } = params;
  const dependencySpecs = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
  const dependencyOptionality = new Map([
    ...Object.keys(packageJson.dependencies ?? {}).map((name) => [name, false]),
    ...Object.keys(packageJson.optionalDependencies ?? {}).map((name) => [name, true]),
  ]);
  const rootNodeModulesDir = path.join(repoRoot, "node_modules");
  if (Object.keys(dependencySpecs).length === 0 || !fs.existsSync(rootNodeModulesDir)) {
    return false;
  }

  const dependencyNames = collectInstalledRuntimeClosure(
    rootNodeModulesDir,
    dependencySpecs,
    dependencyOptionality,
  );
  if (dependencyNames === null) {
    return false;
  }

  const nodeModulesDir = path.join(pluginDir, "node_modules");
  const stampPath = resolveRuntimeDepsStampPath(pluginDir);
  const stagedNodeModulesDir = path.join(
    makeTempDir(
      os.tmpdir(),
      `openclaw-runtime-deps-${sanitizeTempPrefixSegment(path.basename(pluginDir))}-`,
    ),
    "node_modules",
  );

  try {
    for (const depName of dependencyNames) {
      const sourcePath = dependencyNodeModulesPath(rootNodeModulesDir, depName);
      const targetPath = dependencyNodeModulesPath(stagedNodeModulesDir, depName);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.cpSync(sourcePath, targetPath, { recursive: true, force: true, dereference: true });
    }
    pruneStagedRuntimeDependencyCargo(stagedNodeModulesDir);

    replaceDir(nodeModulesDir, stagedNodeModulesDir);
    writeJson(stampPath, {
      fingerprint,
      generatedAt: new Date().toISOString(),
    });
    return true;
  } finally {
    removePathIfExists(path.dirname(stagedNodeModulesDir));
  }
}

function installPluginRuntimeDeps(params) {
  const { fingerprint, packageJson, pluginDir, pluginId, repoRoot } = params;
  if (
    repoRoot &&
    stageInstalledRootRuntimeDeps({ fingerprint, packageJson, pluginDir, repoRoot })
  ) {
    return;
  }
  const nodeModulesDir = path.join(pluginDir, "node_modules");
  const stampPath = resolveRuntimeDepsStampPath(pluginDir);
  const tempInstallDir = makeTempDir(
    os.tmpdir(),
    `openclaw-runtime-deps-${sanitizeTempPrefixSegment(pluginId)}-`,
  );
  const npmRunner = resolveNpmRunner({
    npmArgs: [
      "install",
      "--omit=dev",
      "--silent",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--package-lock=false",
    ],
  });
  try {
    writeJson(path.join(tempInstallDir, "package.json"), packageJson);
    // Strip npm/pnpm lifecycle env leakage (npm_config_*, npm_command, PNPM_*).
    // When this script runs inside `pnpm build`, inherited npm_config_* vars
    // (user-agent, registry overrides, verify-deps flags, ...) change how the
    // child npm install resolves packages and can fail it spuriously.
    // npm-runner's toolchain runner omits `env` on Windows; fall back to
    // process.env so PATH/USERPROFILE/SystemRoot survive the sanitize pass.
    const childEnv = { ...(npmRunner.env ?? process.env) };
    for (const key of Object.keys(childEnv)) {
      if (
        /^npm_config_/i.test(key) ||
        /^npm_(command|lifecycle_event)$/i.test(key) ||
        /^pnpm_/i.test(key)
      ) {
        delete childEnv[key];
      }
    }
    const result = spawnSync(npmRunner.command, npmRunner.args, {
      cwd: tempInstallDir,
      encoding: "utf8",
      env: childEnv,
      stdio: "pipe",
      shell: npmRunner.shell,
      windowsVerbatimArguments: npmRunner.windowsVerbatimArguments,
    });
    if (result.status !== 0) {
      const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(
        `failed to stage bundled runtime deps for ${pluginId}: ${output || "npm install failed"}`,
      );
    }

    const stagedNodeModulesDir = path.join(tempInstallDir, "node_modules");
    if (!fs.existsSync(stagedNodeModulesDir)) {
      throw new Error(
        `failed to stage bundled runtime deps for ${pluginId}: npm install produced no node_modules directory`,
      );
    }

    pruneStagedRuntimeDependencyCargo(stagedNodeModulesDir);

    replaceDir(nodeModulesDir, stagedNodeModulesDir);
    writeJson(stampPath, {
      fingerprint,
      generatedAt: new Date().toISOString(),
    });
  } finally {
    removePathIfExists(tempInstallDir);
  }
}

function installPluginRuntimeDepsWithRetries(params) {
  const { attempts = 3 } = params;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      params.install({ ...params.installParams, attempt });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
    }
  }
  throw lastError;
}

export function stageBundledPluginRuntimeDeps(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const installPluginRuntimeDepsImpl =
    params.installPluginRuntimeDepsImpl ?? installPluginRuntimeDeps;
  const installAttempts = params.installAttempts ?? 3;
  for (const pluginDir of listBundledPluginRuntimeDirs(repoRoot)) {
    const pluginId = path.basename(pluginDir);
    const packageJson = sanitizeBundledManifestForRuntimeInstall(pluginDir);
    const nodeModulesDir = path.join(pluginDir, "node_modules");
    const stampPath = resolveRuntimeDepsStampPath(pluginDir);
    if (!hasRuntimeDeps(packageJson) || !shouldStageRuntimeDeps(packageJson)) {
      removePathIfExists(nodeModulesDir);
      removePathIfExists(stampPath);
      continue;
    }
    const fingerprint = createRuntimeDepsFingerprint(packageJson);
    const stamp = readRuntimeDepsStamp(stampPath);
    if (fs.existsSync(nodeModulesDir) && stamp?.fingerprint === fingerprint) {
      continue;
    }
    installPluginRuntimeDepsWithRetries({
      attempts: installAttempts,
      install: installPluginRuntimeDepsImpl,
      installParams: {
        fingerprint,
        packageJson,
        pluginDir,
        pluginId,
        repoRoot,
      },
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  stageBundledPluginRuntimeDeps();
}

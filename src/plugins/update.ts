import type { OpenClawConfig } from "../config/config.js";
import {
  expectedIntegrityForUpdate,
  readInstalledPackageVersion,
} from "../infra/package-update-utils.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { resolveUserPath } from "../utils.js";
import { resolveBundledPluginSources } from "./bundled-sources.js";
import { installPluginFromClawHub, resolveClawHubPluginVersion } from "./clawhub.js";
import {
  installPluginFromNpmSpec,
  PLUGIN_INSTALL_ERROR_CODE,
  resolvePluginInstallDir,
} from "./install.js";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "./installs.js";
import { installPluginFromMarketplace } from "./marketplace.js";

export type PluginUpdateLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type PluginUpdateStatus = "updated" | "unchanged" | "skipped" | "error";

export type PluginUpdateOutcome = {
  pluginId: string;
  status: PluginUpdateStatus;
  message: string;
  currentVersion?: string;
  nextVersion?: string;
};

export type PluginUpdateSummary = {
  config: OpenClawConfig;
  changed: boolean;
  outcomes: PluginUpdateOutcome[];
};

export type PluginUpdateIntegrityDriftParams = {
  pluginId: string;
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolvedSpec?: string;
  resolvedVersion?: string;
  dryRun: boolean;
};

export type PluginChannelSyncSummary = {
  switchedToBundled: string[];
  switchedToNpm: string[];
  warnings: string[];
  errors: string[];
};

export type PluginChannelSyncResult = {
  config: OpenClawConfig;
  changed: boolean;
  summary: PluginChannelSyncSummary;
};

function formatNpmInstallFailure(params: {
  pluginId: string;
  spec: string;
  phase: "check" | "update";
  result: { error: string; code?: string };
}): string {
  if (params.result.code === PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND) {
    return `Failed to ${params.phase} ${params.pluginId}: npm package not found for ${params.spec}.`;
  }
  return `Failed to ${params.phase} ${params.pluginId}: ${params.result.error}`;
}

function formatMarketplaceInstallFailure(params: {
  pluginId: string;
  marketplaceSource: string;
  marketplacePlugin: string;
  phase: "check" | "update";
  error: string;
}): string {
  return (
    `Failed to ${params.phase} ${params.pluginId}: ` +
    `${params.error} (marketplace plugin ${params.marketplacePlugin} from ${params.marketplaceSource}).`
  );
}

function formatClawHubInstallFailure(params: {
  pluginId: string;
  spec: string;
  phase: "check" | "update";
  error: string;
}): string {
  return `Failed to ${params.phase} ${params.pluginId}: ${params.error} (ClawHub ${params.spec}).`;
}

type ClawHubUpdateMode = "legacy-exact-to-latest" | "explicit-clawhub-selector" | "unversioned-clawhub";

type ClawHubUpdateSpecResult = {
  installSpec: string;
  recordSpec: string;
  modeLabel: ClawHubUpdateMode;
};

/**
 * Resolve the effective ClawHub update spec for targeted id-based updates.
 *
 * Rules:
 * 1. Explicit spec override wins and is preserved exactly.
 * 2. Already-unversioned record stays unversioned.
 * 3. Legacy exact record with id-only update → latest-line intent (unversioned).
 * 4. Dist-tag selectors (e.g. @beta) remain pinned.
 */
function resolveClawHubUpdateSpec(params: {
  record: { spec: string; clawhubPackage?: string };
  specOverride?: string;
  invokedByIdOnly: boolean;
}): ClawHubUpdateSpecResult {
  const { record, specOverride, invokedByIdOnly } = params;
  const recordSpec = record.spec;
  const fallbackSpec = `clawhub:${record.clawhubPackage ?? ""}`;

  // Rule 1: explicit spec override wins exactly.
  if (specOverride) {
    return { installSpec: specOverride, recordSpec, modeLabel: "explicit-clawhub-selector" };
  }

  // Parse the record spec to check version/tag presence.
  const atIndex = recordSpec.lastIndexOf("@");
  const hasVersionPart = atIndex > 0 && atIndex < recordSpec.length - 1;
  const versionPart = hasVersionPart ? recordSpec.slice(atIndex + 1) : "";

  // Rule 4: dist-tag selectors (non-semver tags like @beta) remain pinned.
  // Distinguish tags from versions: tags are not valid semver (no dots).
  const isDistTag = hasVersionPart && !/^\d+\.\d+\.\d+/.test(versionPart);
  if (isDistTag) {
    return { installSpec: recordSpec, recordSpec, modeLabel: "explicit-clawhub-selector" };
  }

  // Rule 2: already-unversioned record stays unversioned.
  if (!hasVersionPart) {
    return { installSpec: recordSpec || fallbackSpec, recordSpec, modeLabel: "unversioned-clawhub" };
  }

  // Rule 3: legacy exact record with id-only update → latest-line intent.
  if (invokedByIdOnly) {
    const pkgName = record.clawhubPackage ?? recordSpec.slice("clawhub:".length).replace(/@.*/, "");
    const unversionedSpec = `clawhub:${pkgName}`;
    return { installSpec: unversionedSpec, recordSpec, modeLabel: "legacy-exact-to-latest" };
  }

  // Fallback: keep the recorded spec as-is.
  return { installSpec: recordSpec || fallbackSpec, recordSpec, modeLabel: "unversioned-clawhub" };
}

type InstallIntegrityDrift = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: {
    resolvedSpec?: string;
    version?: string;
  };
};

function pathsEqual(
  left: string | undefined,
  right: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!left || !right) {
    return false;
  }
  return resolveUserPath(left, env) === resolveUserPath(right, env);
}

function buildLoadPathHelpers(existing: string[], env: NodeJS.ProcessEnv = process.env) {
  let paths = [...existing];
  const resolveSet = () => new Set(paths.map((entry) => resolveUserPath(entry, env)));
  let resolved = resolveSet();
  let changed = false;

  const addPath = (value: string) => {
    const normalized = resolveUserPath(value, env);
    if (resolved.has(normalized)) {
      return;
    }
    paths.push(value);
    resolved.add(normalized);
    changed = true;
  };

  const removePath = (value: string) => {
    const normalized = resolveUserPath(value, env);
    if (!resolved.has(normalized)) {
      return;
    }
    paths = paths.filter((entry) => resolveUserPath(entry, env) !== normalized);
    resolved = resolveSet();
    changed = true;
  };

  return {
    addPath,
    removePath,
    get changed() {
      return changed;
    },
    get paths() {
      return paths;
    },
  };
}

function replacePluginIdInList(
  entries: string[] | undefined,
  fromId: string,
  toId: string,
): string[] | undefined {
  if (!entries || entries.length === 0 || fromId === toId) {
    return entries;
  }
  const next: string[] = [];
  for (const entry of entries) {
    const value = entry === fromId ? toId : entry;
    if (!next.includes(value)) {
      next.push(value);
    }
  }
  return next;
}

function migratePluginConfigId(cfg: OpenClawConfig, fromId: string, toId: string): OpenClawConfig {
  if (fromId === toId) {
    return cfg;
  }

  const installs = cfg.plugins?.installs;
  const entries = cfg.plugins?.entries;
  const slots = cfg.plugins?.slots;
  const allow = replacePluginIdInList(cfg.plugins?.allow, fromId, toId);
  const deny = replacePluginIdInList(cfg.plugins?.deny, fromId, toId);

  const nextInstalls = installs ? { ...installs } : undefined;
  if (nextInstalls && fromId in nextInstalls) {
    const record = nextInstalls[fromId];
    if (record && !(toId in nextInstalls)) {
      nextInstalls[toId] = record;
    }
    delete nextInstalls[fromId];
  }

  const nextEntries = entries ? { ...entries } : undefined;
  if (nextEntries && fromId in nextEntries) {
    const entry = nextEntries[fromId];
    if (entry) {
      nextEntries[toId] = nextEntries[toId]
        ? {
            ...entry,
            ...nextEntries[toId],
          }
        : entry;
    }
    delete nextEntries[fromId];
  }

  const nextSlots =
    slots?.memory === fromId
      ? {
          ...slots,
          memory: toId,
        }
      : slots;

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow,
      deny,
      entries: nextEntries,
      installs: nextInstalls,
      slots: nextSlots,
    },
  };
}

function createPluginUpdateIntegrityDriftHandler(params: {
  pluginId: string;
  dryRun: boolean;
  logger: PluginUpdateLogger;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}) {
  return async (drift: InstallIntegrityDrift) => {
    const payload: PluginUpdateIntegrityDriftParams = {
      pluginId: params.pluginId,
      spec: drift.spec,
      expectedIntegrity: drift.expectedIntegrity,
      actualIntegrity: drift.actualIntegrity,
      resolvedSpec: drift.resolution.resolvedSpec,
      resolvedVersion: drift.resolution.version,
      dryRun: params.dryRun,
    };
    if (params.onIntegrityDrift) {
      return await params.onIntegrityDrift(payload);
    }
    params.logger.warn?.(
      `Integrity drift for "${params.pluginId}" (${payload.resolvedSpec ?? payload.spec}): expected ${payload.expectedIntegrity}, got ${payload.actualIntegrity}`,
    );
    return true;
  };
}

export async function updateNpmInstalledPlugins(params: {
  config: OpenClawConfig;
  logger?: PluginUpdateLogger;
  pluginIds?: string[];
  skipIds?: Set<string>;
  dryRun?: boolean;
  dangerouslyForceUnsafeInstall?: boolean;
  specOverrides?: Record<string, string>;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<PluginUpdateSummary> {
  const logger = params.logger ?? {};
  const installs = params.config.plugins?.installs ?? {};
  const targets = params.pluginIds?.length ? params.pluginIds : Object.keys(installs);
  const outcomes: PluginUpdateOutcome[] = [];
  let next = params.config;
  let changed = false;

  for (const pluginId of targets) {
    if (params.skipIds?.has(pluginId)) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (already updated).`,
      });
      continue;
    }

    const record = installs[pluginId];
    if (!record) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `No install record for "${pluginId}".`,
      });
      continue;
    }

    if (record.source !== "npm" && record.source !== "marketplace" && record.source !== "clawhub") {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (source: ${record.source}).`,
      });
      continue;
    }

    const effectiveSpec =
      record.source === "npm" ? (params.specOverrides?.[pluginId] ?? record.spec) : record.spec;

    // Resolve ClawHub update spec: id-only updates follow latest line,
    // explicit selectors stay pinned.
    let resolvedClawHubSpec: { installSpec: string; recordSpec: string; modeLabel: string } | null =
      null;
    if (record.source === "clawhub") {
      resolvedClawHubSpec = resolveClawHubUpdateSpec({
        record: { spec: record.spec, clawhubPackage: record.clawhubPackage },
        specOverride: params.specOverrides?.[pluginId],
        invokedByIdOnly: !params.specOverrides?.[pluginId],
      });
    }

    const clawhubInstallSpec = resolvedClawHubSpec?.installSpec;
    const clawhubRecordSpec = resolvedClawHubSpec?.recordSpec ?? record.spec;
    const clawhubModeLabel = resolvedClawHubSpec?.modeLabel ?? "unversioned-clawhub";
    const expectedIntegrity =
      record.source === "npm" && effectiveSpec === record.spec
        ? expectedIntegrityForUpdate(record.spec, record.integrity)
        : undefined;

    if (record.source === "npm" && !effectiveSpec) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (missing npm spec).`,
      });
      continue;
    }

    if (record.source === "clawhub" && !record.clawhubPackage) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (missing ClawHub package metadata).`,
      });
      continue;
    }

    if (
      record.source === "marketplace" &&
      (!record.marketplaceSource || !record.marketplacePlugin)
    ) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (missing marketplace source metadata).`,
      });
      continue;
    }

    let installPath: string;
    try {
      installPath = record.installPath ?? resolvePluginInstallDir(pluginId);
    } catch (err) {
      outcomes.push({
        pluginId,
        status: "error",
        message: `Invalid install path for "${pluginId}": ${String(err)}`,
      });
      continue;
    }
    const currentVersion = await readInstalledPackageVersion(installPath);

    if (params.dryRun) {
      let probe:
        | Awaited<ReturnType<typeof installPluginFromNpmSpec>>
        | Awaited<ReturnType<typeof installPluginFromClawHub>>
        | Awaited<ReturnType<typeof installPluginFromMarketplace>>;
      try {
        probe =
          record.source === "npm"
            ? await installPluginFromNpmSpec({
                spec: effectiveSpec!,
                mode: "update",
                dryRun: true,
                dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                expectedPluginId: pluginId,
                expectedIntegrity,
                onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
                  pluginId,
                  dryRun: true,
                  logger,
                  onIntegrityDrift: params.onIntegrityDrift,
                }),
                logger,
              })
            : record.source === "clawhub"
              ? await installPluginFromClawHub({
                  spec: clawhubInstallSpec ?? effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
                  baseUrl: record.clawhubUrl,
                  mode: "update",
                  dryRun: true,
                  dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                  expectedPluginId: pluginId,
                  logger,
                })
              : await installPluginFromMarketplace({
                  marketplace: record.marketplaceSource!,
                  plugin: record.marketplacePlugin!,
                  mode: "update",
                  dryRun: true,
                  dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                  expectedPluginId: pluginId,
                  logger,
                });
      } catch (err) {
        outcomes.push({
          pluginId,
          status: "error",
          message: `Failed to check ${pluginId}: ${String(err)}`,
        });
        continue;
      }
      if (!probe.ok) {
        outcomes.push({
          pluginId,
          status: "error",
          message:
            record.source === "npm"
              ? formatNpmInstallFailure({
                  pluginId,
                  spec: effectiveSpec!,
                  phase: "check",
                  result: probe,
                })
              : record.source === "clawhub"
                ? formatClawHubInstallFailure({
                    pluginId,
                    spec: clawhubInstallSpec ?? effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
                    phase: "check",
                    error: probe.error,
                  })
                : formatMarketplaceInstallFailure({
                    pluginId,
                    marketplaceSource: record.marketplaceSource!,
                    marketplacePlugin: record.marketplacePlugin!,
                    phase: "check",
                    error: probe.error,
                  }),
        });
        continue;
      }

      const nextVersion = probe.version ?? "unknown";
      const currentLabel = currentVersion ?? "unknown";
      if (currentVersion && probe.version && currentVersion === probe.version) {
        outcomes.push({
          pluginId,
          status: "unchanged",
          currentVersion: currentVersion ?? undefined,
          nextVersion: probe.version ?? undefined,
          message: `${pluginId} is up to date (${currentLabel}).`,
        });
      } else {
        outcomes.push({
          pluginId,
          status: "updated",
          currentVersion: currentVersion ?? undefined,
          nextVersion: probe.version ?? undefined,
          message: `Would update ${pluginId}: ${currentLabel} -> ${nextVersion}.`,
        });
      }
      continue;
    }

    let result:
      | Awaited<ReturnType<typeof installPluginFromNpmSpec>>
      | Awaited<ReturnType<typeof installPluginFromClawHub>>
      | Awaited<ReturnType<typeof installPluginFromMarketplace>>;

    // Phase 3: ClawHub unchanged early skip.
    // Use metadata-only resolver to check if the target version matches the installed version.
    // This avoids downloading the archive when no update is needed.
    if (record.source === "clawhub") {
      try {
        const resolved = await resolveClawHubPluginVersion({
          spec: clawhubInstallSpec ?? effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
          baseUrl: record.clawhubUrl,
          logger,
        });
        if (!resolved.ok) {
          // Metadata resolution failed — report the error directly.
          outcomes.push({
            pluginId,
            status: "error",
            message: formatClawHubInstallFailure({
              pluginId,
              spec: clawhubInstallSpec ?? effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
              phase: "check",
              error: resolved.error,
            }),
          });
          continue;
        }
        if (currentVersion && resolved.version === currentVersion) {
          outcomes.push({
            pluginId,
            status: "unchanged",
            currentVersion: currentVersion ?? undefined,
            nextVersion: resolved.version ?? undefined,
            message: `${pluginId} is up to date (${currentVersion}).`,
          });
          continue;
        }
      } catch {
        // If metadata resolution fails unexpectedly, fall through to the live install
        // which will report the error with full context.
      }
    }

    try {
      result =
        record.source === "npm"
          ? await installPluginFromNpmSpec({
              spec: effectiveSpec!,
              mode: "update",
              dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
              expectedPluginId: pluginId,
              expectedIntegrity,
              onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
                pluginId,
                dryRun: false,
                logger,
                onIntegrityDrift: params.onIntegrityDrift,
              }),
              logger,
            })
          : record.source === "clawhub"
            ? await installPluginFromClawHub({
                spec: clawhubInstallSpec ?? effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
                baseUrl: record.clawhubUrl,
                mode: "update",
                dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                expectedPluginId: pluginId,
                logger,
              })
            : await installPluginFromMarketplace({
                marketplace: record.marketplaceSource!,
                plugin: record.marketplacePlugin!,
                mode: "update",
                dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                expectedPluginId: pluginId,
                logger,
              });
    } catch (err) {
      outcomes.push({
        pluginId,
        status: "error",
        message: `Failed to update ${pluginId}: ${String(err)}`,
      });
      continue;
    }
    if (!result.ok) {
      outcomes.push({
        pluginId,
        status: "error",
        message:
          record.source === "npm"
            ? formatNpmInstallFailure({
                pluginId,
                spec: effectiveSpec!,
                phase: "update",
                result: result,
              })
            : record.source === "clawhub"
              ? formatClawHubInstallFailure({
                  pluginId,
                  spec: clawhubInstallSpec ?? effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
                  phase: "update",
                  error: result.error,
                })
              : formatMarketplaceInstallFailure({
                  pluginId,
                  marketplaceSource: record.marketplaceSource!,
                  marketplacePlugin: record.marketplacePlugin!,
                  phase: "update",
                  error: result.error,
                }),
      });
      continue;
    }

    const resolvedPluginId = result.pluginId;
    if (resolvedPluginId !== pluginId) {
      next = migratePluginConfigId(next, pluginId, resolvedPluginId);
    }

    const nextVersion = result.version ?? (await readInstalledPackageVersion(result.targetDir));
    if (record.source === "npm") {
      next = recordPluginInstall(next, {
        pluginId: resolvedPluginId,
        source: "npm",
        spec: effectiveSpec,
        installPath: result.targetDir,
        version: nextVersion,
        ...buildNpmResolutionInstallFields(result.npmResolution),
      });
    } else if (record.source === "clawhub") {
      const clawhubResult = result as Extract<
        Awaited<ReturnType<typeof installPluginFromClawHub>>,
        { ok: true }
      >;
      // Phase 4: Normalize legacy exact record after successful id-only update.
      // If old record was exact clawhub:<pkg>@<version> and update succeeded via
      // id-only latest-line path, save record spec as unversioned clawhub:<pkg>.
      let savedSpec = clawhubInstallSpec ?? effectiveSpec ?? record.spec ?? `clawhub:${record.clawhubPackage!}`;
      if (
        resolvedClawHubSpec?.modeLabel === "legacy-exact-to-latest" &&
        record.spec !== savedSpec
      ) {
        savedSpec = `clawhub:${record.clawhubPackage!}`;
      }
      next = recordPluginInstall(next, {
        pluginId: resolvedPluginId,
        source: "clawhub",
        spec: savedSpec,
        installPath: result.targetDir,
        version: nextVersion,
        integrity: clawhubResult.clawhub.integrity,
        resolvedAt: clawhubResult.clawhub.resolvedAt,
        clawhubUrl: clawhubResult.clawhub.clawhubUrl,
        clawhubPackage: clawhubResult.clawhub.clawhubPackage,
        clawhubFamily: clawhubResult.clawhub.clawhubFamily,
        clawhubChannel: clawhubResult.clawhub.clawhubChannel,
      });
    } else {
      const marketplaceResult = result as Extract<
        Awaited<ReturnType<typeof installPluginFromMarketplace>>,
        { ok: true }
      >;
      next = recordPluginInstall(next, {
        pluginId: resolvedPluginId,
        source: "marketplace",
        installPath: result.targetDir,
        version: nextVersion,
        marketplaceName: marketplaceResult.marketplaceName ?? record.marketplaceName,
        marketplaceSource: record.marketplaceSource,
        marketplacePlugin: record.marketplacePlugin,
      });
    }
    changed = true;

    const currentLabel = currentVersion ?? "unknown";
    const nextLabel = nextVersion ?? "unknown";
    if (currentVersion && nextVersion && currentVersion === nextVersion) {
      outcomes.push({
        pluginId,
        status: "unchanged",
        currentVersion: currentVersion ?? undefined,
        nextVersion: nextVersion ?? undefined,
        message: `${pluginId} already at ${currentLabel}.`,
      });
    } else {
      outcomes.push({
        pluginId,
        status: "updated",
        currentVersion: currentVersion ?? undefined,
        nextVersion: nextVersion ?? undefined,
        message: `Updated ${pluginId}: ${currentLabel} -> ${nextLabel}.`,
      });
    }
  }

  return { config: next, changed, outcomes };
}

export async function syncPluginsForUpdateChannel(params: {
  config: OpenClawConfig;
  channel: UpdateChannel;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginUpdateLogger;
}): Promise<PluginChannelSyncResult> {
  const env = params.env ?? process.env;
  const summary: PluginChannelSyncSummary = {
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  };
  const bundled = resolveBundledPluginSources({
    workspaceDir: params.workspaceDir,
    env,
  });
  if (bundled.size === 0) {
    return { config: params.config, changed: false, summary };
  }

  let next = params.config;
  const loadHelpers = buildLoadPathHelpers(next.plugins?.load?.paths ?? [], env);
  const installs = next.plugins?.installs ?? {};
  let changed = false;

  if (params.channel === "dev") {
    for (const [pluginId, record] of Object.entries(installs)) {
      const bundledInfo = bundled.get(pluginId);
      if (!bundledInfo) {
        continue;
      }

      loadHelpers.addPath(bundledInfo.localPath);

      const alreadyBundled =
        record.source === "path" && pathsEqual(record.sourcePath, bundledInfo.localPath, env);
      if (alreadyBundled) {
        continue;
      }

      next = recordPluginInstall(next, {
        pluginId,
        source: "path",
        sourcePath: bundledInfo.localPath,
        installPath: bundledInfo.localPath,
        spec: record.spec ?? bundledInfo.npmSpec,
        version: record.version,
      });
      summary.switchedToBundled.push(pluginId);
      changed = true;
    }
  } else {
    for (const [pluginId, record] of Object.entries(installs)) {
      const bundledInfo = bundled.get(pluginId);
      if (!bundledInfo) {
        continue;
      }

      if (record.source === "npm") {
        loadHelpers.removePath(bundledInfo.localPath);
        continue;
      }

      if (record.source !== "path") {
        continue;
      }
      if (!pathsEqual(record.sourcePath, bundledInfo.localPath, env)) {
        continue;
      }
      // Keep explicit bundled installs on release channels. Replacing them with
      // npm installs can reintroduce duplicate-id shadowing and packaging drift.
      loadHelpers.addPath(bundledInfo.localPath);
      const alreadyBundled =
        record.source === "path" &&
        pathsEqual(record.sourcePath, bundledInfo.localPath, env) &&
        pathsEqual(record.installPath, bundledInfo.localPath, env);
      if (alreadyBundled) {
        continue;
      }

      next = recordPluginInstall(next, {
        pluginId,
        source: "path",
        sourcePath: bundledInfo.localPath,
        installPath: bundledInfo.localPath,
        spec: record.spec ?? bundledInfo.npmSpec,
        version: record.version,
      });
      changed = true;
    }
  }

  if (loadHelpers.changed) {
    next = {
      ...next,
      plugins: {
        ...next.plugins,
        load: {
          ...next.plugins?.load,
          paths: loadHelpers.paths,
        },
      },
    };
    changed = true;
  }

  return { config: next, changed, summary };
}

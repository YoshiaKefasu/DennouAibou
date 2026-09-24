import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveSecretInputRef,
  type SecretProviderConfig,
  type SecretRef,
} from "../config/types.secrets.js";
import type { SecretsApplyPlan } from "./plan.js";
import { isRecord } from "./shared.js";
import { discoverConfigSecretTargets } from "./target-registry.js";

export type ConfigureCandidate = {
  type: string;
  path: string;
  pathSegments: string[];
  label: string;
  configFile: "dennou-aibou.json";
  expectedResolvedValue: "string" | "string-or-object";
  existingRef?: SecretRef;
  isDerived?: boolean;
  agentId?: string;
  providerId?: string;
  accountId?: string;
};

export type ConfigureSelectedTarget = ConfigureCandidate & {
  ref: SecretRef;
};

export type ConfigureProviderChanges = {
  upserts: Record<string, SecretProviderConfig>;
  deletes: string[];
};

function getSecretProviders(config: OpenClawConfig): Record<string, SecretProviderConfig> {
  if (!isRecord(config.secrets?.providers)) {
    return {};
  }
  return config.secrets.providers;
}

export function buildConfigureCandidates(config: OpenClawConfig): ConfigureCandidate[] {
  return buildConfigureCandidatesForScope({ config });
}

function configureCandidateSortKey(candidate: ConfigureCandidate): string {
  return `openclaw:${candidate.path}`;
}

export function buildConfigureCandidatesForScope(params: {
  config: OpenClawConfig;
  authoredOpenClawConfig?: OpenClawConfig;
}): ConfigureCandidate[] {
  const authoredConfig = params.authoredOpenClawConfig ?? params.config;

  const hasPathInAuthoredConfig = (pathSegments: string[]): boolean =>
    hasPath(authoredConfig, pathSegments);

  const openclawCandidates = discoverConfigSecretTargets(params.config)
    .filter((entry) => entry.entry.includeInConfigure)
    .map((entry) => {
      const resolved = resolveSecretInputRef({
        value: entry.value,
        refValue: entry.refValue,
        defaults: params.config.secrets?.defaults,
      });
      const pathExists = hasPathInAuthoredConfig(entry.pathSegments);
      const refPathExists = entry.refPathSegments
        ? hasPathInAuthoredConfig(entry.refPathSegments)
        : false;
      return {
        type: entry.entry.targetType,
        path: entry.path,
        pathSegments: [...entry.pathSegments],
        label: entry.path,
        configFile: "dennou-aibou.json" as const,
        expectedResolvedValue: entry.entry.expectedResolvedValue,
        ...(resolved.ref ? { existingRef: resolved.ref } : {}),
        ...(pathExists || refPathExists ? {} : { isDerived: true }),
        ...(entry.providerId ? { providerId: entry.providerId } : {}),
        ...(entry.accountId ? { accountId: entry.accountId } : {}),
      };
    });

  return openclawCandidates.toSorted((a, b) =>
    configureCandidateSortKey(a).localeCompare(configureCandidateSortKey(b)),
  );
}

function hasPath(root: unknown, segments: string[]): boolean {
  if (segments.length === 0) {
    return false;
  }
  let cursor: unknown = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    if (Array.isArray(cursor)) {
      if (!/^\d+$/.test(segment)) {
        return false;
      }
      const parsedIndex = Number.parseInt(segment, 10);
      if (!Number.isFinite(parsedIndex) || parsedIndex < 0 || parsedIndex >= cursor.length) {
        return false;
      }
      if (index === segments.length - 1) {
        return true;
      }
      cursor = cursor[parsedIndex];
      continue;
    }
    if (!isRecord(cursor)) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return false;
    }
    if (index === segments.length - 1) {
      return true;
    }
    cursor = cursor[segment];
  }
  return false;
}

export function collectConfigureProviderChanges(params: {
  original: OpenClawConfig;
  next: OpenClawConfig;
}): ConfigureProviderChanges {
  const originalProviders = getSecretProviders(params.original);
  const nextProviders = getSecretProviders(params.next);

  const upserts: Record<string, SecretProviderConfig> = {};
  const deletes: string[] = [];

  for (const [providerAlias, nextProviderConfig] of Object.entries(nextProviders)) {
    const current = originalProviders[providerAlias];
    if (isDeepStrictEqual(current, nextProviderConfig)) {
      continue;
    }
    upserts[providerAlias] = structuredClone(nextProviderConfig);
  }

  for (const providerAlias of Object.keys(originalProviders)) {
    if (!Object.prototype.hasOwnProperty.call(nextProviders, providerAlias)) {
      deletes.push(providerAlias);
    }
  }

  return {
    upserts,
    deletes: deletes.toSorted(),
  };
}

export function hasConfigurePlanChanges(params: {
  selectedTargets: ReadonlyMap<string, ConfigureSelectedTarget>;
  providerChanges: ConfigureProviderChanges;
}): boolean {
  return (
    params.selectedTargets.size > 0 ||
    Object.keys(params.providerChanges.upserts).length > 0 ||
    params.providerChanges.deletes.length > 0
  );
}

export function buildSecretsConfigurePlan(params: {
  selectedTargets: ReadonlyMap<string, ConfigureSelectedTarget>;
  providerChanges: ConfigureProviderChanges;
  generatedAt?: string;
}): SecretsApplyPlan {
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    generatedBy: "openclaw secrets configure",
    targets: [...params.selectedTargets.values()].map((entry) => ({
      type: entry.type,
      path: entry.path,
      pathSegments: [...entry.pathSegments],
      ref: entry.ref,
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
      ...(entry.providerId ? { providerId: entry.providerId } : {}),
      ...(entry.accountId ? { accountId: entry.accountId } : {}),
    })),
    ...(Object.keys(params.providerChanges.upserts).length > 0
      ? { providerUpserts: params.providerChanges.upserts }
      : {}),
    ...(params.providerChanges.deletes.length > 0
      ? { providerDeletes: params.providerChanges.deletes }
      : {}),
    options: {
      scrubEnv: true,
      scrubLegacyAuthJson: true,
    },
  };
}

import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveDiscordPreviewStreamMode } from "./preview-streaming.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeDiscordDmAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  let changed = false;
  let updated: Record<string, unknown> = params.entry;
  const rawDm = updated.dm;
  const dm = asObjectRecord(rawDm) ? (structuredClone(rawDm) as Record<string, unknown>) : null;
  let dmChanged = false;
  const shouldPromoteLegacyAllowFrom = !(
    params.pathPrefix === "channels.discord" && asObjectRecord(updated.accounts)
  );

  const allowFromEqual = (a: unknown, b: unknown): boolean => {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return false;
    }
    const na = a.map((v) => String(v).trim()).filter(Boolean);
    const nb = b.map((v) => String(v).trim()).filter(Boolean);
    if (na.length !== nb.length) {
      return false;
    }
    return na.every((v, i) => v === nb[i]);
  };

  const topDmPolicy = updated.dmPolicy;
  const legacyDmPolicy = dm?.policy;
  if (topDmPolicy === undefined && legacyDmPolicy !== undefined) {
    updated = { ...updated, dmPolicy: legacyDmPolicy };
    changed = true;
    if (dm) {
      delete dm.policy;
      dmChanged = true;
    }
    params.changes.push(`Moved ${params.pathPrefix}.dm.policy → ${params.pathPrefix}.dmPolicy.`);
  } else if (
    topDmPolicy !== undefined &&
    legacyDmPolicy !== undefined &&
    topDmPolicy === legacyDmPolicy
  ) {
    if (dm) {
      delete dm.policy;
      dmChanged = true;
      params.changes.push(`Removed ${params.pathPrefix}.dm.policy (dmPolicy already set).`);
    }
  }

  const topAllowFrom = updated.allowFrom;
  const legacyAllowFrom = dm?.allowFrom;
  if (shouldPromoteLegacyAllowFrom) {
    if (topAllowFrom === undefined && legacyAllowFrom !== undefined) {
      updated = { ...updated, allowFrom: legacyAllowFrom };
      changed = true;
      if (dm) {
        delete dm.allowFrom;
        dmChanged = true;
      }
      params.changes.push(
        `Moved ${params.pathPrefix}.dm.allowFrom → ${params.pathPrefix}.allowFrom.`,
      );
    } else if (
      topAllowFrom !== undefined &&
      legacyAllowFrom !== undefined &&
      allowFromEqual(topAllowFrom, legacyAllowFrom)
    ) {
      if (dm) {
        delete dm.allowFrom;
        dmChanged = true;
        params.changes.push(`Removed ${params.pathPrefix}.dm.allowFrom (allowFrom already set).`);
      }
    }
  }

  if (dm && asObjectRecord(rawDm) && dmChanged) {
    const keys = Object.keys(dm);
    if (keys.length === 0) {
      if (updated.dm !== undefined) {
        const { dm: _ignored, ...rest } = updated;
        updated = rest;
        changed = true;
        params.changes.push(`Removed empty ${params.pathPrefix}.dm after migration.`);
      }
    } else {
      updated = { ...updated, dm };
      changed = true;
    }
  }

  return { entry: updated, changed };
}

function normalizeDiscordStreamingAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  let updated = params.entry;
  const hadLegacyStreamMode = updated.streamMode !== undefined;
  const beforeStreaming = updated.streaming;
  const resolved = resolveDiscordPreviewStreamMode(updated);
  const shouldNormalize =
    hadLegacyStreamMode ||
    typeof beforeStreaming === "boolean" ||
    (typeof beforeStreaming === "string" && beforeStreaming !== resolved);
  if (!shouldNormalize) {
    return { entry: updated, changed: false };
  }

  let changed = false;
  if (beforeStreaming !== resolved) {
    updated = { ...updated, streaming: resolved };
    changed = true;
  }
  if (hadLegacyStreamMode) {
    const { streamMode: _ignored, ...rest } = updated;
    updated = rest;
    changed = true;
    params.changes.push(
      `Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming (${resolved}).`,
    );
  }
  if (typeof beforeStreaming === "boolean") {
    params.changes.push(`Normalized ${params.pathPrefix}.streaming boolean → enum (${resolved}).`);
  } else if (typeof beforeStreaming === "string" && beforeStreaming !== resolved) {
    params.changes.push(
      `Normalized ${params.pathPrefix}.streaming (${beforeStreaming}) → (${resolved}).`,
    );
  }
  if (
    params.pathPrefix.startsWith("channels.discord") &&
    resolved === "off" &&
    hadLegacyStreamMode
  ) {
    params.changes.push(
      `${params.pathPrefix}.streaming remains off by default to avoid Discord preview-edit rate limits; set ${params.pathPrefix}.streaming="partial" to opt in explicitly.`,
    );
  }
  return { entry: updated, changed };
}

function hasLegacyDiscordStreamingAliases(value: unknown): boolean {
  const entry = asObjectRecord(value);
  if (!entry) {
    return false;
  }
  return (
    entry.streamMode !== undefined ||
    typeof entry.streaming === "boolean" ||
    (typeof entry.streaming === "string" &&
      entry.streaming !== resolveDiscordPreviewStreamMode(entry))
  );
}

function hasLegacyDiscordAccountStreamingAliases(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => hasLegacyDiscordStreamingAliases(account));
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "discord"],
    message:
      "channels.discord.streamMode and boolean channels.discord.streaming are legacy; use channels.discord.streaming.",
    match: hasLegacyDiscordStreamingAliases,
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      "channels.discord.accounts.<id>.streamMode and boolean channels.discord.accounts.<id>.streaming are legacy; use channels.discord.accounts.<id>.streaming.",
    match: hasLegacyDiscordAccountStreamingAliases,
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.discord);
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed = false;

  const dm = normalizeDiscordDmAliases({
    entry: updated,
    pathPrefix: "channels.discord",
    changes,
  });
  updated = dm.entry;
  changed = changed || dm.changed;

  const streaming = normalizeDiscordStreamingAliases({
    entry: updated,
    pathPrefix: "channels.discord",
    changes,
  });
  updated = streaming.entry;
  changed = changed || streaming.changed;

  const rawAccounts = asObjectRecord(updated.accounts);
  if (rawAccounts) {
    let accountsChanged = false;
    const accounts = { ...rawAccounts };
    for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
      const account = asObjectRecord(rawAccount);
      if (!account) {
        continue;
      }
      let accountEntry = account;
      let accountChanged = false;
      const accountDm = normalizeDiscordDmAliases({
        entry: accountEntry,
        pathPrefix: `channels.discord.accounts.${accountId}`,
        changes,
      });
      accountEntry = accountDm.entry;
      accountChanged = accountDm.changed;
      const accountStreaming = normalizeDiscordStreamingAliases({
        entry: accountEntry,
        pathPrefix: `channels.discord.accounts.${accountId}`,
        changes,
      });
      accountEntry = accountStreaming.entry;
      accountChanged = accountChanged || accountStreaming.changed;
      if (accountChanged) {
        accounts[accountId] = accountEntry;
        accountsChanged = true;
      }
    }
    if (accountsChanged) {
      updated = { ...updated, accounts };
      changed = true;
    }
  }

  if (!changed) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        discord: updated,
      } as OpenClawConfig["channels"],
    },
    changes,
  };
}

import type { OpenClawConfig } from "../../../src/config/config.js";

export const DEFAULT_IMESSAGE_ATTACHMENT_ROOTS = [
  "/Users/*/Library/Messages/Attachments",
] as const;

interface ImessageAccountConfig {
  attachmentRoots?: string[];
  remoteAttachmentRoots?: string[];
}

function resolveIMessageAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ImessageAccountConfig {
  const imessageCfg = params.cfg.channels?.imessage as
    | {
        accounts?: Record<string, ImessageAccountConfig>;
      }
    | undefined;
  if (!imessageCfg?.accounts || !params.accountId) {
    // Divergence from original (ab318de8b75 media-contract.ts): the original fell
    // back to the default account's config when accountId was omitted. This test
    // helper intentionally skips that fallback — callers in this suite always
    // pass an explicit accountId.
    return {};
  }
  const normalizedTarget = params.accountId.toLowerCase();
  for (const [key, value] of Object.entries(imessageCfg.accounts)) {
    if (key.toLowerCase() === normalizedTarget && value && typeof value === "object") {
      return value;
    }
  }
  return {};
}

function mergeInboundPathRoots(
  ...arrays: (string[] | undefined)[]
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const arr of arrays) {
    if (!arr) continue;
    for (const item of arr) {
      if (!seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
  }
  return result;
}

export function resolveIMessageAttachmentRoots(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): string[] {
  const account = resolveIMessageAccountConfig(params);
  const channelRoots = (params.cfg.channels?.imessage as { attachmentRoots?: string[] } | undefined)
    ?.attachmentRoots;
  return mergeInboundPathRoots(
    account.attachmentRoots,
    channelRoots,
    [...DEFAULT_IMESSAGE_ATTACHMENT_ROOTS],
  );
}

export function resolveIMessageRemoteAttachmentRoots(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): string[] {
  const account = resolveIMessageAccountConfig(params);
  const channelCfg = params.cfg.channels?.imessage as
    | { attachmentRoots?: string[]; remoteAttachmentRoots?: string[] }
    | undefined;
  return mergeInboundPathRoots(
    account.remoteAttachmentRoots,
    channelCfg?.remoteAttachmentRoots,
    account.attachmentRoots,
    channelCfg?.attachmentRoots,
    [...DEFAULT_IMESSAGE_ATTACHMENT_ROOTS],
  );
}

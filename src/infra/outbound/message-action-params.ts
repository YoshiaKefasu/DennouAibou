import { assertMediaNotDataUrl } from "../../agents/path-policy.js";
import { readStringParam } from "../../agents/tools/common.js";
import type { ChannelId, ChannelMessageActionName } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { basenameFromMediaSource } from "../../infra/local-file-access.js";
import {
  buildOutboundMediaLoadOptions,
  resolveOutboundMediaAccess,
  type OutboundMediaAccess,
  type OutboundMediaReadFile,
} from "../../media/load-options.js";
import { extensionForMime } from "../../media/mime.js";
import { loadWebMedia } from "../../media/web-media.js";
import { readBooleanParam as readBooleanParamShared } from "../../plugin-sdk/boolean-param.js";

export type MessageActionParamsDeps = {
  loadWebMedia: typeof loadWebMedia;
};

export const readBooleanParam = readBooleanParamShared;

const MEDIA_PARAM_KEYS = ["media", "path", "filePath", "mediaUrl", "fileUrl"] as const;

function readMediaParam(
  args: Record<string, unknown>,
  key: (typeof MEDIA_PARAM_KEYS)[number],
): string | undefined {
  return readStringParam(args, key, { trim: false });
}

function readAttachmentMediaHint(args: Record<string, unknown>): string | undefined {
  return readMediaParam(args, "media") ?? readMediaParam(args, "mediaUrl");
}

function readAttachmentFileHint(args: Record<string, unknown>): string | undefined {
  return (
    readMediaParam(args, "path") ??
    readMediaParam(args, "filePath") ??
    readMediaParam(args, "fileUrl")
  );
}

function resolveAttachmentMaxBytes(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
}): number | undefined {
  const accountId = typeof params.accountId === "string" ? params.accountId.trim() : "";
  const channelCfg = params.cfg.channels?.[params.channel];
  const channelObj =
    channelCfg && typeof channelCfg === "object"
      ? (channelCfg as Record<string, unknown>)
      : undefined;
  const channelMediaMax =
    typeof channelObj?.mediaMaxMb === "number" ? channelObj.mediaMaxMb : undefined;
  const accountsObj =
    channelObj?.accounts && typeof channelObj.accounts === "object"
      ? (channelObj.accounts as Record<string, unknown>)
      : undefined;
  const accountCfg = accountId && accountsObj ? accountsObj[accountId] : undefined;
  const accountMediaMax =
    accountCfg && typeof accountCfg === "object"
      ? (accountCfg as Record<string, unknown>).mediaMaxMb
      : undefined;
  // Priority: account-specific > channel-level > global default
  const limitMb =
    (typeof accountMediaMax === "number" ? accountMediaMax : undefined) ??
    channelMediaMax ??
    params.cfg.agents?.defaults?.mediaMaxMb;
  return typeof limitMb === "number" ? limitMb * 1024 * 1024 : undefined;
}

function inferAttachmentFilename(params: {
  mediaHint?: string;
  contentType?: string;
}): string | undefined {
  const mediaHint = params.mediaHint?.trim();
  if (mediaHint) {
    const base = basenameFromMediaSource(mediaHint);
    if (base) {
      return base;
    }
  }
  const ext = params.contentType ? extensionForMime(params.contentType) : undefined;
  return ext ? `attachment${ext}` : "attachment";
}

function normalizeBase64Payload(params: { base64?: string; contentType?: string }): {
  base64?: string;
  contentType?: string;
} {
  if (!params.base64) {
    return { base64: params.base64, contentType: params.contentType };
  }
  const match = /^data:([^;]+);base64,(.*)$/i.exec(params.base64.trim());
  if (!match) {
    return { base64: params.base64, contentType: params.contentType };
  }
  const [, mime, payload] = match;
  return {
    base64: payload,
    contentType: params.contentType ?? mime,
  };
}

export type AttachmentMediaPolicy = {
  mediaAccess?: OutboundMediaAccess;
};

export function resolveAttachmentMediaPolicy(params: {
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: OutboundMediaReadFile;
}): AttachmentMediaPolicy {
  return {
    mediaAccess: resolveOutboundMediaAccess({
      mediaAccess: params.mediaAccess,
      mediaLocalRoots: params.mediaLocalRoots,
      mediaReadFile: params.mediaReadFile,
    }),
  };
}

function buildAttachmentMediaLoadOptions(params: {
  policy: AttachmentMediaPolicy;
  maxBytes?: number;
}): {
  maxBytes?: number;
  localRoots?: readonly string[] | "any";
  readFile?: OutboundMediaReadFile;
  hostReadCapability?: boolean;
} {
  return buildOutboundMediaLoadOptions({
    maxBytes: params.maxBytes,
    mediaAccess: params.policy.mediaAccess,
  });
}

async function hydrateAttachmentPayload(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  args: Record<string, unknown>;
  dryRun?: boolean;
  contentTypeParam?: string | null;
  mediaHint?: string | null;
  fileHint?: string | null;
  mediaPolicy: AttachmentMediaPolicy;
  deps?: MessageActionParamsDeps;
}) {
  const contentTypeParam = params.contentTypeParam ?? undefined;
  const rawBuffer = readStringParam(params.args, "buffer", { trim: false });
  const normalized = normalizeBase64Payload({
    base64: rawBuffer,
    contentType: contentTypeParam ?? undefined,
  });
  if (normalized.base64 !== rawBuffer && normalized.base64) {
    params.args.buffer = normalized.base64;
    if (normalized.contentType && !contentTypeParam) {
      params.args.contentType = normalized.contentType;
    }
  }

  const filename = readStringParam(params.args, "filename");
  const mediaSource = (params.mediaHint ?? undefined) || (params.fileHint ?? undefined);

  if (!params.dryRun && !readStringParam(params.args, "buffer", { trim: false }) && mediaSource) {
    const maxBytes = resolveAttachmentMaxBytes({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
    });
    const loadWebMediaFn = params.deps?.loadWebMedia ?? loadWebMedia;
    const media = await loadWebMediaFn(
      mediaSource,
      buildAttachmentMediaLoadOptions({ policy: params.mediaPolicy, maxBytes }),
    );
    params.args.buffer = media.buffer.toString("base64");
    if (!contentTypeParam && media.contentType) {
      params.args.contentType = media.contentType;
    }
    if (!filename) {
      params.args.filename = inferAttachmentFilename({
        mediaHint: media.fileName ?? mediaSource,
        contentType: media.contentType ?? contentTypeParam ?? undefined,
      });
    }
  } else if (!filename) {
    params.args.filename = inferAttachmentFilename({
      mediaHint: mediaSource,
      contentType: contentTypeParam ?? undefined,
    });
  }
}

export async function normalizeAttachmentMediaParams(params: {
  args: Record<string, unknown>;
}): Promise<void> {
  for (const key of MEDIA_PARAM_KEYS) {
    const raw = readMediaParam(params.args, key);
    if (!raw) {
      continue;
    }
    assertMediaNotDataUrl(raw);
  }
}

export async function normalizeMediaList(params: { values: string[] }): Promise<string[]> {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of params.values) {
    const raw = value?.trim();
    if (!raw) {
      continue;
    }
    assertMediaNotDataUrl(raw);
    if (seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    normalized.push(raw);
  }
  return normalized;
}

async function hydrateAttachmentActionPayload(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  args: Record<string, unknown>;
  dryRun?: boolean;
  /** If caption is missing, copy message -> caption. */
  allowMessageCaptionFallback?: boolean;
  mediaPolicy: AttachmentMediaPolicy;
  deps?: MessageActionParamsDeps;
}): Promise<void> {
  const mediaHint = readAttachmentMediaHint(params.args);
  const fileHint = readAttachmentFileHint(params.args);
  const contentTypeParam =
    readStringParam(params.args, "contentType") ?? readStringParam(params.args, "mimeType");

  if (params.allowMessageCaptionFallback) {
    const caption = readStringParam(params.args, "caption", { allowEmpty: true })?.trim();
    const message = readStringParam(params.args, "message", { allowEmpty: true })?.trim();
    if (!caption && message) {
      params.args.caption = message;
    }
  }

  await hydrateAttachmentPayload({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    args: params.args,
    dryRun: params.dryRun,
    contentTypeParam,
    mediaHint,
    fileHint,
    mediaPolicy: params.mediaPolicy,
    deps: params.deps,
  });
}

export async function hydrateAttachmentParamsForAction(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  args: Record<string, unknown>;
  action: ChannelMessageActionName;
  dryRun?: boolean;
  mediaPolicy: AttachmentMediaPolicy;
  deps?: MessageActionParamsDeps;
}): Promise<void> {
  const shouldHydrateUploadFile = params.action === "upload-file";
  if (
    params.action !== "sendAttachment" &&
    params.action !== "setGroupIcon" &&
    !shouldHydrateUploadFile
  ) {
    return;
  }
  await hydrateAttachmentActionPayload({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    args: params.args,
    dryRun: params.dryRun,
    mediaPolicy: params.mediaPolicy,
    deps: params.deps,
    allowMessageCaptionFallback: params.action === "sendAttachment" || shouldHydrateUploadFile,
  });
}

export function parseButtonsParam(params: Record<string, unknown>): void {
  const raw = params.buttons;
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.buttons;
    return;
  }
  try {
    params.buttons = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--buttons must be valid JSON");
  }
}

export function parseCardParam(params: Record<string, unknown>): void {
  const raw = params.card;
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.card;
    return;
  }
  try {
    params.card = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--card must be valid JSON");
  }
}

export function parseComponentsParam(params: Record<string, unknown>): void {
  const raw = params.components;
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.components;
    return;
  }
  try {
    params.components = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--components must be valid JSON");
  }
}

export function parseInteractiveParam(params: Record<string, unknown>): void {
  const raw = params.interactive;
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.interactive;
    return;
  }
  try {
    params.interactive = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--interactive must be valid JSON");
  }
}

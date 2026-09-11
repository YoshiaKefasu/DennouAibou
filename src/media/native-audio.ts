import { loadWebMediaRaw } from "./web-media.js";
import fs from "node:fs/promises";
import path from "node:path";
import { isInboundPathAllowed, mergeInboundPathRoots } from "./inbound-path-policy.js";
import { isAudioFileName } from "./mime.js";
import { getDefaultMediaLocalRoots } from "./local-roots.js";

export const MAX_NATIVE_AUDIO_BYTES = 10 * 1024 * 1024;

export type NativeAudioAttachment = {
  path: string;
  mimeType?: string;
};

export type NativeAudioContentBlock = {
  type: "audio";
  data: string;
  mimeType: string;
};

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

export function resolveNativeAudioMimeType(params: {
  mimeType?: string;
  path: string;
}): string | undefined {
  const mime = params.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime?.startsWith("audio/")) {
    return mime;
  }
  const extension = params.path.slice(params.path.lastIndexOf(".")).toLowerCase();
  return AUDIO_MIME_BY_EXTENSION[extension] ?? (isAudioFileName(params.path) ? mime : undefined);
}

export function isNativeAudioAttachment(params: {
  path?: string;
  mimeType?: string;
}): boolean {
  if (!params.path?.trim()) {
    return false;
  }
  return Boolean(
    resolveNativeAudioMimeType({ path: params.path, mimeType: params.mimeType }),
  );
}

export function selectNativeAudioAttachments(params: {
  paths?: readonly string[];
  types?: readonly string[];
  fallbackType?: string;
}): NativeAudioAttachment[] {
  const paths = params.paths ?? [];
  return paths.flatMap((rawPath, index) => {
    const path = rawPath?.trim();
    if (!path) {
      return [];
    }
    const mimeType = params.types?.[index] ?? (paths.length === 1 ? params.fallbackType : undefined);
    return isNativeAudioAttachment({ path, mimeType }) ? [{ path, mimeType }] : [];
  });
}

export async function hasInlineableNativeAudio(params: {
  paths?: readonly string[];
  types?: readonly string[];
  fallbackType?: string;
  workspaceDir?: string;
  localRoots?: readonly string[];
}): Promise<boolean> {
  const roots = mergeInboundPathRoots(params.localRoots, getDefaultMediaLocalRoots());
  const attachments = selectNativeAudioAttachments(params);
  if (attachments.length === 0) {
    return false;
  }
  for (const attachment of attachments) {
    try {
      const candidate = path.isAbsolute(attachment.path)
        ? attachment.path
        : path.resolve(params.workspaceDir ?? process.cwd(), attachment.path);
      const canonical = await fs.realpath(candidate);
      if (!isInboundPathAllowed({ filePath: canonical, roots })) {
        continue;
      }
      const stat = await fs.stat(canonical);
      if (stat.isFile() && stat.size <= MAX_NATIVE_AUDIO_BYTES) {
        return true;
      }
    } catch {
      // Let media-understanding handle inaccessible or remote-only attachments.
    }
  }
  return false;
}

export async function loadNativeAudioBlocks(params: {
  paths?: readonly string[];
  types?: readonly string[];
  fallbackType?: string;
  workspaceDir?: string;
  localRoots?: readonly string[];
}): Promise<NativeAudioContentBlock[]> {
  const attachments = selectNativeAudioAttachments(params);
  const blocks: NativeAudioContentBlock[] = [];
  for (const attachment of attachments) {
    try {
      const media = await loadWebMediaRaw(attachment.path, {
        maxBytes: MAX_NATIVE_AUDIO_BYTES,
        optimizeImages: false,
        localRoots: params.localRoots,
        workspaceDir: params.workspaceDir,
      });
      if (media.kind !== "audio" || media.buffer.length > MAX_NATIVE_AUDIO_BYTES) {
        continue;
      }
      const mimeType = resolveNativeAudioMimeType({
        path: attachment.path,
        mimeType: media.contentType ?? attachment.mimeType,
      });
      if (!mimeType) {
        continue;
      }
      blocks.push({
        type: "audio",
        data: media.buffer.toString("base64"),
        mimeType,
      });
    } catch {
      // Native audio is opportunistic. A failed or oversized attachment falls
      // back to the normal media-understanding path without failing the turn.
    }
  }
  return blocks;
}

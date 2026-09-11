import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getDefaultMediaLocalRoots } from "../../../media/local-roots.js";
import {
  loadNativeAudioBlocks,
  type NativeAudioContentBlock,
} from "../../../media/native-audio.js";
import { mergeInboundPathRoots } from "../../../media/inbound-path-policy.js";

export async function resolveNativeAudioBlocks(params: {
  paths?: readonly string[];
  types?: readonly string[];
  fallbackType?: string;
  workspaceDir: string;
}): Promise<NativeAudioContentBlock[]> {
  return await loadNativeAudioBlocks({
    paths: params.paths,
    types: params.types,
    fallbackType: params.fallbackType,
    workspaceDir: params.workspaceDir,
    localRoots: mergeInboundPathRoots(getDefaultMediaLocalRoots(), [params.workspaceDir]),
  });
}

function parseAudioDataUrl(url: string): { data: string; format: string } | undefined {
  const match = /^data:(audio\/[^;,]+)(?:;[^,]*)?;base64,(.+)$/i.exec(url);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const format = match[1].slice("audio/".length).toLowerCase();
  return {
    data: match[2],
    format: format === "mpeg" ? "mp3" : format === "x-m4a" ? "m4a" : format,
  };
}

function rewriteAudioContentPart(part: unknown): unknown {
  if (!part || typeof part !== "object") {
    return part;
  }
  const record = part as Record<string, unknown>;
  const imageUrl = record.image_url;
  if (
    (record.type === "image_url" || record.type === "input_image") &&
    imageUrl &&
    typeof imageUrl === "object"
  ) {
    const url = (imageUrl as { url?: unknown }).url;
    if (typeof url === "string") {
      const audio = parseAudioDataUrl(url);
      if (audio) {
        return {
          type: "input_audio",
          input_audio: audio,
        };
      }
    }
  }
  return part;
}

function rewriteAudioPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  const rewriteMessages = (value: unknown): unknown => {
    if (!Array.isArray(value)) {
      return value;
    }
    return value.map((message) => {
      if (!message || typeof message !== "object") {
        return message;
      }
      const next = { ...(message as Record<string, unknown>) };
      if (Array.isArray(next.content)) {
        next.content = next.content.map(rewriteAudioContentPart);
      }
      return next;
    });
  };
  const next = { ...record };
  if (Array.isArray(record.messages)) {
    next.messages = rewriteMessages(record.messages);
  }
  if (Array.isArray(record.input)) {
    next.input = rewriteMessages(record.input);
  }
  return next;
}

function injectAudioIntoContext(
  context: Context,
  blocks: readonly NativeAudioContentBlock[],
): Context {
  if (blocks.length === 0) {
    return context;
  }
  const messages = [...context.messages];
  const userIndex = messages.findLastIndex((message) => message.role === "user");
  if (userIndex < 0) {
    return context;
  }
  const message = messages[userIndex];
  if (message.role !== "user") {
    return context;
  }
  const content = Array.isArray(message.content)
    ? [...message.content]
    : [{ type: "text" as const, text: message.content }];
  if (content.some((part) => (part as { type?: unknown }).type === "audio")) {
    return context;
  }
  content.push(...(blocks as never[]));
  messages[userIndex] = { ...message, content } as typeof message;
  return { ...context, messages };
}

export function createNativeAudioStreamFn(
  inner: StreamFn,
  blocks: readonly NativeAudioContentBlock[],
): StreamFn {
  if (blocks.length === 0) {
    return inner;
  }
  return (model, context, options?: SimpleStreamOptions) => {
    const nextContext = injectAudioIntoContext(context, blocks);
    const previousOnPayload = options?.onPayload;
    const nextOptions = {
      ...options,
      onPayload: async (payload: unknown, payloadModel: typeof model) => {
        const rewritten = rewriteAudioPayload(payload);
        return previousOnPayload
          ? await previousOnPayload(rewritten, payloadModel)
          : rewritten;
      },
    } satisfies SimpleStreamOptions;
    return inner(model, nextContext, nextOptions);
  };
}

export const __testing = {
  parseAudioDataUrl,
  rewriteAudioPayload,
};

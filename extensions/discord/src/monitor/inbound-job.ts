import { isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import { isAbortRequestText } from "openclaw/plugin-sdk/reply-runtime";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";

type DiscordInboundJobRuntimeField =
  | "runtime"
  | "abortSignal"
  | "guildHistories"
  | "client"
  | "threadBindings"
  | "discordRestFetch";

export type DiscordInboundJobRuntime = Pick<
  DiscordMessagePreflightContext,
  DiscordInboundJobRuntimeField
>;

export type DiscordInboundJobPayload = Omit<
  DiscordMessagePreflightContext,
  DiscordInboundJobRuntimeField
>;

export type DiscordInboundJob = {
  queueKey: string;
  payload: DiscordInboundJobPayload;
  runtime: DiscordInboundJobRuntime;
};

export function resolveDiscordInboundJobQueueKey(ctx: DiscordMessagePreflightContext): string {
  const sessionKey = ctx.route.sessionKey?.trim();
  const base = sessionKey || ctx.baseSessionKey?.trim() || ctx.messageChannelId;
  // Control commands (/stop etc.) run on a dedicated `:control` lane so they
  // dispatch concurrently instead of queueing behind a running agent run.
  // Same pattern as Telegram's sequential-key.ts abort → `:control` split:
  // KeyedAsyncQueue serializes per key, so a suffixed key never blocks on
  // the normal lane's tail. Without this, /stop deadlocks — it only runs
  // after the run it is supposed to interrupt.
  const text = ctx.baseText?.trim() || ctx.messageText?.trim() || "";
  if (text && isDiscordInboundControlText(text, ctx.cfg)) {
    return `${base}:control`;
  }
  return base;
}

export function isDiscordInboundControlText(
  text: string | undefined,
  cfg: DiscordMessagePreflightContext["cfg"],
): boolean {
  if (!text?.trim()) {
    return false;
  }
  return isControlCommandMessage(text, cfg) || isAbortRequestText(text);
}

export function buildDiscordInboundJob(ctx: DiscordMessagePreflightContext): DiscordInboundJob {
  const {
    runtime,
    abortSignal,
    guildHistories,
    client,
    threadBindings,
    discordRestFetch,
    message,
    data,
    threadChannel,
    ...payload
  } = ctx;

  const sanitizedMessage = sanitizeDiscordInboundMessage(message);
  return {
    queueKey: resolveDiscordInboundJobQueueKey(ctx),
    payload: {
      ...payload,
      message: sanitizedMessage,
      data: {
        ...data,
        message: sanitizedMessage,
      },
      threadChannel: normalizeDiscordThreadChannel(threadChannel),
    },
    runtime: {
      runtime,
      abortSignal,
      guildHistories,
      client,
      threadBindings,
      discordRestFetch,
    },
  };
}

export function materializeDiscordInboundJob(
  job: DiscordInboundJob,
  abortSignal?: AbortSignal,
): DiscordMessagePreflightContext {
  return {
    ...job.payload,
    ...job.runtime,
    abortSignal: abortSignal ?? job.runtime.abortSignal,
  };
}

function sanitizeDiscordInboundMessage<T extends object>(message: T): T {
  const descriptors = Object.getOwnPropertyDescriptors(message);
  delete descriptors.channel;
  return Object.create(Object.getPrototypeOf(message), descriptors) as T;
}

function normalizeDiscordThreadChannel(
  threadChannel: DiscordMessagePreflightContext["threadChannel"],
): DiscordMessagePreflightContext["threadChannel"] {
  if (!threadChannel) {
    return null;
  }
  return {
    id: threadChannel.id,
    name: threadChannel.name,
    parentId: threadChannel.parentId,
    parent: threadChannel.parent
      ? {
          id: threadChannel.parent.id,
          name: threadChannel.parent.name,
        }
      : undefined,
    ownerId: threadChannel.ownerId,
  };
}

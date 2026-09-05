import type { GuildMember, User } from "@buape/carbon";
import type { APIInteractionGuildMember } from "discord-api-types/v10";
import type { PluralKitMessageInfo } from "../pluralkit.js";
import { formatDiscordUserTag } from "./format.js";

export type DiscordSenderIdentity = {
  id: string;
  name?: string;
  tag?: string;
  label: string;
  isPluralKit: boolean;
  pluralkit?: {
    memberId: string;
    memberName?: string;
    systemId?: string;
    systemName?: string;
  };
};

type DiscordWebhookMessageLike = {
  webhookId?: string | null;
  webhook_id?: string | null;
};

/**
 * Anything that exposes a guild-member nickname. In practice this is either
 * the Carbon `GuildMember` instance or the raw `APIInteractionGuildMember`
 * (which exposes the same nickname via `.nick`). Centralised here so
 * callers can pass either without falling back to `any`.
 */
type DiscordSenderMemberLike = GuildMember<false, true> | APIInteractionGuildMember;

function resolveMemberNickname(
  member: DiscordSenderMemberLike | undefined,
): string | null | undefined {
  if (!member) {
    return undefined;
  }
  // Carbon GuildMember exposes `nickname`; APIInteractionGuildMember exposes `nick`.
  const nickname = (member as { nickname?: string | null }).nickname;
  if (nickname !== undefined) {
    return nickname;
  }
  return (member as { nick?: string | null }).nick ?? undefined;
}

export function resolveDiscordWebhookId(message: DiscordWebhookMessageLike): string | null {
  const candidate = message.webhookId ?? message.webhook_id;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

export function resolveDiscordSenderIdentity(params: {
  author: User;
  member?: DiscordSenderMemberLike;
  pluralkitInfo?: PluralKitMessageInfo | null;
}): DiscordSenderIdentity {
  const pkInfo = params.pluralkitInfo ?? null;
  const pkMember = pkInfo?.member ?? undefined;
  const pkSystem = pkInfo?.system ?? undefined;
  const memberId = pkMember?.id?.trim();
  const memberNameRaw = pkMember?.display_name ?? pkMember?.name ?? "";
  const memberName = memberNameRaw?.trim();
  if (memberId && memberName) {
    const systemName = pkSystem?.name?.trim();
    const label = systemName ? `${memberName} (PK:${systemName})` : `${memberName} (PK)`;
    return {
      id: memberId,
      name: memberName,
      tag: pkMember?.name?.trim() || undefined,
      label,
      isPluralKit: true,
      pluralkit: {
        memberId,
        memberName,
        systemId: pkSystem?.id?.trim() || undefined,
        systemName,
      },
    };
  }

  const senderTag = formatDiscordUserTag(params.author);
  const memberNickname = resolveMemberNickname(params.member);
  const senderDisplay = memberNickname ?? params.author.globalName ?? params.author.username;
  const senderLabel =
    senderDisplay && senderTag && senderDisplay !== senderTag
      ? `${senderDisplay} (${senderTag})`
      : (senderDisplay ?? senderTag ?? params.author.id);
  return {
    id: params.author.id,
    name: params.author.username ?? undefined,
    tag: senderTag,
    label: senderLabel,
    isPluralKit: false,
  };
}

export function resolveDiscordSenderLabel(params: {
  author: User;
  member?: DiscordSenderMemberLike;
  pluralkitInfo?: PluralKitMessageInfo | null;
}): string {
  return resolveDiscordSenderIdentity(params).label;
}

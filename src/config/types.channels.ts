import type { ContextVisibilityMode, GroupPolicy } from "./types.base.js";

export type ChannelHeartbeatVisibilityConfig = {
  /** Show HEARTBEAT_OK acknowledgments in chat (default: false). */
  showOk?: boolean;
  /** Show heartbeat alerts with actual content (default: true). */
  showAlerts?: boolean;
  /** Emit indicator events for UI status display (default: true). */
  useIndicator?: boolean;
};

export type ChannelHealthMonitorConfig = {
  /**
   * Enable channel-health-monitor restarts for this channel or account.
   * Inherits the global gateway setting when omitted.
   */
  enabled?: boolean;
};

export type ChannelDefaultsConfig = {
  groupPolicy?: GroupPolicy;
  contextVisibility?: ContextVisibilityMode;
  /** Default heartbeat visibility for all channels. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

export type ChannelModelByChannelConfig = Record<string, Record<string, string>>;

/**
 * Base type for extension channel config sections.
 * Extensions can use this as a starting point for their channel config.
 */
export type ExtensionChannelConfig = {
  enabled?: boolean;
  allowFrom?: string | string[];
  /** Default delivery target for CLI --deliver when no explicit --reply-to is provided. */
  defaultTo?: string;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
  dmPolicy?: string;
  groupPolicy?: GroupPolicy;
  contextVisibility?: ContextVisibilityMode;
  healthMonitor?: ChannelHealthMonitorConfig;
  accounts?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface ChannelsConfig {
  defaults?: ChannelDefaultsConfig;
  /** Map provider -> channel id -> model override. */
  modelByChannel?: ChannelModelByChannelConfig;
  /** Channel sections are plugin-owned; concrete channel files augment this interface. */
  [key: string]: unknown;
}

/**
 * Narrow an unknown value obtained from `ChannelsConfig[key]` into a typed
 * channel section shape. Plugin-owned sections live behind the index signature
 * so they need an explicit narrowing step before property access.
 */
export function getChannelSection<T extends Record<string, unknown>>(
  value: unknown,
): T | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as T;
}

/**
 * Augment `ChannelsConfig` with the channel sections that ship in-repo but are
 * owned by external plugins (line, matrix, bluebubbles, nostr, zalouser,
 * synology-chat, msteams). Each plugin is free to extend this further.
 */
declare module "./types.channels.js" {
  interface ChannelsConfig {
    bluebubbles?: {
      enabled?: boolean;
      allowFrom?: Array<string | number>;
      dmPolicy?: string;
      channelAccessToken?: string;
      channelSecret?: string;
      accounts?: Record<
        string,
        { allowFrom?: Array<string | number>; dmPolicy?: string; enabled?: boolean }
      >;
      [key: string]: unknown;
    };
    nostr?: {
      enabled?: boolean;
      allowFrom?: Array<string | number>;
      privateKey?: string;
      relays?: string[];
      dmPolicy?: string;
      dm?: {
        allowFrom?: Array<string | number>;
        policy?: "open" | "allowlist" | "pairing" | "disabled";
      };
      [key: string]: unknown;
    };
    matrix?: {
      homeserver?: string;
      userId?: string;
      accessToken?: string;
      password?: string;
      allowBots?: boolean;
      groups?: Record<string, unknown>;
      allowFrom?: Array<string | number>;
      accounts?: Record<
        string,
        { rooms?: Record<string, { enabled?: boolean }>; policy?: string; password?: string }
      >;
      dm?: {
        allowFrom?: Array<string | number>;
        policy?: "open" | "allowlist" | "pairing" | "disabled";
      };
      [key: string]: unknown;
    };
    zalo?: {
      botToken?: string;
      botSecret?: string;
      apiPassword?: string;
      accounts?: Record<string, { botToken?: string; botSecret?: string; apiPassword?: string }>;
      [key: string]: unknown;
    };
    zalouser?: {
      groups?: Record<string, unknown>;
      accounts?: Record<string, { groups?: Record<string, unknown> }>;
      [key: string]: unknown;
    };
    "synology-chat"?: {
      accounts?: Record<
        string,
        { dangerouslyAllowNameMatching?: boolean; token?: string; incomingUrl?: string }
      >;
      dangerouslyAllowNameMatching?: boolean;
      token?: string;
      incomingUrl?: string;
      [key: string]: unknown;
    };
    "nextcloud-talk"?: {
      allowFrom?: Array<string | number>;
      botSecret?: string;
      apiPassword?: string;
      accounts?: Record<
        string,
        { botSecret?: string; apiPassword?: string; allowFrom?: Array<string | number> }
      >;
      [key: string]: unknown;
    };
    mattermost?: {
      enabled?: boolean;
      botToken?: string;
      baseUrl?: string;
      [key: string]: unknown;
    };
    feishu?: {
      enabled?: boolean;
      appId?: string;
      appSecret?: string | { source: "env" | "file" | "exec"; provider: string; id: string };
      [key: string]: unknown;
    };
  }
}

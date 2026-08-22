import type { OpenClawConfig } from "../../../config/config.js";
import { requireBundledChannelPlugin } from "../bundled.js";
import type { ChannelPlugin } from "../types.js";

type ActionsContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "actions">;
  unsupportedAction?: string;
  cases: Array<{
    name: string;
    cfg: OpenClawConfig;
    expectedActions: string[];
    expectedCapabilities?: string[];
    beforeTest?: () => void;
  }>;
};

let actionContractRegistryCache: ActionsContractEntry[] | undefined;

export function getActionContractRegistry(): ActionsContractEntry[] {
  actionContractRegistryCache ??= [
    {
      id: "telegram",
      plugin: requireBundledChannelPlugin("telegram"),
      cases: [
        {
          name: "exposes configured Telegram actions and capabilities",
          cfg: {
            channels: {
              telegram: {
                botToken: "123:telegram-test-token",
              },
            },
          } as OpenClawConfig,
          expectedActions: [
            "send",
            "poll",
            "react",
            "delete",
            "edit",
            "topic-create",
            "topic-edit",
          ],
          expectedCapabilities: ["interactive", "buttons"],
        },
      ],
    },
    {
      id: "discord",
      plugin: requireBundledChannelPlugin("discord"),
      cases: [
        {
          name: "describes configured Discord actions and capabilities",
          cfg: {
            channels: {
              discord: {
                token: "Bot token-main",
                actions: {
                  polls: true,
                  reactions: true,
                  permissions: false,
                  messages: false,
                  pins: false,
                  threads: false,
                  search: false,
                  stickers: false,
                  memberInfo: false,
                  roleInfo: false,
                  emojiUploads: false,
                  stickerUploads: false,
                  channelInfo: false,
                  channels: false,
                  voiceStatus: false,
                  events: false,
                  roles: false,
                  moderation: false,
                  presence: false,
                },
              },
            },
          } as OpenClawConfig,
          expectedActions: ["send", "poll", "react", "reactions", "emoji-list"],
          expectedCapabilities: ["interactive", "components"],
        },
      ],
    },
  ];
  return actionContractRegistryCache;
}

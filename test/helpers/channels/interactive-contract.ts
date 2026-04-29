export type {
  DiscordInteractiveHandlerContext,
  DiscordInteractiveHandlerRegistration,
} from "../../../extensions/discord/contract-api.js";
export type {
  TelegramInteractiveHandlerContext,
  TelegramInteractiveHandlerRegistration,
} from "../../../extensions/telegram/contract-api.js";

type SlackInteractiveRespond = {
  acknowledge: () => Promise<void>;
  reply: () => Promise<void>;
  followUp: () => Promise<void>;
  editMessage: () => Promise<void>;
};

export type SlackInteractiveHandlerContext = {
  channel: "slack";
  accountId: string;
  interactionId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string;
  senderId: string;
  senderUsername?: string;
  auth: { isAuthorizedSender: boolean };
  interaction: {
    kind: string;
    actionId: string;
    blockId?: string;
    messageTs?: string;
    threadTs?: string;
    value?: string;
    selectedValues?: string[];
    selectedLabels?: string[];
    triggerId?: string;
    responseUrl?: string;
    data: string;
    namespace: string;
    payload: string;
  };
  respond: SlackInteractiveRespond;
  requestConversationBinding: unknown;
  detachConversationBinding: unknown;
  getCurrentConversationBinding: unknown;
};

export type SlackInteractiveHandlerRegistration = {
  channel: "slack";
  namespace: string;
  handler: (ctx: SlackInteractiveHandlerContext) => Promise<void> | void;
};

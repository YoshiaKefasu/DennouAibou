import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  ensureConfiguredBindingRouteReady,
  readChannelAllowFromStore,
  recordInboundSessionMetaSafe,
  resolveConfiguredBindingRoute,
  getSessionBindingService,
} from "openclaw/plugin-sdk/conversation-runtime";
import { getPluginCommandSpecs } from "openclaw/plugin-sdk/plugin-runtime";
import { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { listSkillCommandsForAgents } from "openclaw/plugin-sdk/skill-commands-runtime";
import type { TelegramBotDeps } from "./bot-deps.js";
import { syncTelegramMenuCommands } from "./bot-native-command-menu.js";

type DeliverRepliesFn = typeof import("./bot/delivery.js").deliverReplies;

export type TelegramNativeCommandDeps = Pick<
  TelegramBotDeps,
  | "dispatchReplyWithBufferedBlockDispatcher"
  | "editMessageTelegram"
  | "listSkillCommandsForAgents"
  | "loadConfig"
  | "readChannelAllowFromStore"
  | "syncTelegramMenuCommands"
> & {
  getPluginCommandSpecs?: typeof getPluginCommandSpecs;
  /** Optional call-time seams; unspecified fields fall back to the runtime module. */
  resolveConfiguredBindingRoute?: typeof resolveConfiguredBindingRoute;
  getSessionBindingService?: typeof getSessionBindingService;
  ensureConfiguredBindingRouteReady?: typeof ensureConfiguredBindingRouteReady;
  recordInboundSessionMetaSafe?: typeof recordInboundSessionMetaSafe;
  deliverReplies?: DeliverRepliesFn;
};

let telegramSendRuntimePromise: Promise<typeof import("./send.js")> | undefined;

async function loadTelegramSendRuntime() {
  telegramSendRuntimePromise ??= import("./send.js");
  return await telegramSendRuntimePromise;
}

export const defaultTelegramNativeCommandDeps: TelegramNativeCommandDeps = {
  get loadConfig() {
    return loadConfig;
  },
  get readChannelAllowFromStore() {
    return readChannelAllowFromStore;
  },
  get dispatchReplyWithBufferedBlockDispatcher() {
    return dispatchReplyWithBufferedBlockDispatcher;
  },
  get listSkillCommandsForAgents() {
    return listSkillCommandsForAgents;
  },
  get syncTelegramMenuCommands() {
    return syncTelegramMenuCommands;
  },
  get getPluginCommandSpecs() {
    return getPluginCommandSpecs;
  },
  async editMessageTelegram(...args) {
    const { editMessageTelegram } = await loadTelegramSendRuntime();
    return await editMessageTelegram(...args);
  },
};

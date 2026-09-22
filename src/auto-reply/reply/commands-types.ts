import type { BlockReplyChunking } from "../../agents/pi-embedded-block-chunker.js";
import type { SkillCommandSpec } from "../../agents/skills.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry, SessionScope } from "../../config/sessions.js";
import type { MsgContext } from "../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { InlineDirectives } from "./directive-handling.js";
import type { TypingController } from "./typing.js";

export type CommandsDeps = {
  readConfigFileSnapshot: typeof import("../../config/config.js").readConfigFileSnapshot;
  validateConfigObjectWithPlugins: typeof import("../../config/config.js").validateConfigObjectWithPlugins;
  writeConfigFile: typeof import("../../config/config.js").writeConfigFile;
  readChannelAllowFromStore: typeof import("../../pairing/pairing-store.js").readChannelAllowFromStore;
  addChannelAllowFromStoreEntry: typeof import("../../pairing/pairing-store.js").addChannelAllowFromStoreEntry;
  removeChannelAllowFromStoreEntry: typeof import("../../pairing/pairing-store.js").removeChannelAllowFromStoreEntry;
  loadModelCatalog: typeof import("../../agents/model-catalog.js").loadModelCatalog;
  abortEmbeddedPiRun: typeof import("../../agents/pi-embedded.js").abortEmbeddedPiRun;
  compactEmbeddedPiSession: typeof import("../../agents/pi-embedded.js").compactEmbeddedPiSession;
  isEmbeddedPiRunActive: typeof import("../../agents/pi-embedded.js").isEmbeddedPiRunActive;
  waitForEmbeddedPiRunEnd: typeof import("../../agents/pi-embedded.js").waitForEmbeddedPiRunEnd;
  enqueueSystemEvent: typeof import("../../infra/system-events.js").enqueueSystemEvent;
  incrementCompactionCount: typeof import("./session-updates.js").incrementCompactionCount;
  callGateway: typeof import("../../gateway/call.js").callGateway;
  buildContextReply: typeof import("./commands-context-report.js").buildContextReply;
};

export type CommandContext = {
  surface: string;
  channel: string;
  channelId?: ChannelId;
  ownerList: string[];
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  senderId?: string;
  abortKey?: string;
  rawBodyNormalized: string;
  commandBodyNormalized: string;
  from?: string;
  to?: string;
  /** Internal marker to prevent duplicate reset-hook emission across command pipelines. */
  resetHookTriggered?: boolean;
};

export type HandleCommandsParams = {
  ctx: MsgContext;
  rootCtx?: MsgContext;
  cfg: OpenClawConfig;
  command: CommandContext;
  agentId?: string;
  agentDir?: string;
  directives: InlineDirectives;
  elevated: {
    enabled: boolean;
    allowed: boolean;
    failures: Array<{ gate: string; key: string }>;
  };
  sessionEntry?: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  sessionScope?: SessionScope;
  workspaceDir: string;
  opts?: GetReplyOptions;
  defaultGroupActivation: () => "always" | "mention";
  resolvedThinkLevel?: ThinkLevel;
  resolvedVerboseLevel: VerboseLevel;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  blockReplyChunking?: BlockReplyChunking;
  resolvedBlockStreamingBreak?: "text_end" | "message_end";
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  provider: string;
  model: string;
  contextTokens: number;
  isGroup: boolean;
  skillCommands?: SkillCommandSpec[];
  typing?: TypingController;
  /** Optional test seams for command-runtime dependencies. When omitted, the
   * production implementation is used exactly as before. */
  deps?: Partial<CommandsDeps>;
};

export type CommandHandlerResult = {
  reply?: ReplyPayload;
  shouldContinue: boolean;
};

export type CommandHandler = (
  params: HandleCommandsParams,
  allowTextCommands: boolean,
) => Promise<CommandHandlerResult | null>;

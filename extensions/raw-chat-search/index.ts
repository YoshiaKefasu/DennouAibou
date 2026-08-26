import { definePluginEntry } from "../../src/plugin-sdk/plugin-entry.js";
import {
  closeAllRawChatDatabases,
  getRawChatDatabase,
  RawChatDatabase,
  resolveRawChatDbPath,
} from "./src/database.js";
import {
  isRawChatIndexingEnabled,
  resolveSessionAgentIdFromKey,
  startRawChatIndexer,
  stopRawChatIndexer,
} from "./src/hook.js";
import { backfillSessionFiles, extractTextFromContent, indexSessionFile } from "./src/indexer.js";
import { ChatSearchSchema, createChatSearchTool } from "./src/tools.js";

export {
  RawChatDatabase,
  getRawChatDatabase,
  closeAllRawChatDatabases,
  resolveRawChatDbPath,
  indexSessionFile,
  backfillSessionFiles,
  extractTextFromContent,
  startRawChatIndexer,
  stopRawChatIndexer,
  isRawChatIndexingEnabled,
  resolveSessionAgentIdFromKey,
  createChatSearchTool,
  ChatSearchSchema,
};

export type {
  ChatMessageRecord,
  WatermarkRecord,
  SearchParams,
  SearchResult,
  SearchResults,
  IndexSessionParams,
  IndexSessionResult,
  BackfillParams,
  BackfillResult,
  RawChatMessageInput,
} from "./src/types.js";

export default definePluginEntry({
  id: "raw-chat-search",
  name: "Raw Chat Search",
  description: "Permanent raw chat SQLite index and FTS5 search",
  register(api) {
    // Register chat_search agent tool
    api.registerTool(
      (ctx) =>
        createChatSearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        }),
      { names: ["chat_search"] },
    );

    // Register background indexer service
    api.registerService({
      id: "raw-chat-indexer",
      start(ctx) {
        startRawChatIndexer(ctx.config);
      },
      stop() {
        stopRawChatIndexer();
        closeAllRawChatDatabases();
      },
    });
  },
});

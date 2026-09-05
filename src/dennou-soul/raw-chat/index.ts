/**
 * Raw chat permanent DB subsystem (TS + SQLite + FTS5).
 *
 * Provides exact raw message ledger indexing from session JSONL
 * and fast keyword/date/context search.
 */

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
  type ChatMessageRecord,
  type WatermarkRecord,
  type SearchParams,
  type SearchResult,
  type SearchResults,
  type IndexSessionParams,
  type IndexSessionResult,
  type BackfillParams,
  type BackfillResult,
  type RawChatMessageInput,
} from "../../../extensions/raw-chat-search/index.js";

/**
 * Raw chat permanent DB subsystem.
 *
 * Phase 1: Go sidecar as the production DB/index/search engine.
 * TypeScript owns only: sidecar launch/shutdown, transcript hook/debounce,
 * typed RPC request/response validation, tool registration, and compact result formatting.
 *
 * The session JSONL remains the source of truth; the Go-side SQLite DB is a derived index.
 */

export {
  RawChatClient,
  type SearchParams,
  type SearchResults,
  type SearchResult,
  type IndexSessionParams,
  type IndexSessionResult,
  type BackfillParams,
  type BackfillResult,
} from "./sidecar-client.js";
export { createChatSearchTool, ChatSearchSchema } from "./tool.js";
export { startRawChatIndexer, stopRawChatIndexer, isRawChatIndexingEnabled, backfillSessionFiles } from "./hook.js";
export { setRawChatClient, getRawChatClient } from "./client-ref.js";

import { definePluginEntry } from "../../src/plugin-sdk/plugin-entry.js";
import { backfillEmbeddings, embedPendingPairs } from "./src/backfill.js";
import {
  closeAllRawChatDatabases,
  getRawChatDatabase,
  RawChatDatabase,
  resolveRawChatDbPath,
} from "./src/database.js";
import {
  blobToEmbedding,
  embedTextWithGemini,
  embedTextWithGeminiOrNull,
  embeddingToBlob,
  GeminiEmbeddingError,
  resolveGeminiApiKey,
} from "./src/embedding-client.js";
import {
  isRawChatIndexingEnabled,
  resolveSessionAgentIdFromKey,
  scheduleEmbeddingSweep,
  startEmbeddingBackfill,
  startRawChatIndexer,
  stopRawChatIndexer,
} from "./src/hook.js";
import { backfillSessionFiles, extractTextFromContent, indexSessionFile } from "./src/indexer.js";
import {
  extractConversationPairs,
  formatPairSnippet,
  formatPairText,
  isNoiseTurn,
  PAIR_SNIPPET_MAX_LENGTH,
} from "./src/pair-extractor.js";
import { ChatSearchSchema, createChatSearchTool } from "./src/tools.js";
import {
  blobToVector,
  cosineSimilarity,
  cosineSimilarityBatch,
  EMBEDDING_DIMENSIONS,
  normalizeL2,
  vectorToBlob,
} from "./src/vector-math.js";

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
  // Vector computation engine (RAW_CHAT_SEARCH Phase 1)
  cosineSimilarity,
  cosineSimilarityBatch,
  normalizeL2,
  vectorToBlob,
  blobToVector,
  EMBEDDING_DIMENSIONS,
  // Gemini Embedding 2 client (RAW_CHAT_SEARCH Phase 1)
  embedTextWithGemini,
  embedTextWithGeminiOrNull,
  embeddingToBlob,
  blobToEmbedding,
  resolveGeminiApiKey,
  GeminiEmbeddingError,
  // Round-trip pair extraction (RAW_CHAT_SEARCH Phase 2)
  extractConversationPairs,
  formatPairText,
  formatPairSnippet,
  isNoiseTurn,
  PAIR_SNIPPET_MAX_LENGTH,
  // Pair embedding indexer & backfill (RAW_CHAT_SEARCH Phase 2)
  embedPendingPairs,
  backfillEmbeddings,
  startEmbeddingBackfill,
  scheduleEmbeddingSweep,
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
  InsertEmbeddingParams,
  EmbeddingRecord,
  LoadedEmbeddings,
  PairWindowMessage,
  PendingPairBase,
} from "./src/types.js";

export type { GeminiEmbedOptions, GeminiEmbeddingFailureCode } from "./src/embedding-client.js";

export type { ExtractedPair } from "./src/pair-extractor.js";

export type {
  EmbedPendingOptions,
  EmbedPendingResult,
  BackfillEmbeddingsOptions,
  BackfillEmbeddingsResult,
} from "./src/backfill.js";

export type { RawChatIndexerOptions } from "./src/hook.js";

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
        // FTS5 indexing + non-blocking pair embedding/backfill (RAW_CHAT_SEARCH §7).
        startRawChatIndexer(ctx.config);
      },
      stop() {
        stopRawChatIndexer();
        closeAllRawChatDatabases();
      },
    });
  },
});

import { definePluginEntry } from "../../src/plugin-sdk/plugin-entry.js";
import { DEFAULT_AGENT_ID } from "../../src/routing/session-key.js";
import { backfillEmbeddings, embedPendingPairs } from "./src/backfill.js";
import {
  closeAllRawChatDatabases,
  getRawChatDatabase,
  RawChatDatabase,
  resolveRawChatDbPath,
} from "./src/database.js";
import { DreamScheduler, resolveDreamConfig, runDreamConsolidation } from "./src/dream.js";
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
  getActiveMemosForPrompt,
  resolveMemoMaxTokens,
  resolveMemoTimezone,
} from "./src/memo-db.js";
import { createMemoTool, MemoToolSchema } from "./src/memo-tool.js";
import {
  extractConversationPairs,
  formatPairSnippet,
  formatPairText,
  isNoiseTurn,
  PAIR_SNIPPET_MAX_LENGTH,
} from "./src/pair-extractor.js";
import {
  DEFAULT_RECALL_TIMEOUT_MS,
  HIGH_RELEVANCE_THRESHOLD,
  MEDIUM_RELEVANCE_THRESHOLD,
  performVectorRecall,
} from "./src/recall.js";
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
  // Memo subsystem (DENNOU_SHINKEI_MEMO Phase 1)
  createMemoTool,
  MemoToolSchema,
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
  // Two-stage vector recall (RAW_CHAT_SEARCH Phase 3)
  performVectorRecall,
  HIGH_RELEVANCE_THRESHOLD,
  MEDIUM_RELEVANCE_THRESHOLD,
  DEFAULT_RECALL_TIMEOUT_MS,
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
export type { RecallOptions, RecallResult } from "./src/recall.js";
export type {
  MemoCategory,
  MemoStatus,
  MemoRecord,
  WriteMemoParams,
  ReadMemosParams,
  UpdateMemoParams,
  MemoPromptOptions,
  DreamConsolidationInput,
  DreamApplyResult,
} from "./src/memo-db.js";
export type { MemoAction } from "./src/memo-tool.js";
export type {
  DreamConfig,
  DreamConsolidation,
  DreamResult,
  DreamRunParams,
  DreamSchedulerOptions,
  DreamDeps,
} from "./src/dream.js";
export {
  DreamScheduler,
  resolveDreamConfig,
  runDreamConsolidation,
  buildDreamPrompt,
  parseDreamResponseText,
  resolveDreamLanguageName,
  withDreamLanguageDirective,
  DEFAULT_DREAM_SCHEDULE,
  DEFAULT_DREAM_LANGUAGE,
} from "./src/dream.js";

export default definePluginEntry({
  id: "raw-chat-search",
  name: "電脳神経 (Raw Chat Search)",
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

    // Register memo agent tool (DENNOU_SHINKEI_MEMO Phase 1: independent of vector indexing)
    api.registerTool(
      (ctx) =>
        createMemoTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        }),
      { names: ["memo"] },
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

    // Dream: nightly autonomous memo consolidation (DENNOU_SHINKEI_MEMO §6).
    // Single structured LLM completion per run — never a full agent session.
    let dreamScheduler: DreamScheduler | undefined;
    api.registerService({
      id: "raw-chat-search-dream",
      start(ctx) {
        // Guard against double-start (e.g. hot reload).
        dreamScheduler?.stop();
        dreamScheduler = undefined;
        const dreamConfig = resolveDreamConfig(api.pluginConfig, ctx.config);
        if (!dreamConfig.enabled) {
          api.logger.info("raw-chat-search: dream disabled by config.");
          return;
        }
        const scheduler = new DreamScheduler({
          schedule: dreamConfig.schedule,
          timezone: dreamConfig.timezone,
          ...(dreamConfig.model ? { modelOverride: dreamConfig.model } : {}),
          language: dreamConfig.language,
          agentId: DEFAULT_AGENT_ID,
          db: () => getRawChatDatabase(DEFAULT_AGENT_ID),
          cfg: ctx.config,
          logger: api.logger,
        });
        if (!scheduler.start()) {
          return;
        }
        dreamScheduler = scheduler;
        api.logger.info(
          `raw-chat-search: dream scheduled (${dreamConfig.schedule}, ${dreamConfig.timezone}).`,
        );
      },
      stop() {
        dreamScheduler?.stop();
        dreamScheduler = undefined;
      },
    });

    api.on("before_prompt_build", async (event, ctx) => {
      // Memo injection runs independently of vector recall: it needs no API
      // key and must survive DENNOU_SKIP_VECTOR_RECALL (DENNOU_SHINKEI_MEMO §5).
      const injectedParts: string[] = [];
      try {
        const memoContext = getActiveMemosForPrompt(getRawChatDatabase(ctx.agentId), {
          maxTokens: resolveMemoMaxTokens(api.pluginConfig, ctx.modelContextWindow),
          timezone: resolveMemoTimezone(undefined, api.config),
        });
        if (memoContext) {
          injectedParts.push(memoContext);
        }
      } catch (error) {
        // Memo is an accelerator like recall: never fail prompt construction.
        api.logger.warn(
          `raw-chat-search: memo injection skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (process.env.DENNOU_SKIP_VECTOR_RECALL !== "1") {
        try {
          const result = await performVectorRecall({
            prompt: event.prompt,
            agentId: ctx.agentId,
            sessionId: ctx.sessionId,
          });
          if (result.injectedContext) {
            injectedParts.push(result.injectedContext);
          }
        } catch (error) {
          // Recall is an optional accelerator: never make prompt construction fail.
          api.logger.warn(
            `raw-chat-search: vector recall skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // <active-memos> first, <recalled-memory> after (§5.2).
      const combined = injectedParts.join("\n");
      return combined ? { appendSystemContext: combined } : undefined;
    });
  },
});

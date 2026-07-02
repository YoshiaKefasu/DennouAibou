import { Type } from "@sinclair/typebox";
import {
  readStringParam,
  readNumberParam,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveSessionAgentId } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { RawChatClient, SearchParams } from "./sidecar-client.js";
import { getRawChatClient } from "./client-ref.js";
import { textResult } from "../../agents/tools/common.js";
import { isRawChatIndexingEnabled } from "./hook.js";

/**
 * chat_search tool — searches the raw chat permanent DB via Go sidecar RPC.
 *
 * ponytail: Phase 1 — thin TS boundary only. DB/index/search logic lives in Go.
 * This tool validates parameters and calls the Go sidecar via RPC.
 */

export const ChatSearchSchema = Type.Object({
  query: Type.Optional(Type.String({ description: "Keyword search query (FTS5)" })),
  from: Type.Optional(Type.String({ description: "Start time (ISO 8601)" })),
  to: Type.Optional(Type.String({ description: "End time (ISO 8601)" })),
  date: Type.Optional(Type.String({ description: "Date filter (YYYY-MM-DD)" })),
  messageId: Type.Optional(Type.String({ description: "Show surrounding context for this message ID" })),
  role: Type.Optional(Type.String({ description: "Filter by role: user or assistant" })),
  channel: Type.Optional(Type.String({ description: "Filter by channel" })),
  limit: Type.Optional(Type.Number({ description: "Max results (default 20, max 100)" })),
  contextBefore: Type.Optional(Type.Number({ description: "Messages before context (default 0)" })),
  contextAfter: Type.Optional(Type.Number({ description: "Messages after context (default 0)" })),
});

export function createChatSearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  // Kill switch: do not register tool when indexing is disabled.
  if (!isRawChatIndexingEnabled(cfg)) {
    return null;
  }

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "Chat Search",
    name: "chat_search",
    description:
      "Search raw chat history by keyword, date, time range, or message context. Returns compact snippets from the session transcript ledger.",
    parameters: ChatSearchSchema,
    execute: async (_toolCallId, params) => {
      const client = getRawChatClient();
      if (!client) {
          return textResult(
            JSON.stringify({
              results: [],
              error: "Raw chat sidecar is not available.",
              hint: "The Go sidecar may not be running. Indexing is disabled until it starts.",
            }),
            undefined,
          );
      }

      const searchParams: SearchParams = {
        query: readStringParam(params, "query") ?? undefined,
        from: readStringParam(params, "from") ?? undefined,
        to: readStringParam(params, "to") ?? undefined,
        date: readStringParam(params, "date") ?? undefined,
        message_id: readStringParam(params, "messageId") ?? undefined,
        role: readStringParam(params, "role") ?? undefined,
        channel: readStringParam(params, "channel") ?? undefined,
        agent_id: agentId,
        limit: readNumberParam(params, "limit") ?? undefined,
        context_before: readNumberParam(params, "contextBefore") ?? undefined,
        context_after: readNumberParam(params, "contextAfter") ?? undefined,
      };

      try {
        const results = await client.search(searchParams);
        return textResult(JSON.stringify(results, null, 2), undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult(
          JSON.stringify({
            results: [],
            error: message,
            hint: "Raw chat search is unavailable. The Go sidecar may have crashed or the DB may not exist yet.",
          }),
          undefined,
        );
      }
    },
  };
}

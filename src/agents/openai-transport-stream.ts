import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  calculateCost,
  createAssistantMessageEventStream,
  parseStreamingJson,
  type Api,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./copilot-dynamic-headers.js";
import { detectOpenAICompletionsCompat } from "./openai-completions-compat.js";
import {
  normalizeOpenAIStrictToolParameters,
  resolveOpenAIStrictToolFlagForInventory,
  resolveOpenAIStrictToolSetting,
} from "./openai-tool-schema.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import { stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary.js";

type BaseStreamOptions = {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  cacheRetention?: "none" | "short" | "long";
  sessionId?: string;
  onPayload?: (payload: unknown, model: Model<Api>) => unknown;
  headers?: ProviderHeaders;
};

export type OpenAICompletionsOptions = BaseStreamOptions & {
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | {
        type: "function";
        function: {
          name: string;
        };
      };
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};

export type OpenAIModeModel = Model<Api>;

type MutableAssistantOutput = {
  role: "assistant";
  content: Array<Record<string, unknown>>;
  api: Api;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: string;
  timestamp: number;
  responseId?: string;
  errorMessage?: string;
};

export { sanitizeTransportPayloadText } from "./transport-stream-shared.js";

function buildOpenAIClientHeaders(
  model: Model<Api>,
  context: Context,
  optionHeaders?: ProviderHeaders,
  turnHeaders?: ProviderHeaders,
): Record<string, string> {
  const dropNull = (h: ProviderHeaders | undefined): Record<string, string> | undefined => {
    if (!h) {
      return undefined;
    }
    return Object.fromEntries(Object.entries(h).filter(([, v]) => v !== null)) as Record<
      string,
      string
    >;
  };
  const opt = dropNull(optionHeaders);
  const turn = dropNull(turnHeaders);
  const headers = { ...model.headers };
  if (model.provider === "github-copilot") {
    Object.assign(
      headers,
      buildCopilotDynamicHeaders({
        messages: context.messages,
        hasImages: hasCopilotVisionInput(context.messages),
      }),
    );
  }
  if (opt) {
    Object.assign(headers, opt);
  }
  if (turn) {
    Object.assign(headers, turn);
  }
  return headers;
}

function hasToolHistory(messages: Context["messages"]): boolean {
  if (!messages) {
    return false;
  }
  return messages.some((m) => {
    if (m.role === "toolResult") {
      return true;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      return m.content.some(
        (b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "toolCall",
      );
    }
    return false;
  });
}

function createOpenAICompletionsClient(
  model: Model<Api>,
  context: Context,
  apiKey: string,
  optionHeaders?: ProviderHeaders,
) {
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders),
    fetch: buildGuardedModelFetch(model),
  });
}

export function createOpenAICompletionsTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const client = createOpenAICompletionsClient(model, context, apiKey, options?.headers);
        let params = buildOpenAICompletionsParams(
          model as OpenAIModeModel,
          context,
          options as OpenAICompletionsOptions | undefined,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        const responseStream = (await client.chat.completions.create(params as never, {
          signal: options?.signal,
        })) as unknown as AsyncIterable<ChatCompletionChunk>;
        stream.push({ type: "start", partial: output as never });
        await processOpenAICompletionsStream(responseStream, output, model, stream);
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

async function processOpenAICompletionsStream(
  responseStream: AsyncIterable<ChatCompletionChunk>,
  output: MutableAssistantOutput,
  model: Model<Api>,
  stream: { push(event: unknown): void },
) {
  let currentBlock:
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; thinkingSignature?: string }
    | {
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        partialArgs: string;
      }
    | null = null;
  const blockIndex = () => output.content.length - 1;
  const finishCurrentBlock = () => {
    if (!currentBlock) {
      return;
    }
    if (currentBlock.type === "toolCall") {
      currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
      const completed = {
        ...currentBlock,
        arguments: parseStreamingJson(currentBlock.partialArgs),
      };
      output.content[blockIndex()] = completed;
    }
  };
  for await (const chunk of responseStream) {
    output.responseId ||= chunk.id;
    if (chunk.usage) {
      output.usage = parseTransportChunkUsage(chunk.usage, model);
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) {
      continue;
    }
    const choiceUsage = (choice as unknown as { usage?: ChatCompletionChunk["usage"] }).usage;
    if (!chunk.usage && choiceUsage) {
      output.usage = parseTransportChunkUsage(choiceUsage, model);
    }
    if (choice.finish_reason) {
      const finishReasonResult = mapStopReason(choice.finish_reason);
      output.stopReason = finishReasonResult.stopReason;
      if (finishReasonResult.errorMessage) {
        output.errorMessage = finishReasonResult.errorMessage;
      }
    }
    if (!choice.delta) {
      continue;
    }
    if (choice.delta.content) {
      if (!currentBlock || currentBlock.type !== "text") {
        finishCurrentBlock();
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
      }
      currentBlock.text += choice.delta.content;
      stream.push({
        type: "text_delta",
        contentIndex: blockIndex(),
        delta: choice.delta.content,
        partial: output,
      });
      continue;
    }
    const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;
    const reasoningField = reasoningFields.find((field) => {
      const value = (choice.delta as Record<string, unknown>)[field];
      return typeof value === "string" && value.length > 0;
    });
    if (reasoningField) {
      if (!currentBlock || currentBlock.type !== "thinking") {
        finishCurrentBlock();
        currentBlock = { type: "thinking", thinking: "", thinkingSignature: reasoningField };
        output.content.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      }
      currentBlock.thinking += String((choice.delta as Record<string, unknown>)[reasoningField]);
      stream.push({
        type: "thinking_delta",
        contentIndex: blockIndex(),
        delta: String((choice.delta as Record<string, unknown>)[reasoningField]),
        partial: output,
      });
      continue;
    }
    if (choice.delta.tool_calls) {
      for (const toolCall of choice.delta.tool_calls) {
        if (
          !currentBlock ||
          currentBlock.type !== "toolCall" ||
          (toolCall.id && currentBlock.id !== toolCall.id)
        ) {
          finishCurrentBlock();
          currentBlock = {
            type: "toolCall",
            id: toolCall.id || "",
            name: toolCall.function?.name || "",
            arguments: {},
            partialArgs: "",
          };
          output.content.push(currentBlock);
          stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
        }
        if (currentBlock.type !== "toolCall") {
          continue;
        }
        if (toolCall.id) {
          currentBlock.id = toolCall.id;
        }
        if (toolCall.function?.name) {
          currentBlock.name = toolCall.function.name;
        }
        if (toolCall.function?.arguments) {
          currentBlock.partialArgs += toolCall.function.arguments;
          currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
          stream.push({
            type: "toolcall_delta",
            contentIndex: blockIndex(),
            delta: toolCall.function.arguments,
            partial: output,
          });
        }
      }
    }
  }
  finishCurrentBlock();
}

function detectCompat(model: OpenAIModeModel) {
  const provider = model.provider;
  const { capabilities, defaults: compatDefaults } = detectOpenAICompletionsCompat(model);
  const endpointClass = capabilities.endpointClass;
  const isDefaultRoute = endpointClass === "default";
  const isGroq = endpointClass === "groq-native" || (isDefaultRoute && provider === "groq");
  const reasoningEffortMap: Record<string, string | null> =
    isGroq && model.id === "qwen/qwen3-32b"
      ? {
          minimal: "default",
          low: "default",
          medium: "default",
          high: "default",
          xhigh: "default",
          max: null,
        }
      : {};
  return {
    supportsStore: compatDefaults.supportsStore,
    supportsDeveloperRole: compatDefaults.supportsDeveloperRole,
    supportsReasoningEffort: compatDefaults.supportsReasoningEffort,
    reasoningEffortMap,
    supportsUsageInStreaming: compatDefaults.supportsUsageInStreaming,
    maxTokensField: compatDefaults.maxTokensField,
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    thinkingFormat: compatDefaults.thinkingFormat,
    openRouterRouting: {},
    vercelGatewayRouting: {},
    supportsStrictMode: compatDefaults.supportsStrictMode,
  };
}

function getCompat(model: OpenAIModeModel): {
  supportsStore: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  reasoningEffortMap: Record<string, string | null>;
  supportsUsageInStreaming: boolean;
  maxTokensField: string;
  requiresToolResultName: boolean;
  requiresAssistantAfterToolResult: boolean;
  requiresThinkingAsText: boolean;
  thinkingFormat: string;
  openRouterRouting: Record<string, unknown>;
  vercelGatewayRouting: Record<string, unknown>;
  supportsStrictMode: boolean;
} {
  const detected = detectCompat(model);
  const compat = (model.compat ?? {}) as Record<string, unknown>;
  const supportsStore =
    typeof compat.supportsStore === "boolean" ? compat.supportsStore : detected.supportsStore;
  const supportsReasoningEffort =
    typeof compat.supportsReasoningEffort === "boolean"
      ? compat.supportsReasoningEffort
      : detected.supportsReasoningEffort;
  return {
    supportsStore,
    supportsDeveloperRole:
      (compat.supportsDeveloperRole as boolean | undefined) ?? detected.supportsDeveloperRole,
    supportsReasoningEffort,
    reasoningEffortMap:
      (compat.reasoningEffortMap as Record<string, string | null> | undefined) ??
      detected.reasoningEffortMap,
    supportsUsageInStreaming:
      (compat.supportsUsageInStreaming as boolean | undefined) ?? detected.supportsUsageInStreaming,
    maxTokensField: (compat.maxTokensField as string | undefined) ?? detected.maxTokensField,
    requiresToolResultName:
      (compat.requiresToolResultName as boolean | undefined) ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      (compat.requiresAssistantAfterToolResult as boolean | undefined) ??
      detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText:
      (compat.requiresThinkingAsText as boolean | undefined) ?? detected.requiresThinkingAsText,
    thinkingFormat: (compat.thinkingFormat as string | undefined) ?? detected.thinkingFormat,
    openRouterRouting: (compat.openRouterRouting as Record<string, unknown> | undefined) ?? {},
    vercelGatewayRouting:
      (compat.vercelGatewayRouting as Record<string, unknown> | undefined) ??
      detected.vercelGatewayRouting,
    supportsStrictMode:
      (compat.supportsStrictMode as boolean | undefined) ?? detected.supportsStrictMode,
  };
}

function mapReasoningEffort(
  effort: string,
  reasoningEffortMap: Record<string, string | null>,
): string | null | undefined {
  // The map is the single source of truth. Three states:
  //   - entry absent: caller likely has no map declared; emit the raw effort
  //     (back-compat for legacy configs that only set supportsReasoningEffort).
  //   - entry present + string: emit the declared wire value.
  //   - entry present + null: declared as unsupported — do NOT leak the raw
  //     token, drop the parameter entirely.
  if (!Object.prototype.hasOwnProperty.call(reasoningEffortMap, effort)) {
    return effort;
  }
  return reasoningEffortMap[effort] ?? undefined;
}

function convertTools(
  tools: NonNullable<Context["tools"]>,
  compat: ReturnType<typeof getCompat>,
  model: OpenAIModeModel,
) {
  const strict = resolveOpenAIStrictToolFlagForInventory(
    tools,
    resolveOpenAIStrictToolSetting(model, {
      transport: "stream",
      supportsStrictMode: compat?.supportsStrictMode,
    }),
  );
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeOpenAIStrictToolParameters(tool.parameters, strict === true),
      ...(strict === undefined ? {} : { strict }),
    },
  }));
}

export function buildOpenAICompletionsParams(
  model: OpenAIModeModel,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
) {
  const compat = getCompat(model);
  const completionsContext = context.systemPrompt
    ? {
        ...context,
        systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt),
      }
    : context;
  const params: Record<string, unknown> = {
    model: model.id,
    messages: convertMessages(model as never, completionsContext, compat as never),
    stream: true,
  };
  if (compat.supportsUsageInStreaming) {
    params.stream_options = { include_usage: true };
  }
  if (compat.supportsStore) {
    params.store = false;
  }
  if (options?.maxTokens) {
    if (compat.maxTokensField === "max_tokens") {
      params.max_tokens = options.maxTokens;
    } else {
      params.max_completion_tokens = options.maxTokens;
    }
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (context.tools) {
    params.tools = convertTools(context.tools, compat, model);
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }
  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }
  if (compat.thinkingFormat === "openrouter" && model.reasoning && options?.reasoningEffort) {
    const wire = mapReasoningEffort(options.reasoningEffort, compat.reasoningEffortMap);
    if (wire) {
      params.reasoning = { effort: wire };
    }
  } else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    const wire = mapReasoningEffort(options.reasoningEffort, compat.reasoningEffortMap);
    if (wire) {
      params.reasoning_effort = wire;
    }
  }
  return params;
}

export function parseTransportChunkUsage(
  rawUsage: NonNullable<ChatCompletionChunk["usage"]>,
  model: Model<Api>,
) {
  const cachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
  const promptTokens = rawUsage.prompt_tokens || 0;
  const input = Math.max(0, promptTokens - cachedTokens);
  const outputTokens = rawUsage.completion_tokens || 0;
  const usage = {
    input,
    output: outputTokens,
    cacheRead: cachedTokens,
    cacheWrite: 0,
    totalTokens: input + outputTokens + cachedTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model as never, usage as never);
  return usage;
}

function mapStopReason(reason: string | null) {
  if (reason === null) {
    return { stopReason: "stop" };
  }
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
    default:
      return {
        stopReason: "error",
        errorMessage: `Provider finish_reason: ${reason}`,
      };
  }
}

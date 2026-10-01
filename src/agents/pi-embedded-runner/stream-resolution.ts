import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getCurrentSystemPrompt, normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createBoundaryAwareStreamFnForModel } from "../provider-transport-stream.js";
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  stripSystemPromptCacheBoundary,
} from "../system-prompt-cache-boundary.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let embeddedAgentBaseStreamFnCache = new WeakMap<object, StreamFn | undefined>();

export function resolveEmbeddedAgentBaseStreamFn(params: {
  session: { agent: { streamFunction?: StreamFn } };
}): StreamFn | undefined {
  const cached = embeddedAgentBaseStreamFnCache.get(params.session);
  if (cached !== undefined || embeddedAgentBaseStreamFnCache.has(params.session)) {
    return cached;
  }
  const baseStreamFn = params.session.agent.streamFunction;
  embeddedAgentBaseStreamFnCache.set(params.session, baseStreamFn);
  return baseStreamFn;
}

export function resetEmbeddedAgentBaseStreamFnCacheForTest(): void {
  embeddedAgentBaseStreamFnCache = new WeakMap<object, StreamFn | undefined>();
}

export function describeEmbeddedAgentStreamStrategy(params: {
  currentStreamFn: StreamFn | undefined;
  providerStreamFn?: StreamFn;
  model: EmbeddedRunAttemptParams["model"];
}): string {
  if (params.providerStreamFn) {
    return "provider";
  }
  if (params.currentStreamFn === undefined || params.currentStreamFn === streamSimple) {
    return createBoundaryAwareStreamFnForModel(params.model)
      ? `boundary-aware:${params.model.api}`
      : "stream-simple";
  }
  return "session-custom";
}

export async function resolveEmbeddedAgentApiKey(params: {
  provider: string;
  resolvedApiKey?: string;
  authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
}): Promise<string | undefined> {
  const resolvedApiKey = params.resolvedApiKey?.trim();
  if (resolvedApiKey) {
    return resolvedApiKey;
  }
  return params.authStorage ? await params.authStorage.getApiKey(params.provider) : undefined;
}

export function resolveEmbeddedAgentStreamFn(params: {
  currentStreamFn: StreamFn | undefined;
  providerStreamFn?: StreamFn;
  sessionId: string;
  signal?: AbortSignal;
  model: EmbeddedRunAttemptParams["model"];
  resolvedApiKey?: string;
  authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
}): StreamFn {
  if (params.providerStreamFn) {
    const inner = params.providerStreamFn;
    const stripBoundaryFromContext = (context: Parameters<StreamFn>[1]) => {
      if (!context) return context;
      const raw = context as unknown as { messages?: unknown; systemPrompt?: unknown };
      if (!Array.isArray(raw.messages)) {
        if (
          typeof raw.systemPrompt === "string" &&
          raw.systemPrompt.includes(SYSTEM_PROMPT_CACHE_BOUNDARY)
        ) {
          return {
            ...(context as unknown as Record<string, unknown>),
            systemPrompt: stripSystemPromptCacheBoundary(raw.systemPrompt),
          } as unknown as Parameters<StreamFn>[1];
        }
        return context;
      }
      const transcript = normalizeContext(context);
      if (!transcript || !Array.isArray(transcript.messages)) return transcript;
      const [head, ...rest] = transcript.messages;
      if (!head || head.role !== "system") {
        return transcript;
      }
      const text = getCurrentSystemPrompt([head]);
      if (!text.includes(SYSTEM_PROMPT_CACHE_BOUNDARY)) {
        return transcript;
      }
      const stripped =
        typeof head.content === "string"
          ? stripSystemPromptCacheBoundary(head.content)
          : Array.isArray(head.content)
            ? head.content.map((part) =>
                part.type === "text"
                  ? { ...part, text: stripSystemPromptCacheBoundary(part.text) }
                  : part,
              )
            : head.content;
      return { ...transcript, messages: [{ ...head, content: stripped }, ...rest] };
    };
    // Provider-owned transports bypass pi-coding-agent's default auth lookup,
    // so keep injecting the resolved runtime apiKey for streamSimple-compatible
    // transports that still read credentials from options.apiKey.
    if (params.authStorage || params.resolvedApiKey) {
      const { authStorage, model, resolvedApiKey } = params;
      return async (m, context, options) => {
        const apiKey = await resolveEmbeddedAgentApiKey({
          provider: model.provider,
          resolvedApiKey,
          authStorage,
        });
        return inner(m, stripBoundaryFromContext(context), {
          ...options,
          apiKey: apiKey ?? options?.apiKey,
        });
      };
    }
    return (m, context, options) => inner(m, stripBoundaryFromContext(context), options);
  }

  const currentStreamFn = params.currentStreamFn ?? streamSimple;

  if (params.currentStreamFn === undefined || params.currentStreamFn === streamSimple) {
    const boundaryAwareStreamFn = createBoundaryAwareStreamFnForModel(params.model);
    if (boundaryAwareStreamFn) {
      return boundaryAwareStreamFn;
    }
  }

  return currentStreamFn;
}

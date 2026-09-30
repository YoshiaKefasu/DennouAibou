import type { Model } from "@earendil-works/pi-ai";
import type { ProviderEndpointClass, ProviderRequestCapabilities } from "./provider-attribution.js";
import { resolveProviderRequestCapabilities } from "./provider-attribution.js";

type OpenAICompletionsCompatDefaultsInput = {
  provider?: string;
  endpointClass: ProviderEndpointClass;
  knownProviderFamily: string;
  supportsNativeStreamingUsageCompat?: boolean;
  usesExplicitProxyLikeEndpoint?: boolean;
};

export type OpenAICompletionsCompatDefaults = {
  supportsStore: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  supportsUsageInStreaming: boolean;
  maxTokensField: "max_completion_tokens" | "max_tokens";
  // Note: "openrouter" / "zai" members are kept for persisted-config
  // compat (config/io.ts warns on removed thinkingFormat values instead of
  // crashing). Runtime detection below always resolves to "openai" —
  // DEBLOAT §23.2 candidate 15 converged provider-specific branches to the
  // default behavior.
  thinkingFormat: "openai" | "openrouter" | "zai";
  supportsStrictMode: boolean;
};

export type DetectedOpenAICompletionsCompat = {
  capabilities: ProviderRequestCapabilities;
  defaults: OpenAICompletionsCompatDefaults;
};

function isDefaultRouteProvider(provider: string | undefined, ...ids: string[]) {
  return provider !== undefined && ids.includes(provider);
}

export function resolveOpenAICompletionsCompatDefaults(
  input: OpenAICompletionsCompatDefaultsInput,
): OpenAICompletionsCompatDefaults {
  const {
    endpointClass,
    knownProviderFamily,
    supportsNativeStreamingUsageCompat = false,
    usesExplicitProxyLikeEndpoint = false,
  } = input;
  const isDefaultRoute = endpointClass === "default";
  const usesConfiguredNonOpenAIEndpoint =
    endpointClass !== "default" && endpointClass !== "openai-public";
  const isMoonshotLike =
    knownProviderFamily === "moonshot" ||
    knownProviderFamily === "modelstudio" ||
    endpointClass === "moonshot-native" ||
    endpointClass === "modelstudio-native";
  const isNonStandard =
    endpointClass === "cerebras-native" ||
    endpointClass === "chutes-native" ||
    endpointClass === "deepseek-native" ||
    endpointClass === "mistral-public" ||
    endpointClass === "opencode-native" ||
    endpointClass === "xai-native" ||
    (isDefaultRoute &&
      isDefaultRouteProvider(input.provider, "cerebras", "chutes", "deepseek", "opencode", "xai"));
  const usesMaxTokens =
    endpointClass === "chutes-native" ||
    endpointClass === "mistral-public" ||
    knownProviderFamily === "mistral" ||
    (isDefaultRoute && isDefaultRouteProvider(input.provider, "chutes"));

  return {
    supportsStore:
      !isNonStandard && knownProviderFamily !== "mistral" && !usesExplicitProxyLikeEndpoint,
    supportsDeveloperRole: !isNonStandard && !isMoonshotLike && !usesConfiguredNonOpenAIEndpoint,
    supportsReasoningEffort:
      knownProviderFamily !== "mistral" &&
      endpointClass !== "xai-native" &&
      !usesExplicitProxyLikeEndpoint,
    supportsUsageInStreaming:
      !isNonStandard && (!usesConfiguredNonOpenAIEndpoint || supportsNativeStreamingUsageCompat),
    maxTokensField: usesMaxTokens ? "max_tokens" : "max_completion_tokens",
    thinkingFormat: "openai",
    supportsStrictMode: !usesConfiguredNonOpenAIEndpoint,
  };
}

export function resolveOpenAICompletionsCompatDefaultsFromCapabilities(
  input: Pick<
    ProviderRequestCapabilities,
    | "endpointClass"
    | "knownProviderFamily"
    | "supportsNativeStreamingUsageCompat"
    | "usesExplicitProxyLikeEndpoint"
  > & {
    provider?: string;
  },
): OpenAICompletionsCompatDefaults {
  return resolveOpenAICompletionsCompatDefaults(input);
}

export function detectOpenAICompletionsCompat(
  model: Pick<Model<"openai-completions">, "provider" | "baseUrl" | "id" | "compat">,
): DetectedOpenAICompletionsCompat {
  const capabilities = resolveProviderRequestCapabilities({
    provider: model.provider,
    api: "openai-completions",
    baseUrl: model.baseUrl,
    capability: "llm",
    transport: "stream",
    modelId: model.id,
    compat:
      model.compat && typeof model.compat === "object"
        ? (model.compat as { supportsStore?: boolean })
        : undefined,
  });
  return {
    capabilities,
    defaults: resolveOpenAICompletionsCompatDefaultsFromCapabilities({
      provider: model.provider,
      ...capabilities,
    }),
  };
}

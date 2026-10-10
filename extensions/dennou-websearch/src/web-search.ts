import { asSchemaJson } from "../../../src/agents/schema/typebox.js";
import type { AnyAgentTool } from "../../../src/agents/tools/common.js";
import { jsonResult, textResult } from "../../../src/agents/tools/common.js";
import { SEARCH_CACHE } from "../../../src/agents/tools/web-search-provider-common.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { resolveManifestContractOwnerPluginId } from "../../../src/plugins/manifest-registry.js";
import { getActiveRuntimeWebToolsMetadata } from "../../../src/secrets/runtime-web-tools-state.js";
import type { RuntimeWebSearchMetadata } from "../../../src/secrets/runtime-web-tools.types.js";
import {
  resolveWebSearchDefinition,
  resolveWebSearchProviderId,
} from "../../../src/web-search/runtime.js";
import { resolveSummarizerConfig, summarizeSearchResults } from "./web-search-summarizer.js";

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): AnyAgentTool | null {
  // Fall back to active global runtime metadata so preferRuntimeProviders
  // reflects it even when the caller passes no runtimeWebSearch (e.g. plugin registration).
  const runtimeWebSearch = options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
  const runtimeProviderId =
    runtimeWebSearch?.selectedProvider ?? runtimeWebSearch?.providerConfigured;
  const resolved = resolveWebSearchDefinition({
    ...options,
    runtimeWebSearch,
    preferRuntimeProviders:
      Boolean(runtimeProviderId) &&
      !resolveManifestContractOwnerPluginId({
        contract: "webSearchProviders",
        value: runtimeProviderId,
        origin: "bundled",
        config: options?.config,
      }),
  });
  if (!resolved) {
    return null;
  }

  return {
    label: "Web Search",
    name: "web_search",
    description: resolved.definition.description,
    parameters: asSchemaJson(resolved.definition.parameters),
    execute: async (_toolCallId, rawArgs) => {
      const raw = await resolved.definition.execute(rawArgs as Record<string, unknown>);
      const args =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      try {
        const summarized = await summarizeSearchResults(
          raw,
          typeof args.query === "string" ? args.query : "",
          resolveSummarizerConfig(options?.config),
        );
        if (typeof summarized === "string") {
          // Note: contentは要約テキスト、detailsは従来どおり生ペイロードを保持する。
          return textResult(summarized, raw);
        }
      } catch {
        // フェイルオープン：要約経路の異常は生結果にフォールバックする。
      }
      return jsonResult(raw);
    },
  };
}

export const __testing = {
  SEARCH_CACHE,
  resolveSearchProvider: (search?: Parameters<typeof resolveWebSearchProviderId>[0]["search"]) =>
    resolveWebSearchProviderId({ search }),
};

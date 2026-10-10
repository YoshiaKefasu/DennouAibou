import { asSchemaJson } from "../../../src/agents/schema/typebox.js";
import type { AnyAgentTool } from "../../../src/agents/tools/common.js";
import { jsonResult } from "../../../src/agents/tools/common.js";
import { SEARCH_CACHE } from "../../../src/agents/tools/web-search-provider-common.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { resolveManifestContractOwnerPluginId } from "../../../src/plugins/manifest-registry.js";
import { getActiveRuntimeWebToolsMetadata } from "../../../src/secrets/runtime-web-tools-state.js";
import type { RuntimeWebSearchMetadata } from "../../../src/secrets/runtime-web-tools.types.js";
import {
  resolveWebSearchDefinition,
  resolveWebSearchProviderId,
} from "../../../src/web-search/runtime.js";

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
    execute: async (_toolCallId, rawArgs) =>
      jsonResult(await resolved.definition.execute(rawArgs as Record<string, unknown>)),
  };
}

export const __testing = {
  SEARCH_CACHE,
  resolveSearchProvider: (search?: Parameters<typeof resolveWebSearchProviderId>[0]["search"]) =>
    resolveWebSearchProviderId({ search }),
};

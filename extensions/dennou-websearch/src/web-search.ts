import { asSchemaJson } from "../../../src/agents/schema/typebox.js";
import type { AnyAgentTool } from "../../../src/agents/tools/common.js";
import { jsonResult } from "../../../src/agents/tools/common.js";
import { SEARCH_CACHE } from "../../../src/agents/tools/web-search-provider-common.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { resolveManifestContractOwnerPluginId } from "../../../src/plugins/manifest-registry.js";
import type { RuntimeWebSearchMetadata } from "../../../src/secrets/runtime-web-tools.types.js";
import {
  resolveWebSearchDefinition,
  resolveWebSearchProviderId,
} from "../../../src/web-search/runtime.js";

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): AnyAgentTool | null {
  const runtimeProviderId =
    options?.runtimeWebSearch?.selectedProvider ?? options?.runtimeWebSearch?.providerConfigured;
  const resolved = resolveWebSearchDefinition({
    ...options,
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

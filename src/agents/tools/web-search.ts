import type { OpenClawConfig } from "../../config/config.js";
import { asSchemaJson } from "../schema/typebox.js";
import { resolveManifestContractOwnerPluginId } from "../../plugins/manifest-registry.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import {
  resolveWebSearchDefinition,
  resolveWebSearchProviderId,
} from "../../web-search/runtime.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { SEARCH_CACHE } from "./web-search-provider-common.js";

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
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
      jsonResult(
        await resolved.definition.execute(
          rawArgs as Record<string, unknown>,
        ),
      ),
  };
}

export const __testing = {
  SEARCH_CACHE,
  resolveSearchProvider: (search?: Parameters<typeof resolveWebSearchProviderId>[0]["search"]) =>
    resolveWebSearchProviderId({ search }),
};

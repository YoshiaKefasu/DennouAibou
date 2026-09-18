import type { OpenClawConfig } from "../config/config.js";
import { resolveRuntimePluginRegistry } from "../plugins/loader.js";
import { resolveUserPath } from "../utils.js";

/**
 * Injectable seams for tests. Defaults mirror production so callers keep the
 * existing behaviour.
 */
export type RuntimePluginsDeps = {
  resolveRuntimePluginRegistry?: typeof resolveRuntimePluginRegistry;
  resolveUserPath?: typeof resolveUserPath;
};

export function ensureRuntimePluginsLoaded(
  params: {
    config?: OpenClawConfig;
    workspaceDir?: string | null;
    allowGatewaySubagentBinding?: boolean;
  },
  deps: RuntimePluginsDeps = {},
): void {
  const resolvePath = deps.resolveUserPath ?? resolveUserPath;
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolvePath(params.workspaceDir)
      : undefined;
  const loadOptions = {
    config: params.config,
    workspaceDir,
    runtimeOptions: params.allowGatewaySubagentBinding
      ? {
          allowGatewaySubagentBinding: true,
        }
      : undefined,
  };
  (deps.resolveRuntimePluginRegistry ?? resolveRuntimePluginRegistry)(loadOptions);
}

import { isTruthyEnvValue } from "../infra/env.js";
import { loggingState } from "../logging/state.js";
import { defaultRuntime } from "../runtime.js";
import { getCommandPathWithRootOptions, hasFlag, hasHelpOrVersion } from "./argv.js";
import { findRoutedCommand } from "./program/routes.js";

/**
 * Injectable seams for the routed-command boundaries this module lazily loads.
 * Tests supply fixtures instead of intercepting the lazily imported modules at
 * module level, which Bun's runner does not support.
 */
export type RouteCliDeps = {
  runtime?: typeof defaultRuntime;
  findRoutedCommand?: typeof findRoutedCommand;
  ensureConfigReady?: typeof import("./program/config-guard.js").ensureConfigReady;
  ensurePluginRegistryLoaded?: typeof import("./plugin-registry.js").ensurePluginRegistryLoaded;
  /** Banner emission seam. Defaults to lazily importing the banner module. */
  emitBanner?: (argv: string[]) => void | Promise<void>;
};

async function prepareRoutedCommand(
  params: {
    argv: string[];
    commandPath: string[];
    loadPlugins?: boolean | ((argv: string[]) => boolean);
  },
  deps: RouteCliDeps = {},
) {
  const runtime = deps.runtime ?? defaultRuntime;
  const suppressDoctorStdout = hasFlag(params.argv, "--json");
  const skipConfigGuard =
    (params.commandPath[0] === "status" && suppressDoctorStdout) ||
    (params.commandPath[0] === "gateway" && params.commandPath[1] === "status");
  if (!suppressDoctorStdout && process.stdout.isTTY) {
    const emitBanner =
      deps.emitBanner ??
      (async (argv: string[]) => {
        const [{ emitCliBanner }, { VERSION }] = await Promise.all([
          import("./banner.js"),
          import("../version.js"),
        ]);
        emitCliBanner(VERSION, { argv });
      });
    await emitBanner(params.argv);
  }
  if (!skipConfigGuard) {
    const ensureConfigReady =
      deps.ensureConfigReady ?? (await import("./program/config-guard.js")).ensureConfigReady;
    await ensureConfigReady({
      runtime,
      commandPath: params.commandPath,
      ...(suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
    });
  }
  const shouldLoadPlugins =
    typeof params.loadPlugins === "function" ? params.loadPlugins(params.argv) : params.loadPlugins;
  if (shouldLoadPlugins) {
    const ensurePluginRegistryLoaded =
      deps.ensurePluginRegistryLoaded ??
      (await import("./plugin-registry.js")).ensurePluginRegistryLoaded;
    const prev = loggingState.forceConsoleToStderr;
    if (suppressDoctorStdout) {
      loggingState.forceConsoleToStderr = true;
    }
    try {
      ensurePluginRegistryLoaded({
        scope:
          params.commandPath[0] === "status" || params.commandPath[0] === "health"
            ? "channels"
            : "all",
      });
    } finally {
      loggingState.forceConsoleToStderr = prev;
    }
  }
}

export async function tryRouteCli(argv: string[], deps: RouteCliDeps = {}): Promise<boolean> {
  if (isTruthyEnvValue(process.env.DENNOU_DISABLE_ROUTE_FIRST)) {
    return false;
  }
  if (hasHelpOrVersion(argv)) {
    return false;
  }

  const path = getCommandPathWithRootOptions(argv, 2);
  if (!path[0]) {
    return false;
  }
  const findRoutedCommandImpl = deps.findRoutedCommand ?? findRoutedCommand;
  const route = findRoutedCommandImpl(path);
  if (!route) {
    return false;
  }
  await prepareRoutedCommand({ argv, commandPath: path, loadPlugins: route.loadPlugins }, deps);
  return route.run(argv);
}

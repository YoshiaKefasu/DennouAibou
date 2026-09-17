import type { OpenClawConfig } from "../config/config.js";
import { STATE_DIR } from "../config/paths.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "./registry.js";
import type { OpenClawPluginServiceContext, PluginLogger } from "./types.js";

function createPluginLogger(log: SubsystemLogger): PluginLogger {
  return {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
    debug: (msg) => log.debug(msg),
  };
}

function createServiceContext(
  params: {
    config: OpenClawConfig;
    workspaceDir?: string;
  },
  log: SubsystemLogger,
): OpenClawPluginServiceContext {
  return {
    config: params.config,
    workspaceDir: params.workspaceDir,
    stateDir: STATE_DIR,
    logger: createPluginLogger(log),
  };
}

export type PluginServicesHandle = {
  stop: () => Promise<void>;
};

/**
 * Injectable seams for plugin service startup. Defaults resolve to the real
 * subsystem logger factory so production callers stay unchanged.
 */
export type PluginServicesDeps = {
  createSubsystemLogger: typeof createSubsystemLogger;
};

export async function startPluginServices(
  params: {
    registry: PluginRegistry;
    config: OpenClawConfig;
    workspaceDir?: string;
  },
  deps?: Partial<PluginServicesDeps>,
): Promise<PluginServicesHandle> {
  const log = (deps?.createSubsystemLogger ?? createSubsystemLogger)("plugins");
  const running: Array<{
    id: string;
    stop?: () => void | Promise<void>;
  }> = [];
  const serviceContext = createServiceContext(
    {
      config: params.config,
      workspaceDir: params.workspaceDir,
    },
    log,
  );

  for (const entry of params.registry.services) {
    const service = entry.service;
    try {
      await service.start(serviceContext);
      running.push({
        id: service.id,
        stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
      });
    } catch (err) {
      const error = err as Error;
      const stack = error?.stack?.trim();
      log.error(
        `plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}${stack ? `\n${stack}` : ""}`,
      );
    }
  }

  return {
    stop: async () => {
      for (const entry of running.toReversed()) {
        if (!entry.stop) {
          continue;
        }
        try {
          await entry.stop();
        } catch (err) {
          log.warn(`plugin service stop failed (${entry.id}): ${String(err)}`);
        }
      }
    },
  };
}

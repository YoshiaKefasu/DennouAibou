import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";
import { tryRouteCli, type RouteCliDeps } from "./route.js";

const findRoutedCommand = vi.fn();
const ensureConfigReady = vi.fn(async () => {});
const ensurePluginRegistryLoaded = vi.fn();
const runRoute = vi.fn(async () => true);

const runtime = {
  error: vi.fn(),
  log: vi.fn(),
  exit: vi.fn(),
  writeStdout: vi.fn(),
  writeJson: vi.fn(),
};

/**
 * Inject the routed-command boundaries instead of mocking the lazily imported
 * modules at module level.
 */
function createDeps(): RouteCliDeps {
  return {
    runtime: runtime as unknown as RouteCliDeps["runtime"],
    findRoutedCommand: findRoutedCommand as unknown as RouteCliDeps["findRoutedCommand"],
    ensureConfigReady: ensureConfigReady as unknown as RouteCliDeps["ensureConfigReady"],
    ensurePluginRegistryLoaded:
      ensurePluginRegistryLoaded as unknown as RouteCliDeps["ensurePluginRegistryLoaded"],
    emitBanner: () => {},
  };
}

describe("tryRouteCli", () => {
  let originalDisableRouteFirst: string | undefined;
  let originalForceStderr: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    originalDisableRouteFirst = process.env.DENNOU_DISABLE_ROUTE_FIRST;
    delete process.env.DENNOU_DISABLE_ROUTE_FIRST;
    originalForceStderr = loggingState.forceConsoleToStderr;
    loggingState.forceConsoleToStderr = false;
    findRoutedCommand.mockReturnValue({
      loadPlugins: (argv: string[]) => !argv.includes("--json"),
      run: runRoute,
    });
  });

  afterEach(() => {
    loggingState.forceConsoleToStderr = originalForceStderr;
    if (originalDisableRouteFirst === undefined) {
      delete process.env.DENNOU_DISABLE_ROUTE_FIRST;
    } else {
      process.env.DENNOU_DISABLE_ROUTE_FIRST = originalDisableRouteFirst;
    }
  });

  it("skips config guard for routed status --json commands", async () => {
    await expect(tryRouteCli(["node", "openclaw", "status", "--json"], createDeps())).resolves.toBe(
      true,
    );

    expect(ensureConfigReady).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoaded).not.toHaveBeenCalled();
  });

  it("does not pass suppressDoctorStdout for routed non-json commands", async () => {
    await expect(tryRouteCli(["node", "openclaw", "status"], createDeps())).resolves.toBe(true);

    expect(ensureConfigReady).toHaveBeenCalledWith({
      runtime: expect.any(Object),
      commandPath: ["status"],
    });
    expect(ensurePluginRegistryLoaded).toHaveBeenCalledWith({ scope: "channels" });
  });

  it("routes logs to stderr during plugin loading in --json mode and restores after", async () => {
    findRoutedCommand.mockReturnValue({
      loadPlugins: true,
      run: runRoute,
    });

    const captured: boolean[] = [];
    ensurePluginRegistryLoaded.mockImplementation(() => {
      captured.push(loggingState.forceConsoleToStderr);
    });

    await tryRouteCli(["node", "openclaw", "agents", "--json"], createDeps());

    expect(ensurePluginRegistryLoaded).toHaveBeenCalled();
    expect(captured[0]).toBe(true);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("does not route logs to stderr during plugin loading without --json", async () => {
    findRoutedCommand.mockReturnValue({
      loadPlugins: true,
      run: runRoute,
    });

    const captured: boolean[] = [];
    ensurePluginRegistryLoaded.mockImplementation(() => {
      captured.push(loggingState.forceConsoleToStderr);
    });

    await tryRouteCli(["node", "openclaw", "agents"], createDeps());

    expect(ensurePluginRegistryLoaded).toHaveBeenCalled();
    expect(captured[0]).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("routes status when root options precede the command", async () => {
    await expect(
      tryRouteCli(["node", "openclaw", "--log-level", "debug", "status"], createDeps()),
    ).resolves.toBe(true);

    expect(findRoutedCommand).toHaveBeenCalledWith(["status"]);
    expect(ensureConfigReady).toHaveBeenCalledWith({
      runtime: expect.any(Object),
      commandPath: ["status"],
    });
    expect(ensurePluginRegistryLoaded).toHaveBeenCalledWith({ scope: "channels" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureRuntimePluginsLoaded } from "./runtime-plugins.js";

const resolveRuntimePluginRegistry = vi.fn();
// Keep the expectations independent of the host platform's path resolution.
const resolveUserPath = (value: string) => value;

const deps = { resolveRuntimePluginRegistry, resolveUserPath };

describe("ensureRuntimePluginsLoaded", () => {
  beforeEach(() => {
    resolveRuntimePluginRegistry.mockReset();
    resolveRuntimePluginRegistry.mockReturnValue(undefined);
  });

  it("does not reactivate plugins when a process already has an active registry", async () => {
    resolveRuntimePluginRegistry.mockReturnValue({});

    ensureRuntimePluginsLoaded(
      {
        config: {} as never,
        workspaceDir: "/tmp/workspace",
        allowGatewaySubagentBinding: true,
      },
      deps,
    );

    expect(resolveRuntimePluginRegistry).toHaveBeenCalledTimes(1);
  });

  it("resolves runtime plugins through the shared runtime helper", async () => {
    ensureRuntimePluginsLoaded(
      {
        config: {} as never,
        workspaceDir: "/tmp/workspace",
        allowGatewaySubagentBinding: true,
      },
      deps,
    );

    expect(resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });
});

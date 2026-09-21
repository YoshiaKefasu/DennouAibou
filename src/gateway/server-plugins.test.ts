import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "../plugins/runtime-state.js";
import {
  getActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginIdScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { clearGatewaySubagentRuntime, createPluginRuntime } from "../plugins/runtime/index.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { PluginDiagnostic } from "../plugins/types.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import {
  loadGatewayStartupPlugins,
  prepareGatewayPluginLoad,
  reloadDeferredGatewayPlugins,
  type GatewayPluginBootstrapDeps,
} from "./server-plugin-bootstrap.js";
import {
  __testing as serverPluginsTesting,
  loadGatewayPlugins,
  setFallbackGatewayContext,
  setFallbackGatewayContextResolver,
} from "./server-plugins.js";

const loadOpenClawPlugins = vi.fn();
const resolveGatewayStartupPluginIds = vi.fn(() => ["discord", "telegram"]);
const applyPluginAutoEnable = vi.fn(({ config }) => ({
  config,
  changes: [],
  autoEnabledReasons: {},
}));
const primeConfiguredBindingRegistryMock = vi.fn(() => ({ bindingCount: 0, channelCount: 0 }));
type HandleGatewayRequestOptions = GatewayRequestOptions & {
  extraHandlers?: Record<string, unknown>;
};
const handleGatewayRequest = vi.fn(async (_opts: HandleGatewayRequestOptions) => {});

const bootstrapDeps: GatewayPluginBootstrapDeps = {
  applyPluginAutoEnable,
  primeConfiguredBindingRegistry: primeConfiguredBindingRegistryMock,
};

const createRegistry = (diagnostics: PluginDiagnostic[]): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [],
  channelSetups: [],
  commands: [],
  providers: [],
  realtimeTranscriptionProviders: [],
  realtimeVoiceProviders: [],
  mediaUnderstandingProviders: [],
  imageGenerationProviders: [],
  musicGenerationProviders: [],
  videoGenerationProviders: [],
  webFetchProviders: [],
  webSearchProviders: [],
  memoryEmbeddingProviders: [],
  gatewayHandlers: {},
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  conversationBindingResolvedHandlers: [],
  diagnostics,
});

function createTestLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createTestContext(label: string): GatewayRequestContext {
  return { label } as unknown as GatewayRequestContext;
}

function getLastDispatchedContext(): GatewayRequestContext | undefined {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  return call?.context;
}

function getLastDispatchedParams(): Record<string, unknown> | undefined {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  return call?.req?.params as Record<string, unknown> | undefined;
}

function getLastDispatchedClientScopes(): string[] {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  const scopes = call?.client?.connect?.scopes;
  return Array.isArray(scopes) ? scopes : [];
}

async function createSubagentRuntime(
  cfg: Record<string, unknown> = {},
  _serverPlugins?: unknown,
): Promise<PluginRuntime["subagent"]> {
  const log = createTestLog();
  loadOpenClawPlugins.mockReturnValue(createRegistry([]));
  loadGatewayStartupPlugins({
    cfg,
    workspaceDir: "/tmp",
    log,
    coreGatewayHandlers: {},
    baseMethods: [],
    deps: bootstrapDeps,
  });
  const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0] as
    | { runtimeOptions?: { allowGatewaySubagentBinding?: boolean } }
    | undefined;
  if (call?.runtimeOptions?.allowGatewaySubagentBinding !== true) {
    throw new Error("Expected loadGatewayPlugins to opt into gateway subagent binding");
  }
  return createPluginRuntime({ allowGatewaySubagentBinding: true }).subagent;
}

function loadGatewayPluginsForTest(
  overrides: Partial<Parameters<typeof loadGatewayPlugins>[0]> = {},
) {
  const log = createTestLog();
  loadGatewayPlugins({
    cfg: {},
    workspaceDir: "/tmp",
    log,
    coreGatewayHandlers: {},
    baseMethods: [],
    ...overrides,
  });
  return log;
}

function loadGatewayStartupPluginsForTest(
  overrides: Partial<Parameters<typeof loadGatewayStartupPlugins>[0]> = {},
) {
  const log = createTestLog();
  loadGatewayStartupPlugins({
    cfg: {},
    workspaceDir: "/tmp",
    log,
    coreGatewayHandlers: {},
    baseMethods: [],
    deps: bootstrapDeps,
    ...overrides,
  });
  return log;
}

beforeEach(() => {
  loadOpenClawPlugins.mockReset();
  resolveGatewayStartupPluginIds.mockReset().mockReturnValue(["discord", "telegram"]);
  applyPluginAutoEnable
    .mockReset()
    .mockImplementation(({ config }) => ({ config, changes: [], autoEnabledReasons: {} }));
  primeConfiguredBindingRegistryMock
    .mockClear()
    .mockReturnValue({ bindingCount: 0, channelCount: 0 });
  handleGatewayRequest.mockReset();
  serverPluginsTesting.setDepsForTests({
    loadOpenClawPlugins,
    applyPluginAutoEnable,
    resolveGatewayStartupPluginIds,
    handleGatewayRequest,
  });
  clearGatewaySubagentRuntime();
  handleGatewayRequest.mockImplementation(async (opts: HandleGatewayRequestOptions) => {
    switch (opts.req.method) {
      case "agent":
        opts.respond(true, { runId: "run-1" });
        return;
      case "agent.wait":
        opts.respond(true, { status: "ok" });
        return;
      case "sessions.get":
        opts.respond(true, { messages: [] });
        return;
      case "sessions.delete":
        opts.respond(true, {});
        return;
      default:
        opts.respond(true, {});
    }
  });
});

afterEach(() => {
  clearGatewaySubagentRuntime();
  resetPluginRuntimeStateForTest();
  serverPluginsTesting.resetDepsForTests();
});

describe("loadGatewayPlugins", () => {
  test("logs plugin errors with details", async () => {
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "error",
        pluginId: "telegram",
        source: "/tmp/telegram/index.ts",
        message: "failed to load plugin: boom",
      },
    ];
    loadOpenClawPlugins.mockReturnValue(createRegistry(diagnostics));
    const log = loadGatewayStartupPluginsForTest();

    expect(log.error).toHaveBeenCalledWith(
      "[plugins] failed to load plugin: boom (plugin=telegram, source=/tmp/telegram/index.ts)",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("loads only gateway startup plugin ids", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayPluginsForTest();

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    expect(resolveGatewayStartupPluginIds).toHaveBeenCalledWith({
      config: {},
      activationSourceConfig: undefined,
      workspaceDir: "/tmp",
      env: process.env,
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["discord", "telegram"],
      }),
    );
  });

  test("reuses the provided startup plugin scope without recomputing it", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayPluginsForTest({
      pluginIds: ["browser"],
    });

    expect(resolveGatewayStartupPluginIds).not.toHaveBeenCalled();
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["browser"],
      }),
    );
  });

  test("pins the initial startup channel registry against later active-registry churn", async () => {
    const startupRegistry = createRegistry([]);
    loadOpenClawPlugins.mockReturnValue(startupRegistry);

    loadGatewayStartupPluginsForTest({
      pluginIds: ["slack"],
    });

    const replacementRegistry = createRegistry([]);
    setActivePluginRegistry(replacementRegistry);

    expect(getActivePluginChannelRegistry()).toBe(startupRegistry);
  });

  test("keeps the raw activation source when a precomputed startup scope is reused", async () => {
    const rawConfig = { channels: { slack: { botToken: "x" } } };
    const resolvedConfig = {
      channels: { slack: { botToken: "x", enabled: true } },
      autoEnabled: true,
    };
    applyPluginAutoEnable.mockReturnValue({
      config: resolvedConfig,
      changes: [],
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
    });
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayStartupPluginsForTest({
      cfg: resolvedConfig,
      activationSourceConfig: rawConfig,
      pluginIds: ["slack"],
    });

    expect(resolveGatewayStartupPluginIds).not.toHaveBeenCalled();
    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: rawConfig,
      env: process.env,
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
        activationSourceConfig: rawConfig,
        onlyPluginIds: ["slack"],
        autoEnabledReasons: {
          slack: ["slack configured"],
        },
      }),
    );
  });

  test("treats an empty startup scope as no plugin load instead of an unscoped load", async () => {
    resolveGatewayStartupPluginIds.mockReturnValue([]);

    const result = loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log: createTestLog(),
      coreGatewayHandlers: {},
      baseMethods: ["sessions.get"],
    });

    expect(loadOpenClawPlugins).not.toHaveBeenCalled();
    expect(result.pluginRegistry.plugins).toEqual([]);
    expect(result.gatewayMethods).toEqual(["sessions.get"]);
  });

  test("stores workspaceDir on the active registry when startup scope is empty", () => {
    resolveGatewayStartupPluginIds.mockReturnValue([]);

    loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp/gateway-workspace",
      log: createTestLog(),
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/tmp/gateway-workspace");
  });

  test("loads gateway plugins from the auto-enabled config snapshot", async () => {
    const autoEnabledConfig = { channels: { slack: { enabled: true } }, autoEnabled: true };
    applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
    });
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayPluginsForTest();

    expect(resolveGatewayStartupPluginIds).toHaveBeenCalledWith({
      config: autoEnabledConfig,
      activationSourceConfig: undefined,
      workspaceDir: "/tmp",
      env: process.env,
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
        activationSourceConfig: {},
        autoEnabledReasons: {
          slack: ["slack configured"],
        },
      }),
    );
  });

  test("re-derives auto-enable reasons when only activationSourceConfig is provided", async () => {
    const rawConfig = { channels: { slack: { enabled: true } } };
    const resolvedConfig = { channels: { slack: { enabled: true } }, autoEnabled: true };
    applyPluginAutoEnable.mockReturnValue({
      config: resolvedConfig,
      changes: [],
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
    });
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayPluginsForTest({
      cfg: resolvedConfig,
      activationSourceConfig: rawConfig,
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: rawConfig,
      env: process.env,
    });
    expect(resolveGatewayStartupPluginIds).toHaveBeenCalledWith({
      config: resolvedConfig,
      activationSourceConfig: rawConfig,
      workspaceDir: "/tmp",
      env: process.env,
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
        activationSourceConfig: rawConfig,
        autoEnabledReasons: {
          slack: ["slack configured"],
        },
      }),
    );
  });

  test("provides subagent runtime with sessions.get method aliases", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayPluginsForTest();

    const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0] as
      | { runtimeOptions?: { allowGatewaySubagentBinding?: boolean } }
      | undefined;
    expect(call?.runtimeOptions?.allowGatewaySubagentBinding).toBe(true);
    const subagent = createPluginRuntime({
      allowGatewaySubagentBinding: true,
    }).subagent;
    expect(typeof subagent?.getSessionMessages).toBe("function");
    expect(typeof subagent?.getSession).toBe("function");
  });

  test("forwards provider and model overrides when the request scope is authorized", async () => {
    const runtime = await createSubagentRuntime();
    const scope = {
      context: createTestContext("request-scope-forward-overrides"),
      client: {
        connect: {
          scopes: ["operator.admin"],
        },
      } as GatewayRequestOptions["client"],
      isWebchatConnect: () => false,
    } satisfies PluginRuntimeGatewayRequestScope;

    await withPluginRuntimeGatewayRequestScope(scope, () =>
      runtime.run({
        sessionKey: "s-override",
        message: "use the override",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        deliver: false,
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      sessionKey: "s-override",
      message: "use the override",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      deliver: false,
    });
  });

  test("rejects provider/model overrides for fallback runs without explicit authorization", async () => {
    const runtime = await createSubagentRuntime();
    setFallbackGatewayContext(createTestContext("fallback-deny-overrides"));

    await expect(
      runtime.run({
        sessionKey: "s-fallback-override",
        message: "use the override",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        deliver: false,
      }),
    ).rejects.toThrow(
      "provider/model override requires plugin identity in fallback subagent runs.",
    );
  });

  test("allows trusted fallback provider/model overrides when plugin config is explicit", async () => {
    const runtime = await createSubagentRuntime({
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic/claude-haiku-4-5"],
            },
          },
        },
      },
    });
    setFallbackGatewayContext(createTestContext("fallback-trusted-overrides"));
    await withPluginRuntimePluginIdScope("voice-call", () =>
      runtime.run({
        sessionKey: "s-trusted-override",
        message: "use trusted override",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        deliver: false,
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      sessionKey: "s-trusted-override",
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  test("includes docs guidance when a plugin fallback override is not trusted", async () => {
    const runtime = await createSubagentRuntime();
    setFallbackGatewayContext(createTestContext("fallback-untrusted-plugin"));

    await expect(
      withPluginRuntimePluginIdScope("voice-call", () =>
        runtime.run({
          sessionKey: "s-untrusted-override",
          message: "use untrusted override",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          deliver: false,
        }),
      ),
    ).rejects.toThrow(
      'plugin "voice-call" is not trusted for fallback provider/model override requests. See https://docs.openclaw.ai/tools/plugin#runtime-helpers and search for: plugins.entries.<id>.subagent.allowModelOverride',
    );
  });

  test("allows trusted fallback model-only overrides when the model ref is canonical", async () => {
    const runtime = await createSubagentRuntime({
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic/claude-haiku-4-5"],
            },
          },
        },
      },
    });
    setFallbackGatewayContext(createTestContext("fallback-model-only-override"));
    await withPluginRuntimePluginIdScope("voice-call", () =>
      runtime.run({
        sessionKey: "s-model-only-override",
        message: "use trusted model-only override",
        model: "anthropic/claude-haiku-4-5",
        deliver: false,
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      sessionKey: "s-model-only-override",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(getLastDispatchedParams()).not.toHaveProperty("provider");
  });

  test("rejects trusted fallback overrides when the configured allowlist normalizes to empty", async () => {
    const runtime = await createSubagentRuntime({
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic"],
            },
          },
        },
      },
    });
    setFallbackGatewayContext(createTestContext("fallback-invalid-allowlist"));
    await expect(
      withPluginRuntimePluginIdScope("voice-call", () =>
        runtime.run({
          sessionKey: "s-invalid-allowlist",
          message: "use trusted override",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          deliver: false,
        }),
      ),
    ).rejects.toThrow(
      'plugin "voice-call" configured subagent.allowedModels, but none of the entries normalized to a valid provider/model target.',
    );
  });

  test("uses least-privilege synthetic fallback scopes without admin", async () => {
    const runtime = await createSubagentRuntime();
    setFallbackGatewayContext(createTestContext("synthetic-least-privilege"));

    await runtime.run({
      sessionKey: "s-synthetic",
      message: "run synthetic",
      deliver: false,
    });

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientScopes()).not.toContain("operator.admin");
  });

  test("allows fallback session reads with synthetic write scope", async () => {
    const runtime = await createSubagentRuntime();
    setFallbackGatewayContext(createTestContext("synthetic-session-read"));

    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      const scopes = Array.isArray(opts.client?.connect?.scopes) ? opts.client.connect.scopes : [];
      const auth = authorizeOperatorScopesForMethod("sessions.get", scopes);
      if (!auth.allowed) {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `missing scope: ${auth.missingScope}`,
        });
        return;
      }
      opts.respond(true, { messages: [{ id: "m-1" }] });
    });

    await expect(
      runtime.getSessionMessages({
        sessionKey: "s-read",
      }),
    ).resolves.toEqual({
      messages: [{ id: "m-1" }],
    });

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientScopes()).not.toContain("operator.admin");
  });

  test("rejects fallback session deletion without minting admin scope", async () => {
    const runtime = await createSubagentRuntime();
    setFallbackGatewayContext(createTestContext("synthetic-delete-session"));

    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      // Re-run the gateway scope check here so the test proves fallback dispatch
      // does not smuggle admin into the request client.
      const scopes = Array.isArray(opts.client?.connect?.scopes) ? opts.client.connect.scopes : [];
      const auth = authorizeOperatorScopesForMethod("sessions.delete", scopes);
      if (!auth.allowed) {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `missing scope: ${auth.missingScope}`,
        });
        return;
      }
      opts.respond(true, {});
    });

    await expect(
      runtime.deleteSession({
        sessionKey: "s-delete",
        deleteTranscript: true,
      }),
    ).rejects.toThrow("missing scope: operator.admin");

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientScopes()).not.toContain("operator.admin");
  });

  test("allows session deletion when the request scope already has admin", async () => {
    const runtime = await createSubagentRuntime();
    const scope = {
      context: createTestContext("request-scope-delete-session"),
      client: {
        connect: {
          scopes: ["operator.admin"],
        },
      } as GatewayRequestOptions["client"],
      isWebchatConnect: () => false,
    } satisfies PluginRuntimeGatewayRequestScope;

    await expect(
      withPluginRuntimeGatewayRequestScope(scope, () =>
        runtime.deleteSession({
          sessionKey: "s-delete-admin",
          deleteTranscript: true,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(getLastDispatchedClientScopes()).toEqual(["operator.admin"]);
  });

  test("can prefer setup-runtime channel plugins during startup loads", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayPluginsForTest({
      preferSetupRuntimeForChannelPlugins: true,
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        preferSetupRuntimeForChannelPlugins: true,
      }),
    );
  });

  test("primes configured bindings during gateway startup", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    const cfg = {};
    const autoEnabledConfig = { channels: { slack: { enabled: true } }, autoEnabled: true };
    applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
    });
    loadGatewayStartupPluginsForTest({ cfg });

    expect(primeConfiguredBindingRegistryMock).toHaveBeenCalledWith({ cfg: autoEnabledConfig });
  });

  test("uses the auto-enabled config snapshot for gateway bootstrap policies", async () => {
    const autoEnabledConfig = {
      plugins: {
        entries: {
          demo: {
            subagent: { allowModelOverride: true, allowedModels: ["openai/gpt-5.4"] },
          },
        },
      },
    };
    applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {},
    });
    const runtime = await createSubagentRuntime({});
    setFallbackGatewayContext(createTestContext("auto-enabled-bootstrap-policy"));

    await withPluginRuntimePluginIdScope("demo", () =>
      runtime.run({
        sessionKey: "s-auto-enabled-bootstrap-policy",
        message: "use trusted override",
        model: "openai/gpt-5.4",
        deliver: false,
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      sessionKey: "s-auto-enabled-bootstrap-policy",
      model: "openai/gpt-5.4",
    });
  });

  test("can suppress duplicate diagnostics when reloading full runtime plugins", async () => {
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "error",
        pluginId: "telegram",
        source: "/tmp/telegram/index.ts",
        message: "failed to load plugin: boom",
      },
    ];
    loadOpenClawPlugins.mockReturnValue(createRegistry(diagnostics));
    const log = createTestLog();

    reloadDeferredGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
      logDiagnostics: false,
      deps: bootstrapDeps,
    });

    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  test("reuses the initial startup plugin scope during deferred reloads", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    reloadDeferredGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log: createTestLog(),
      coreGatewayHandlers: {},
      baseMethods: [],
      pluginIds: ["discord"],
      logDiagnostics: false,
      deps: bootstrapDeps,
    });

    expect(resolveGatewayStartupPluginIds).not.toHaveBeenCalled();
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["discord"],
      }),
    );
  });

  test("runs registry hook before priming configured bindings", async () => {
    const order: string[] = [];
    const pluginRegistry = createRegistry([]);
    loadOpenClawPlugins.mockReturnValue(pluginRegistry);
    primeConfiguredBindingRegistryMock.mockImplementation(() => {
      order.push("prime");
      return { bindingCount: 0, channelCount: 0 };
    });

    prepareGatewayPluginLoad({
      cfg: {},
      workspaceDir: "/tmp",
      log: {
        ...createTestLog(),
      },
      coreGatewayHandlers: {},
      baseMethods: [],
      beforePrimeRegistry: (loadedRegistry) => {
        expect(loadedRegistry).toBe(pluginRegistry);
        order.push("hook");
      },
      deps: bootstrapDeps,
    });

    expect(order).toEqual(["hook", "prime"]);
  });

  test("shares fallback context across module reloads for existing runtimes", async () => {
    const runtime = await createSubagentRuntime();

    const staleContext = createTestContext("stale");
    setFallbackGatewayContext(staleContext);
    await runtime.run({ sessionKey: "s-1", message: "hello" });
    expect(getLastDispatchedContext()).toBe(staleContext);

    const freshContext = createTestContext("fresh");
    setFallbackGatewayContext(freshContext);

    await runtime.run({ sessionKey: "s-1", message: "hello again" });
    expect(getLastDispatchedContext()).toBe(freshContext);
  });

  test("uses updated fallback context after context replacement", async () => {
    const runtime = await createSubagentRuntime();
    const firstContext = createTestContext("before-restart");
    const secondContext = createTestContext("after-restart");

    setFallbackGatewayContext(firstContext);
    await runtime.run({ sessionKey: "s-2", message: "before restart" });
    expect(getLastDispatchedContext()).toBe(firstContext);

    setFallbackGatewayContext(secondContext);
    await runtime.run({ sessionKey: "s-2", message: "after restart" });
    expect(getLastDispatchedContext()).toBe(secondContext);
  });

  test("reflects fallback context object mutation at dispatch time", async () => {
    const runtime = await createSubagentRuntime();
    const context = { marker: "before-mutation" } as GatewayRequestContext & {
      marker: string;
    };

    setFallbackGatewayContext(context);
    context.marker = "after-mutation";

    await runtime.run({ sessionKey: "s-3", message: "mutated context" });
    const dispatched = getLastDispatchedContext() as
      | (GatewayRequestContext & { marker: string })
      | undefined;
    expect(dispatched?.marker).toBe("after-mutation");
  });

  test("resolves fallback context lazily when a resolver is registered", async () => {
    const runtime = await createSubagentRuntime();
    let currentContext = createTestContext("before-resolver-update");

    setFallbackGatewayContextResolver(() => currentContext);
    await runtime.run({ sessionKey: "s-4", message: "before resolver update" });
    expect(getLastDispatchedContext()).toBe(currentContext);

    currentContext = createTestContext("after-resolver-update");
    await runtime.run({ sessionKey: "s-4", message: "after resolver update" });
    expect(getLastDispatchedContext()).toBe(currentContext);
  });

  test("prefers resolver output over an older fallback context snapshot", async () => {
    const runtime = await createSubagentRuntime();
    const staleContext = createTestContext("stale-snapshot");
    const freshContext = createTestContext("fresh-resolver");

    setFallbackGatewayContext(staleContext);
    setFallbackGatewayContextResolver(() => freshContext);

    await runtime.run({ sessionKey: "s-5", message: "prefer resolver" });
    expect(getLastDispatchedContext()).toBe(freshContext);
  });
});

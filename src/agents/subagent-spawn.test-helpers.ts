import os from "node:os";
import { expect, type Mock } from "vitest";
import { formatThinkingLevels, normalizeThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { mergeSessionEntry, type SessionEntry } from "../config/sessions.js";
import { isAdminOnlyMethod } from "../gateway/method-scopes.js";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import { resolveSpawnedWorkspaceInheritance } from "./spawned-context.js";
import { countActiveRunsForSession, resetSubagentRegistryForTests } from "./subagent-registry.js";
import type { SubagentSpawnDeps } from "./subagent-spawn.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./tools/sessions-helpers.js";

type GatewayCallMock = Mock<SubagentSpawnDeps["callGateway"]>;
type SessionStoreUpdateMock = Mock<SubagentSpawnDeps["updateSessionStore"]>;
type MockImplementationTarget = {
  mockImplementation: (
    implementation: (
      opts: Parameters<SubagentSpawnDeps["callGateway"]>[0],
    ) => ReturnType<SubagentSpawnDeps["callGateway"]>,
  ) => unknown;
};
type SessionStore = Record<string, SessionEntry>;
type SessionStoreMutator = (store: SessionStore) => unknown;
type HookRunner = SubagentLifecycleHookRunner;

export function createSubagentSpawnTestConfig(
  workspaceDir = os.tmpdir(),
  overrides?: Record<string, unknown>,
): OpenClawConfig & { tools?: { sessions_spawn?: { attachments?: Record<string, unknown> } } } {
  return {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    tools: {
      sessions_spawn: {
        attachments: {
          enabled: true,
          maxFiles: 50,
          maxFileBytes: 1 * 1024 * 1024,
          maxTotalBytes: 5 * 1024 * 1024,
        },
      },
    },
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
    ...overrides,
  };
}

export function setupAcceptedSubagentGatewayMock(callGatewayMock: MockImplementationTarget) {
  callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
    if (opts.method === "sessions.patch") {
      return { ok: true };
    }
    if (opts.method === "sessions.delete") {
      return { ok: true };
    }
    if (opts.method === "agent") {
      return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
    }
    return {};
  });
}

export function identityDeliveryContext(value: unknown) {
  return value;
}

export function createDefaultSessionHelperMocks() {
  return {
    resolveMainSessionAlias: () => ({ mainKey: "main", alias: "main" }),
    resolveInternalSessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
    resolveDisplaySessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
  };
}

export function installSessionStoreCaptureMock(
  updateSessionStoreMock: {
    mockImplementation: (
      implementation: (storePath: string, mutator: SessionStoreMutator) => Promise<SessionStore>,
    ) => unknown;
  },
  params?: {
    operations?: string[];
    onStore?: (store: SessionStore) => void;
  },
) {
  updateSessionStoreMock.mockImplementation(
    async (_storePath: string, mutator: SessionStoreMutator) => {
      params?.operations?.push("store:update");
      const store: SessionStore = {};
      await mutator(store);
      params?.onStore?.(store);
      return store;
    },
  );
}

export function expectPersistedRuntimeModel(params: {
  persistedStore: SessionStore | undefined;
  sessionKey: string | RegExp;
  provider: string;
  model: string;
}) {
  const [persistedKey, persistedEntry] = Object.entries(params.persistedStore ?? {})[0] ?? [];
  if (typeof params.sessionKey === "string") {
    expect(persistedKey).toBe(params.sessionKey);
  } else {
    expect(persistedKey).toMatch(params.sessionKey);
  }
  expect(persistedEntry).toMatchObject({
    modelProvider: params.provider,
    model: params.model,
  });
}

export async function loadSubagentSpawnModuleForTest(params: {
  callGatewayMock: GatewayCallMock;
  loadConfig?: SubagentSpawnDeps["loadConfig"];
  updateSessionStoreMock?: SessionStoreUpdateMock;
  pruneLegacyStoreKeysMock?: SubagentSpawnDeps["pruneLegacyStoreKeys"];
  registerSubagentRunMock?: SubagentSpawnDeps["registerSubagentRun"];
  emitSessionLifecycleEventMock?: SubagentSpawnDeps["emitSessionLifecycleEvent"];
  hookRunner?: HookRunner;
  resolveAgentConfig?: SubagentSpawnDeps["resolveAgentConfig"];
  resolveAgentWorkspaceDir?: (cfg: OpenClawConfig, agentId: string) => string;
  resolveSubagentSpawnModelSelection?: SubagentSpawnDeps["resolveSubagentSpawnModelSelection"];
  resolveSandboxRuntimeStatus?: SubagentSpawnDeps["resolveSandboxRuntimeStatus"];
  workspaceDir?: string;
  sessionStorePath?: string;
  resetModules?: boolean;
}) {
  const subagentSpawnModule = await import("./subagent-spawn.js");

  subagentSpawnModule.__testing.setDepsForTest({
    callGateway: ((opts) => params.callGatewayMock(opts)) as SubagentSpawnDeps["callGateway"],
    getGlobalHookRunner: () => params.hookRunner ?? null,
    loadConfig: () =>
      params.loadConfig?.() ?? createSubagentSpawnTestConfig(params.workspaceDir ?? os.tmpdir()),
    updateSessionStore: (params.updateSessionStoreMock ??
      (async (_storePath, mutator) => {
        const store: Record<string, SessionEntry> = {};
        return await mutator(store);
      })) as SubagentSpawnDeps["updateSessionStore"],
    pruneLegacyStoreKeys:
      params.pruneLegacyStoreKeysMock ??
      (() => {
        // No legacy keys are present in these tests unless a test explicitly supplies them.
      }),
    registerSubagentRun:
      params.registerSubagentRunMock ??
      (() => {
        // Tests that inspect registration provide an explicit mock.
      }),
    emitSessionLifecycleEvent:
      params.emitSessionLifecycleEventMock ??
      (() => {
        // Lifecycle emission is not relevant unless a test explicitly observes it.
      }),
    resolveAgentConfig: params.resolveAgentConfig ?? (() => undefined),
    resolveSubagentSpawnModelSelection:
      params.resolveSubagentSpawnModelSelection ??
      ((spawnParams) =>
        typeof spawnParams.modelOverride === "string" && spawnParams.modelOverride.trim()
          ? spawnParams.modelOverride.trim()
          : "openai/gpt-4"),
    resolveSandboxRuntimeStatus: params.resolveSandboxRuntimeStatus ?? resolveSandboxRuntimeStatus,
    resolveGatewaySessionStoreTarget: (targetParams) => ({
      agentId: "main",
      storePath: params.sessionStorePath ?? "/tmp/subagent-spawn-model-session.json",
      canonicalKey: targetParams.key,
      storeKeys: [targetParams.key],
    }),
    getSubagentDepthFromSessionStore: () => 0,
    mergeSessionEntry,
    resolveDisplaySessionKey,
    resolveInternalSessionKey,
    resolveMainSessionAlias,
    isAdminOnlyMethod,
    normalizeDeliveryContext: (value) => value,
    buildSubagentSystemPrompt: () => "system-prompt",
    formatThinkingLevels,
    normalizeThinkLevel,
    countActiveRunsForSession,
    resolveSpawnedWorkspaceInheritance: ({ config, targetAgentId, explicitWorkspaceDir }) => {
      if (explicitWorkspaceDir?.trim()) {
        return explicitWorkspaceDir.trim();
      }
      return params.resolveAgentWorkspaceDir
        ? params.resolveAgentWorkspaceDir(config, targetAgentId ?? "main")
        : resolveSpawnedWorkspaceInheritance({ config, targetAgentId, explicitWorkspaceDir });
    },
  });

  const resetSubagentRegistryForTestsFn = () => resetSubagentRegistryForTests({ persist: false });
  return {
    ...subagentSpawnModule,
    resetSubagentRegistryForTests: resetSubagentRegistryForTestsFn,
  };
}

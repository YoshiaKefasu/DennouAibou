import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles.js";
import { resetSkillsRefreshForTest } from "../agents/skills/refresh.js";
import { clearSessionStoreCacheForTest, loadSessionStore } from "../config/sessions.js";
import type { ReasoningEffortMap } from "../config/types.models.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginProviderRegistration } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import {
  getCachedModelCatalogSyncMock,
  loadModelCatalogMock,
  runEmbeddedPiAgentMock,
} from "./reply.directive.directive-behavior.e2e-mocks.js";

export const MAIN_SESSION_KEY = "agent:main:main";
type RunPreparedReply = typeof import("./reply/get-reply-run.js").runPreparedReply;

// PI `models.json` reasoning-effort map for OpenAI native synthetic models.
// Mirrors `OPENAI_REASONING_EFFORT_MAP` in `extensions/openai/openai-provider.ts`
// (the openai provider's built-in catalog). openai-codex uses the same wire
// surface as the openai gpt-5.4 family — `xhigh` is supported, `max` is not.
export const OPENAI_CODEX_REASONING_EFFORT_MAP: ReasoningEffortMap = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: null,
};

export const DEFAULT_TEST_MODEL_CATALOG: Array<{
  id: string;
  name: string;
  provider: string;
  compat?: { reasoningEffortMap?: ReasoningEffortMap };
}> = [
  { id: "claude-opus-4-6", name: "Opus 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-1", name: "Sonnet 4.1", provider: "anthropic" },
  // The `openai` gpt-5.4 family mirrors `OPENAI_REASONING_EFFORT_MAP` from
  // `extensions/openai/openai-provider.ts` (the openai provider's
  // `augmentModelCatalog` hook wires the same map onto these entries in
  // production). `openai-codex` entries below mirror the same shape; in
  // production today there is no equivalent built-in catalog for the codex
  // provider plugin, but openai-codex uses the same OpenAI-native wire
  // surface as openai so the policy is identical.
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    compat: { reasoningEffortMap: { ...OPENAI_CODEX_REASONING_EFFORT_MAP } },
  },
  {
    id: "gpt-5.4-pro",
    name: "GPT-5.4 Pro",
    provider: "openai",
    compat: { reasoningEffortMap: { ...OPENAI_CODEX_REASONING_EFFORT_MAP } },
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    provider: "openai",
    compat: { reasoningEffortMap: { ...OPENAI_CODEX_REASONING_EFFORT_MAP } },
  },
  {
    id: "gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    provider: "openai",
    compat: { reasoningEffortMap: { ...OPENAI_CODEX_REASONING_EFFORT_MAP } },
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4 (Codex)",
    provider: "openai-codex",
    compat: { reasoningEffortMap: { ...OPENAI_CODEX_REASONING_EFFORT_MAP } },
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini (Codex)",
    provider: "openai-codex",
    compat: { reasoningEffortMap: { ...OPENAI_CODEX_REASONING_EFFORT_MAP } },
  },
  // `gpt-4.1-mini` is intentionally map-less: this is the model used to
  // exercise the "xhigh not supported" denial path, so leaving the map off
  // preserves the original test assertion that the directive should be
  // rejected with the new "models that declare xhigh in their
  // reasoningEffortMap" wording.
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
];

export type ReplyPayloadText = { text?: string | null } | null | undefined;

// The historical `OPENAI_XHIGH_MODEL_IDS` / `OPENAI_CODEX_XHIGH_MODEL_IDS`
// lists lived here to back the now-removed `supportsXHighThinking` provider
// hook. Elevated-reasoning policy now flows through
// `compat.reasoningEffortMap` on each model entry, so these lists are no
// longer referenced from `createThinkingPolicyProvider` and have been
// deleted. The harness registry still wires up an `openai` and
// `openai-codex` provider plugin so provider-shape tests can run; consumers
// must look at the model's `compat.reasoningEffortMap` (mirrored from
// `OPENAI_CODEX_REASONING_EFFORT_MAP` above) to know which levels each
// model advertises.

function createThinkingPolicyProvider(providerId: string): ProviderPlugin {
  return {
    id: providerId,
    label: providerId,
    auth: [],
  };
}

function createDirectiveBehaviorProviderRegistry(): ReturnType<typeof createEmptyPluginRegistry> {
  const registry = createEmptyPluginRegistry();
  const providers: PluginProviderRegistration[] = [
    {
      pluginId: "openai",
      pluginName: "OpenAI Provider",
      source: "test",
      provider: createThinkingPolicyProvider("openai"),
    },
    {
      pluginId: "openai",
      pluginName: "OpenAI Provider",
      source: "test",
      provider: createThinkingPolicyProvider("openai-codex"),
    },
  ];
  registry.providers.push(...providers);
  return registry;
}

export function replyText(res: ReplyPayloadText | ReplyPayloadText[]): string | undefined {
  if (Array.isArray(res)) {
    return typeof res[0]?.text === "string" ? res[0]?.text : undefined;
  }
  return typeof res?.text === "string" ? res.text : undefined;
}

export function replyTexts(res: ReplyPayloadText | ReplyPayloadText[]): string[] {
  const payloads = Array.isArray(res) ? res : [res];
  return payloads
    .map((entry) => (typeof entry?.text === "string" ? entry.text : undefined))
    .filter((value): value is string => Boolean(value));
}

export function makeEmbeddedTextResult(text = "done") {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  };
}

export function mockEmbeddedTextResult(text = "done") {
  runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult(text));
}

export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      return await fn(home);
    },
    {
      env: {
        DENNOU_AGENT_DIR: (home) => path.join(home, ".openclaw", "agent"),
        PI_CODING_AGENT_DIR: (home) => path.join(home, ".openclaw", "agent"),
      },
      prefix: "openclaw-reply-",
    },
  );
}

export function sessionStorePath(home: string): string {
  return path.join(home, "sessions.json");
}

export function makeWhatsAppDirectiveConfig(
  home: string,
  defaults: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    agents: {
      defaults: {
        workspace: path.join(home, "openclaw"),
        ...defaults,
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: sessionStorePath(home) },
    ...extra,
  };
}

export const AUTHORIZED_WHATSAPP_COMMAND = {
  From: "+1222",
  To: "+1222",
  Provider: "whatsapp",
  SenderE164: "+1222",
  CommandAuthorized: true,
} as const;

export function makeElevatedDirectiveConfig(home: string) {
  return makeWhatsAppDirectiveConfig(
    home,
    {
      model: "anthropic/claude-opus-4-6",
      elevatedDefault: "on",
    },
    {
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["+1222"] },
        },
      },
      channels: { whatsapp: { allowFrom: ["+1222"] } },
      session: { store: sessionStorePath(home) },
    },
  );
}

export function assertModelSelection(
  storePath: string,
  selection: { model?: string; provider?: string } = {},
) {
  const store = loadSessionStore(storePath);
  const entry = store[MAIN_SESSION_KEY];
  expect(entry).toBeDefined();
  expect(entry?.modelOverride).toBe(selection.model);
  expect(entry?.providerOverride).toBe(selection.provider);
}

export function assertElevatedOffStatusReply(text: string | undefined) {
  expect(text).toContain("Elevated mode disabled.");
  const optionsLine = text?.split("\n").find((line) => line.trim().startsWith("⚙️"));
  expect(optionsLine).toBeTruthy();
  expect(optionsLine).not.toContain("elevated");
}

export function installDirectiveBehaviorE2EHooks() {
  beforeEach(async () => {
    await resetSkillsRefreshForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    clearSessionStoreCacheForTest();
    resetSystemEventsForTest();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createDirectiveBehaviorProviderRegistry());
    runEmbeddedPiAgentMock.mockReset();
    loadModelCatalogMock.mockReset();
    loadModelCatalogMock.mockResolvedValue(DEFAULT_TEST_MODEL_CATALOG);
  });

  afterEach(async () => {
    await resetSkillsRefreshForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    clearSessionStoreCacheForTest();
    resetSystemEventsForTest();
    resetPluginRuntimeStateForTest();
    vi.restoreAllMocks();
  });
}

export function installFreshDirectiveBehaviorReplyMocks(params?: {
  onActualRunPreparedReply?: (runPreparedReply: RunPreparedReply) => void;
  runPreparedReply?: (...args: Parameters<RunPreparedReply>) => unknown;
}) {
  vi.doMock("../agents/pi-embedded.js", () => ({
    abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
    runEmbeddedPiAgent: (...args: unknown[]) => runEmbeddedPiAgentMock(...args),
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
    isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
    isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
    // Added after the thinkingLevelMap migration surfaced these calls in
    // `src/auto-reply/reply/get-reply-run.ts`. The production module exports
    // them; the harness mock must too, otherwise `runPreparedReply` throws
    // `resolveActiveEmbeddedRunSessionId is not a function`.
    resolveActiveEmbeddedRunSessionId: vi.fn().mockReturnValue(undefined),
    waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("../agents/model-catalog.js", () => ({
    loadModelCatalog: loadModelCatalogMock,
    // Mirror the harness's `loadModelCatalog` resolved value so callers
    // that read `getCachedModelCatalogSync()` (e.g. `thinking.ts` when
    // resolving `compat.reasoningEffortMap`) see the same catalog that
    // `loadModelCatalog` returned.
    getCachedModelCatalogSync: (...args: unknown[]) => getCachedModelCatalogSyncMock(...args),
    resetModelCatalogCacheForTest: vi.fn(),
  }));
  if (params?.runPreparedReply || params?.onActualRunPreparedReply) {
    vi.doMock("./reply/get-reply-run.js", async () => {
      const actual = await vi.importActual<typeof import("./reply/get-reply-run.js")>(
        "./reply/get-reply-run.js",
      );
      params.onActualRunPreparedReply?.(actual.runPreparedReply);
      return {
        ...actual,
        runPreparedReply: (...args: Parameters<RunPreparedReply>) =>
          params.runPreparedReply?.(...args),
      };
    });
  }
}

export function makeRestrictedElevatedDisabledConfig(home: string) {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-6",
        workspace: path.join(home, "openclaw"),
      },
      list: [
        {
          id: "restricted",
          tools: {
            elevated: { enabled: false },
          },
        },
      ],
    },
    tools: {
      elevated: {
        allowFrom: { whatsapp: ["+1222"] },
      },
    },
    channels: { whatsapp: { allowFrom: ["+1222"] } },
    session: { store: path.join(home, "sessions.json") },
  } as const;
}

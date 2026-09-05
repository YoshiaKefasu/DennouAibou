import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";
import { parseInlineDirectives } from "./directive-handling.js";

const thinkingMocks = vi.hoisted(() => ({
  isElevatedThinkingDenied: vi.fn(),
}));

const liveModelSwitchMocks = vi.hoisted(() => ({
  requestLiveSessionModelSwitch: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  refreshQueuedFollowupSession: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveSessionAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../../agents/live-model-switch.js", () => ({
  requestLiveSessionModelSwitch: (...args: unknown[]) =>
    liveModelSwitchMocks.requestLiveSessionModelSwitch(...args),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: (...args: unknown[]) =>
    queueMocks.refreshQueuedFollowupSession(...args),
}));

vi.mock("../thinking.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../thinking.js")>();
  return {
    ...original,
    isElevatedThinkingDenied: thinkingMocks.isElevatedThinkingDenied,
  };
});

const TEST_AGENT_DIR = "/tmp/agent";

function baseConfig(): OpenClawConfig {
  return {
    commands: { text: true },
    agents: { defaults: {} },
  } as unknown as OpenClawConfig;
}

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "s1",
    updatedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir: TEST_AGENT_DIR,
      store: { version: 1, profiles: {} },
    },
  ]);
  thinkingMocks.isElevatedThinkingDenied.mockReset().mockReturnValue(false);
  liveModelSwitchMocks.requestLiveSessionModelSwitch.mockReset().mockReturnValue(false);
  queueMocks.refreshQueuedFollowupSession.mockReset();
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
});

describe("handleDirectiveOnly elevated thinking downgrade persist", () => {
  const allowedModelKeys = new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]);
  const allowedModelCatalog = [
    { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  ];
  const sessionKey = "agent:main:dm:1";
  const storePath = "/tmp/sessions.json";

  type HandleParams = Parameters<typeof handleDirectiveOnly>[0];

  function createHandleParams(overrides: Partial<HandleParams>): HandleParams {
    const entryOverride = overrides.sessionEntry;
    const storeOverride = overrides.sessionStore;
    const entry = entryOverride ?? createSessionEntry();
    const store = storeOverride ?? ({ [sessionKey]: entry } as const);
    const { sessionEntry: _ignoredEntry, sessionStore: _ignoredStore, ...rest } = overrides;

    return {
      cfg: baseConfig(),
      directives: rest.directives ?? parseInlineDirectives(""),
      sessionKey,
      storePath,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelKeys,
      allowedModelCatalog,
      resetModelOverride: false,
      provider: "anthropic",
      model: "claude-opus-4-6",
      initialModelLabel: "anthropic/claude-opus-4-6",
      formatModelSwitchEvent: (label) => `Switched to ${label}`,
      ...rest,
      sessionEntry: entry,
      sessionStore: store,
    };
  }

  it("persists thinkingLevel=high when xhigh is not supported for the resolved model", async () => {
    // Model does NOT support xhigh => downgrade path must persist "high".
    thinkingMocks.isElevatedThinkingDenied.mockImplementation(
      (level) => level === "xhigh" || level === "max",
    );

    const directives = parseInlineDirectives("hello world");
    const sessionEntry = createSessionEntry({ thinkingLevel: "xhigh" });
    const sessionStore = { [sessionKey]: sessionEntry };

    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
        sessionStore,
      }),
    );

    expect(result?.text).toContain("Thinking level set to high");
    expect(result?.text).toContain("xhigh not supported");
    expect(sessionEntry.thinkingLevel).toBe("high");
    expect(sessionStore[sessionKey]?.thinkingLevel).toBe("high");
  });

  it("persists thinkingLevel=high when max is not supported for the resolved model", async () => {
    // Model does NOT support max => downgrade path must persist "high".
    thinkingMocks.isElevatedThinkingDenied.mockImplementation(
      (level) => level === "xhigh" || level === "max",
    );

    const directives = parseInlineDirectives("hello world");
    const sessionEntry = createSessionEntry({ thinkingLevel: "max" });
    const sessionStore = { [sessionKey]: sessionEntry };

    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
        sessionStore,
      }),
    );

    expect(result?.text).toContain("Thinking level set to high");
    expect(result?.text).toContain("max not supported");
    expect(sessionEntry.thinkingLevel).toBe("high");
    expect(sessionStore[sessionKey]?.thinkingLevel).toBe("high");
  });
});

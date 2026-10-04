import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import { extractAssistantText, sanitizeTextContent } from "./sessions-helpers.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

type SessionsToolTestConfig = {
  session: { scope: "per-sender"; mainKey: string };
  tools: {
    agentToAgent: { enabled: boolean };
    sessions?: { visibility: "all" | "own" };
  };
};

const loadConfigMock = vi.fn<() => SessionsToolTestConfig>(() => ({
  session: { scope: "per-sender", mainKey: "main" },
  tools: { agentToAgent: { enabled: false } },
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfigMock() as never,
}));
const installRegistry = async () => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          id: "discord",
          meta: {
            id: "discord",
            label: "Discord",
            selectionLabel: "Discord",
            docsPath: "/channels/discord",
            blurb: "Discord test stub.",
          },
          capabilities: { chatTypes: ["direct", "channel", "thread"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          id: "whatsapp",
          meta: {
            id: "whatsapp",
            label: "WhatsApp",
            selectionLabel: "WhatsApp",
            docsPath: "/channels/whatsapp",
            blurb: "WhatsApp test stub.",
            preferSessionLookupForAnnounceTarget: true,
          },
          capabilities: { chatTypes: ["direct", "group"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
    ]),
  );
};

describe("sanitizeTextContent", () => {
  it("strips minimax tool call XML and downgraded markers", () => {
    const input =
      'Hello <invoke name="tool">payload</invoke></minimax:tool_call> ' +
      "[Tool Call: foo (ID: 1)] world";
    const result = sanitizeTextContent(input).trim();
    expect(result).toBe("Hello  world");
    expect(result).not.toContain("invoke");
    expect(result).not.toContain("Tool Call");
  });

  it("strips thinking tags", () => {
    const input = "Before <think>secret</think> after";
    const result = sanitizeTextContent(input).trim();
    expect(result).toBe("Before  after");
  });
});

beforeEach(() => {
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue({
    session: { scope: "per-sender", mainKey: "main" },
    tools: { agentToAgent: { enabled: false } },
  });
  setActivePluginRegistry(createTestRegistry([]));
});

describe("extractAssistantText", () => {
  it("sanitizes blocks without injecting newlines", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "Hi " },
        { type: "text", text: "<think>secret</think>there" },
      ],
    };
    expect(extractAssistantText(message)).toBe("Hi there");
  });

  it("rewrites error-ish assistant text only when the transcript marks it as an error", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "500 Internal Server Error",
      content: [{ type: "text", text: "500 Internal Server Error" }],
    };
    expect(extractAssistantText(message)).toBe("HTTP 500: Internal Server Error");
  });

  it("keeps normal status text that mentions billing", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Firebase downgraded us to the free Spark plan. Check whether billing should be re-enabled.",
        },
      ],
    };
    expect(extractAssistantText(message)).toBe(
      "Firebase downgraded us to the free Spark plan. Check whether billing should be re-enabled.",
    );
  });

  it("preserves successful turns with stale background errorMessage", () => {
    const message = {
      role: "assistant",
      stopReason: "end_turn",
      errorMessage: "insufficient credits for embedding model",
      content: [{ type: "text", text: "Handle payment required errors in your API." }],
    };
    expect(extractAssistantText(message)).toBe("Handle payment required errors in your API.");
  });
});

describe("resolveAnnounceTarget", () => {
  beforeEach(async () => {
    callGatewayMock.mockClear();
    await installRegistry();
  });

  it("derives non-WhatsApp announce targets from the session key", async () => {
    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
    });
    expect(target).toEqual({ channel: "discord", to: "group:dev" });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("hydrates WhatsApp accountId from sessions.list when available", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:whatsapp:group:123@g.us",
          deliveryContext: {
            channel: "whatsapp",
            to: "123@g.us",
            accountId: "work",
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      displayKey: "agent:main:whatsapp:group:123@g.us",
    });
    expect(target).toEqual({
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const first = callGatewayMock.mock.calls[0]?.[0] as { method?: string } | undefined;
    expect(first).toBeDefined();
    expect(first?.method).toBe("sessions.list");
  });

  it("falls back to origin provider and accountId from sessions.list when legacy route fields are absent", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:whatsapp:group:123@g.us",
          origin: {
            provider: "whatsapp",
            accountId: "work",
          },
          lastTo: "123@g.us",
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      displayKey: "agent:main:whatsapp:group:123@g.us",
    });
    expect(target).toEqual({
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
    });
  });
});

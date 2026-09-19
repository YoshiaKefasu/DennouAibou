import { ChannelType, type AutocompleteInteraction } from "@buape/carbon";
import {
  findCommandByNativeName,
  resolveCommandArgChoices,
} from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setThinkingDepsForTests } from "../../../../src/auto-reply/thinking.js";
import type { DiscordNativeInteractionRouteState } from "./native-command-route.js";
import type { DiscordNativeChoiceContextDeps } from "./native-command-ui.js";
import { resolveDiscordNativeChoiceContext } from "./native-command-ui.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const SESSION_KEY = "agent:main:main";

// Inject the native-choice context boundaries instead of mocking
// `openclaw/plugin-sdk/conversation-runtime`, `openclaw/plugin-sdk/agent-runtime`,
// and `openclaw/plugin-sdk/config-runtime` at module level (Bun cannot intercept
// ESM imports).
const resolveDiscordNativeInteractionRouteState = vi.fn();

function createRouteState(params?: {
  bindingReadiness?: DiscordNativeInteractionRouteState["bindingReadiness"];
}): DiscordNativeInteractionRouteState {
  const route = {
    agentId: "main",
    channel: "discord",
    accountId: "default",
    sessionKey: SESSION_KEY,
    mainSessionKey: SESSION_KEY,
    lastRoutePolicy: "main",
    matchedBy: "default",
  };
  return {
    route,
    effectiveRoute: route,
    boundSessionKey: undefined,
    configuredRoute: null,
    configuredBinding: null,
    bindingReadiness: params?.bindingReadiness ?? null,
  } as unknown as DiscordNativeInteractionRouteState;
}

const deps: DiscordNativeChoiceContextDeps = {
  resolveDiscordNativeInteractionRouteState:
    resolveDiscordNativeInteractionRouteState as unknown as NonNullable<
      DiscordNativeChoiceContextDeps["resolveDiscordNativeInteractionRouteState"]
    >,
  resolveDefaultModelForAgent: (() => ({
    provider: "anthropic",
    model: "claude-sonnet-4.5",
  })) as unknown as NonNullable<DiscordNativeChoiceContextDeps["resolveDefaultModelForAgent"]>,
  resolveStorePath: (() =>
    "/tmp/openclaw-discord-think-autocomplete.json") as unknown as NonNullable<
    DiscordNativeChoiceContextDeps["resolveStorePath"]
  >,
  loadSessionStore: (() => ({
    [SESSION_KEY]: {
      updatedAt: 0,
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
    },
  })) as unknown as NonNullable<DiscordNativeChoiceContextDeps["loadSessionStore"]>,
};

function createConfig() {
  return {
    agents: {
      defaults: {
        model: {
          primary: "anthropic/claude-sonnet-4.5",
        },
      },
    },
    // Make the elevated (/xhigh) level deterministic: the thinking-level list for
    // a model is driven by its `compat.reasoningEffortMap`, so declare it here
    // instead of relying on an ambient runtime model catalog.
    models: {
      providers: {
        "openai-codex": {
          models: [
            {
              id: "gpt-5.4",
              compat: {
                reasoningEffortMap: {
                  minimal: "minimal",
                  low: "low",
                  medium: "medium",
                  high: "high",
                  xhigh: "xhigh",
                },
              },
            },
          ],
        },
      },
    },
    session: {
      store: "/tmp/openclaw-discord-think-autocomplete.json",
    },
  } as unknown as ReturnType<typeof loadConfig>;
}

describe("discord native /think autocomplete", () => {
  beforeEach(() => {
    // `resolveCommandArgChoices` reads thinking levels from the *global* config,
    // not the `cfg` argument, so inject a deterministic config through the
    // existing thinking-deps seam instead of relying on the ambient model catalog.
    setThinkingDepsForTests({ loadConfig: () => createConfig() });
  });

  afterAll(() => {
    setThinkingDepsForTests(null);
  });

  it("uses the session override context for /think choices", async () => {
    resolveDiscordNativeInteractionRouteState.mockReset();
    resolveDiscordNativeInteractionRouteState.mockResolvedValue(createRouteState());

    const cfg = createConfig();
    const interaction = {
      options: {
        getFocused: () => ({ value: "xh" }),
      },
      respond: async (_choices: Array<{ name: string; value: string }>) => {},
      rawData: {},
      channel: { id: "D1", type: ChannelType.DM },
      user: { id: "U1" },
      guild: undefined,
      client: {},
    } as unknown as AutocompleteInteraction & {
      respond: (choices: Array<{ name: string; value: string }>) => Promise<void>;
    };

    const command = findCommandByNativeName("think", "discord");
    expect(command).toBeTruthy();
    const levelArg = command?.args?.find((entry) => entry.name === "level");
    expect(levelArg).toBeTruthy();
    if (!command || !levelArg) {
      return;
    }

    const context = await resolveDiscordNativeChoiceContext(
      {
        interaction,
        cfg,
        accountId: "default",
        threadBindings: createNoopThreadBindingManager("default"),
      },
      deps,
    );
    expect(context).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
    });

    const choices = resolveCommandArgChoices({
      command,
      arg: levelArg,
      cfg,
      provider: context?.provider,
      model: context?.model,
    });
    const values = choices.map((choice) => choice.value);
    expect(values).toContain("xhigh");
  });

  it("falls back when a configured binding is unavailable", async () => {
    resolveDiscordNativeInteractionRouteState.mockReset();
    resolveDiscordNativeInteractionRouteState.mockResolvedValue(
      createRouteState({ bindingReadiness: { ok: false, error: "acpx exited" } as never }),
    );

    const cfg = createConfig();
    const interaction = {
      options: {
        getFocused: () => ({ value: "xh" }),
      },
      respond: async (_choices: Array<{ name: string; value: string }>) => {},
      rawData: {
        member: { roles: [] },
      },
      channel: { id: "C1", type: ChannelType.GuildText },
      user: { id: "U1" },
      guild: { id: "G1" },
      client: {},
    } as unknown as AutocompleteInteraction & {
      respond: (choices: Array<{ name: string; value: string }>) => Promise<void>;
    };

    const context = await resolveDiscordNativeChoiceContext(
      {
        interaction,
        cfg,
        accountId: "default",
        threadBindings: createNoopThreadBindingManager("default"),
      },
      deps,
    );

    expect(context).toBeNull();
    expect(resolveDiscordNativeInteractionRouteState).toHaveBeenCalledTimes(1);

    const command = findCommandByNativeName("think", "discord");
    const levelArg = command?.args?.find((entry) => entry.name === "level");
    expect(command).toBeTruthy();
    expect(levelArg).toBeTruthy();
    if (!command || !levelArg) {
      return;
    }
    const choices = resolveCommandArgChoices({
      command,
      arg: levelArg,
      cfg,
      provider: context?.provider,
      model: context?.model,
    });
    const values = choices.map((choice) => choice.value);
    expect(values).not.toContain("xhigh");
  });
});

// Keep the OpenClawConfig type import referenced (matches production cfg typing).
export type _ThinkAutocompleteConfig = OpenClawConfig;

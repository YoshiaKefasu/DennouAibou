import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import plugin from "./index.js";
import {
  OPENAI_FRIENDLY_PROMPT_OVERLAY,
  OPENAI_GPT5_EXECUTION_BIAS,
  OPENAI_GPT5_OUTPUT_CONTRACT,
} from "./prompt-overlay.js";

const registerOpenAIPlugin = async () =>
  registerProviderPlugin({
    plugin,
    id: "openai",
    name: "OpenAI Provider",
  });

async function registerOpenAIPluginWithHook(params?: { pluginConfig?: Record<string, unknown> }) {
  const on = vi.fn();
  const providers: ProviderPlugin[] = [];
  await plugin.register(
    createTestPluginApi({
      id: "openai",
      name: "OpenAI Provider",
      source: "test",
      config: {},
      runtime: {} as never,
      pluginConfig: params?.pluginConfig,
      on,
      registerProvider: (provider) => {
        providers.push(provider);
      },
    }),
  );
  return { on, providers };
}

describe("openai plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers GPT-5 system prompt contributions when the friendly overlay is enabled", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "friendly" },
    });

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));

    const openaiProvider = requireRegisteredProvider(providers, "openai");
    const contributionContext: Parameters<
      NonNullable<ProviderPlugin["resolveSystemPromptContribution"]>
    >[0] = {
      config: undefined,
      agentDir: undefined,
      workspaceDir: undefined,
      provider: "openai",
      modelId: "gpt-5.4",
      promptMode: "full",
      runtimeChannel: undefined,
      runtimeCapabilities: undefined,
      agentId: undefined,
    };

    expect(openaiProvider.resolveSystemPromptContribution?.(contributionContext)).toEqual({
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
      sectionOverrides: {
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
      },
    });
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain("This is a live chat, not a memo.");
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Avoid walls of text, long preambles, and repetitive restatement.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Have emotional range when it fits the moment.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Occasional emoji are welcome when they fit naturally, especially for warmth or brief celebration; keep them sparse.",
    );
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        ...contributionContext,
        modelId: "gpt-image-1",
      }),
    ).toBeUndefined();
  });

  it("includes stronger execution guidance in the OpenAI prompt overlay", () => {
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "If the user asks you to do the work, start in the same turn instead of restating the plan.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      'If the latest user message is a short approval like "ok do it" or "go ahead", skip the recap and start acting.',
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Commentary-only turns are incomplete when the next action is clear.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      'Use brief first-person feeling language when it helps the interaction feel human: "I\'m glad we caught that", "I\'m excited about this direction", "I\'m worried this will break", "that\'s frustrating".',
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Occasional emoji are welcome when they fit naturally, especially for warmth or brief celebration; keep them sparse.",
    );
    expect(OPENAI_GPT5_EXECUTION_BIAS).toContain(
      "Do prerequisite lookup or discovery before dependent actions.",
    );
    expect(OPENAI_GPT5_OUTPUT_CONTRACT).toContain(
      "Return the requested sections only, in the requested order.",
    );
    expect(OPENAI_GPT5_OUTPUT_CONTRACT).toContain(
      "Prefer commas, periods, or parentheses over em dashes in normal prose.",
    );
    expect(OPENAI_GPT5_OUTPUT_CONTRACT).toContain(
      "Do not use em dashes unless the user explicitly asks for them or they are required in quoted text.",
    );
  });

  it("defaults to the friendly OpenAI interaction-style overlay", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook();

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        config: undefined,
        agentDir: undefined,
        workspaceDir: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        promptMode: "full",
        runtimeChannel: undefined,
        runtimeCapabilities: undefined,
        agentId: undefined,
      }),
    ).toEqual({
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
      sectionOverrides: {
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
      },
    });
  });

  it("supports opting out of the friendly prompt overlay via plugin config", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "off" },
    });

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        config: undefined,
        agentDir: undefined,
        workspaceDir: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        promptMode: "full",
        runtimeChannel: undefined,
        runtimeCapabilities: undefined,
        agentId: undefined,
      }),
    ).toEqual({
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
      sectionOverrides: {
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
      },
    });
  });

  it("supports explicitly configuring the friendly prompt overlay", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "friendly" },
    });

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        config: undefined,
        agentDir: undefined,
        workspaceDir: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        promptMode: "full",
        runtimeChannel: undefined,
        runtimeCapabilities: undefined,
        agentId: undefined,
      }),
    ).toEqual({
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
      sectionOverrides: {
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
      },
    });
  });
});

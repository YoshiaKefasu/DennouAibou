import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { modelsFallbacksAddCommand } from "./models/fallbacks.js";
import { modelsSetCommand } from "./models/set.js";
import type { updateConfig as UpdateConfig } from "./models/shared.js";

let currentConfig: OpenClawConfig = {};
let writtenConfig: OpenClawConfig | undefined;

const fakeUpdateConfig: typeof UpdateConfig = async (mutator) => {
  const next = mutator(structuredClone(currentConfig));
  writtenConfig = next;
  return next;
};

function mockConfigSnapshot(config: OpenClawConfig = {}) {
  currentConfig = config;
  writtenConfig = undefined;
}

function makeRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function getWrittenConfig() {
  return writtenConfig as OpenClawConfig;
}

function expectWrittenPrimaryModel(model: string) {
  expect(writtenConfig).toBeDefined();
  const written = getWrittenConfig();
  expect(written.agents).toEqual({
    defaults: {
      model: { primary: model },
      models: { [model]: {} },
    },
  });
}

describe("models set + fallbacks", () => {
  beforeEach(() => {
    currentConfig = {};
    writtenConfig = undefined;
  });

  it("normalizes z.ai provider in models set", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await modelsSetCommand("z.ai/glm-4.7", runtime, { updateConfig: fakeUpdateConfig });

    expectWrittenPrimaryModel("zai/glm-4.7");
  });

  it("normalizes z-ai provider in models fallbacks add", async () => {
    mockConfigSnapshot({ agents: { defaults: { model: { fallbacks: [] } } } });
    const runtime = makeRuntime();

    await modelsFallbacksAddCommand("z-ai/glm-4.7", runtime, { updateConfig: fakeUpdateConfig });

    expect(writtenConfig).toBeDefined();
    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: { fallbacks: ["zai/glm-4.7"] },
        models: { "zai/glm-4.7": {} },
      },
    });
  });

  it("preserves primary when adding fallbacks to string defaults.model", async () => {
    mockConfigSnapshot({ agents: { defaults: { model: "openai/gpt-4.1-mini" } } });
    const runtime = makeRuntime();

    await modelsFallbacksAddCommand("anthropic/claude-opus-4-6", runtime, {
      updateConfig: fakeUpdateConfig,
    });

    expect(writtenConfig).toBeDefined();
    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["anthropic/claude-opus-4-6"],
        },
        models: { "anthropic/claude-opus-4-6": {} },
      },
    });
  });

  it("normalizes provider casing in models set", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await modelsSetCommand("Z.AI/glm-4.7", runtime, { updateConfig: fakeUpdateConfig });

    expectWrittenPrimaryModel("zai/glm-4.7");
  });

  it("keeps canonical OpenRouter native ids in models set", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await modelsSetCommand("openrouter/hunter-alpha", runtime, { updateConfig: fakeUpdateConfig });

    expectWrittenPrimaryModel("openrouter/hunter-alpha");
  });

  it("migrates legacy duplicated OpenRouter keys on write", async () => {
    mockConfigSnapshot({
      agents: {
        defaults: {
          models: {
            "openrouter/openrouter/hunter-alpha": {
              params: { thinking: "high" },
            },
          },
        },
      },
    });
    const runtime = makeRuntime();

    await modelsSetCommand("openrouter/hunter-alpha", runtime, { updateConfig: fakeUpdateConfig });

    expect(writtenConfig).toBeDefined();
    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: { primary: "openrouter/hunter-alpha" },
        models: {
          "openrouter/hunter-alpha": {
            params: { thinking: "high" },
          },
        },
      },
    });
  });

  it("rewrites string defaults.model to object form when setting primary", async () => {
    mockConfigSnapshot({ agents: { defaults: { model: "openai/gpt-4.1-mini" } } });
    const runtime = makeRuntime();

    await modelsSetCommand("anthropic/claude-opus-4-6", runtime, {
      updateConfig: fakeUpdateConfig,
    });

    expect(writtenConfig).toBeDefined();
    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
      },
    });
  });
});

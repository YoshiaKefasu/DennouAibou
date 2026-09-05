import type { StreamFn } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  buildProviderStreamFamilyHooks,
  composeProviderStreamWrappers,
} from "./provider-stream.js";

function requireWrapStreamFn(
  wrapStreamFn: ReturnType<typeof buildProviderStreamFamilyHooks>["wrapStreamFn"],
) {
  expect(wrapStreamFn).toBeTypeOf("function");
  if (!wrapStreamFn) {
    throw new Error("expected wrapStreamFn to be defined");
  }
  return wrapStreamFn;
}

function requireStreamFn(streamFn: StreamFn | null | undefined) {
  expect(streamFn).toBeTypeOf("function");
  if (!streamFn) {
    throw new Error("expected wrapped streamFn to be defined");
  }
  return streamFn;
}

describe("composeProviderStreamWrappers", () => {
  it("applies wrappers left to right", async () => {
    const order: string[] = [];
    const baseStreamFn: StreamFn = (_model, _context, _options) => {
      order.push("base");
      return {} as never;
    };

    const wrap =
      (label: string) =>
      (streamFn: StreamFn | undefined): StreamFn =>
      (model, context, options) => {
        order.push(`${label}:before`);
        const result = (streamFn ?? baseStreamFn)(model, context, options);
        order.push(`${label}:after`);
        return result;
      };

    const composed = composeProviderStreamWrappers(baseStreamFn, wrap("a"), undefined, wrap("b"));

    expect(typeof composed).toBe("function");
    void composed?.({} as never, {} as never, {});

    expect(order).toEqual(["b:before", "a:before", "base", "a:after", "b:after"]);
  });

  it("returns the original stream when no wrappers are provided", () => {
    const baseStreamFn: StreamFn = () => ({}) as never;
    expect(composeProviderStreamWrappers(baseStreamFn)).toBe(baseStreamFn);
  });
});

describe("buildProviderStreamFamilyHooks", () => {
  it("covers the stream family matrix", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    let capturedHeaders: Record<string, string | null> | undefined;

    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = { config: { thinkingConfig: { thinkingBudget: -1 } } } as Record<
        string,
        unknown
      >;
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      capturedHeaders = options?.headers;
      return {} as never;
    };

    const kilocodeHooks = buildProviderStreamFamilyHooks("kilocode-thinking");
    void requireStreamFn(
      requireWrapStreamFn(kilocodeHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "high",
        modelId: "openai/gpt-5.4",
      } as never),
    )({ provider: "kilocode", id: "openai/gpt-5.4" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      reasoning: { effort: "high" },
    });

    void requireStreamFn(
      requireWrapStreamFn(kilocodeHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "high",
        modelId: "kilo/auto",
      } as never),
    )({ provider: "kilocode", id: "kilo/auto" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
    });
    expect(capturedPayload).not.toHaveProperty("reasoning");

    const moonshotHooks = buildProviderStreamFamilyHooks("moonshot-thinking");
    const moonshotStream = requireStreamFn(
      requireWrapStreamFn(moonshotHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "off",
      } as never),
    );
    await moonshotStream({ api: "openai-completions", id: "kimi-k2.5" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      thinking: { type: "disabled" },
    });

    const openAiHooks = buildProviderStreamFamilyHooks("openai-responses-defaults");
    void requireStreamFn(
      requireWrapStreamFn(openAiHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        config: {},
        agentDir: "/tmp/provider-stream-test",
      } as never),
    )(
      {
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
      } as never,
      {} as never,
      {},
    );
    expect(capturedHeaders).toBeDefined();

    const openRouterHooks = buildProviderStreamFamilyHooks("openrouter-thinking");
    void requireStreamFn(
      requireWrapStreamFn(openRouterHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "high",
        modelId: "openai/gpt-5.4",
      } as never),
    )({ provider: "openrouter", id: "openai/gpt-5.4" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      reasoning: { effort: "high" },
    });

    void requireStreamFn(
      requireWrapStreamFn(openRouterHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "high",
        modelId: "x-ai/grok-3",
      } as never),
    )({ provider: "openrouter", id: "x-ai/grok-3" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
    });
    expect(capturedPayload).not.toHaveProperty("reasoning");

    const toolStreamHooks = buildProviderStreamFamilyHooks("tool-stream-default-on");
    const toolStreamDefault = requireStreamFn(
      requireWrapStreamFn(toolStreamHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        extraParams: {},
      } as never),
    );
    await toolStreamDefault({ id: "glm-4.7" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      tool_stream: true,
    });

    const toolStreamDisabled = requireStreamFn(
      requireWrapStreamFn(toolStreamHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        extraParams: { tool_stream: false },
      } as never),
    );
    await toolStreamDisabled({ id: "glm-4.7" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
    });
    expect(capturedPayload).not.toHaveProperty("tool_stream");
  });
});

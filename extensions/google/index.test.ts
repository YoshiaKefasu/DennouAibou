import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import type {
  ProviderReplaySessionEntry,
  ProviderSanitizeReplayHistoryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import googlePlugin from "./index.js";

describe("google provider plugin hooks", () => {
  it("owns replay policy and reasoning mode for the direct Gemini provider", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googlePlugin,
      id: "google",
      name: "Google Provider",
    });
    const provider = requireRegisteredProvider(providers, "google");
    const customEntries: ProviderReplaySessionEntry[] = [];

    expect(
      provider.buildReplayPolicy?.({
        provider: "google",
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
      } as never),
    ).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
      repairToolUseResultPairing: true,
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: false,
      allowSyntheticToolResults: true,
    });

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "google",
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
      } as never),
    ).toBe("tagged");

    const sanitized = await Promise.resolve(
      provider.sanitizeReplayHistory?.({
        provider: "google",
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
        sessionId: "session-1",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
          },
        ],
        sessionState: {
          getCustomEntries: () => customEntries,
          appendCustomEntry: (customType: string, data: unknown) => {
            customEntries.push({ customType, data });
          },
        },
      } as ProviderSanitizeReplayHistoryContext),
    );

    expect(sanitized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "(session bootstrap)",
        }),
      ]),
    );
    expect(customEntries).toHaveLength(1);
    expect(customEntries[0]?.customType).toBe("google-turn-ordering-bootstrap");
  });

  it("owns Gemini CLI tool schema normalization", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googlePlugin,
      id: "google",
      name: "Google Provider",
    });
    const provider = requireRegisteredProvider(providers, "google-gemini-cli");

    const [tool] =
      provider.normalizeToolSchemas?.({
        provider: "google-gemini-cli",
        tools: [
          {
            name: "write_file",
            description: "Write a file",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", pattern: "^src/" },
              },
            },
          },
        ],
      } as never) ?? [];

    expect(tool).toMatchObject({
      name: "write_file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
    });
    expect(tool?.parameters).not.toHaveProperty("additionalProperties");
    expect(
      (tool?.parameters as { properties?: { path?: Record<string, unknown> } })?.properties?.path,
    ).not.toHaveProperty("pattern");
    expect(
      provider.inspectToolSchemas?.({
        provider: "google-gemini-cli",
        tools: [tool],
      } as never),
    ).toEqual([]);
  });

  it("wires google-thinking stream hooks for direct and Gemini CLI providers", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googlePlugin,
      id: "google",
      name: "Google Provider",
    });
    const googleProvider = requireRegisteredProvider(providers, "google");
    const cliProvider = requireRegisteredProvider(providers, "google-gemini-cli");
    let capturedPayload: Record<string, unknown> | undefined;

    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = { config: { thinkingConfig: { thinkingBudget: -1 } } } as Record<
        string,
        unknown
      >;
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {} as never;
    };

    const runCase = (provider: typeof googleProvider, providerId: string) => {
      const wrapped = provider.wrapStreamFn?.({
        provider: providerId,
        modelId: "gemini-3.1-pro-preview",
        thinkingLevel: "high",
        streamFn: baseStreamFn,
      } as never);

      void wrapped?.(
        {
          api: "google-generative-ai",
          provider: providerId,
          id: "gemini-3.1-pro-preview",
        } as Model<"google-generative-ai">,
        { messages: [] } as Context,
        {},
      );

      expect(capturedPayload).toMatchObject({
        config: { thinkingConfig: { thinkingLevel: "HIGH" } },
      });
      const thinkingConfig = (
        (capturedPayload as Record<string, unknown>).config as Record<string, unknown>
      ).thinkingConfig as Record<string, unknown>;
      expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
    };

    runCase(googleProvider, "google");
    runCase(cliProvider, "google-gemini-cli");
  });

  it("Gemini CLI resolveDynamicModel selects 3.1 template for raw gemini-3.1-flash-preview", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googlePlugin,
      id: "google",
      name: "Google Provider",
    });
    const cliProvider = requireRegisteredProvider(providers, "google-gemini-cli");

    // Gemini CLI provider does not own normalizeModelId — the raw 3.1 ID
    // reaches resolveDynamicModel directly from persisted config.
    expect(cliProvider.normalizeModelId).toBeUndefined();

    const cli31Template = {
      id: "gemini-3.1-flash-preview",
      name: "gemini-3.1-flash-preview",
      provider: "google-gemini-cli",
      api: "google-gemini-cli",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      reasoning: false,
      input: ["text", "image"] as readonly ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 64_000,
    };
    const cli30Template = {
      id: "gemini-3-flash-preview",
      name: "gemini-3-flash-preview",
      provider: "google-gemini-cli",
      api: "google-gemini-cli",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      reasoning: false,
      input: ["text", "image"] as readonly ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    };

    const resolved = cliProvider.resolveDynamicModel?.({
      provider: "google-gemini-cli",
      modelId: "gemini-3.1-flash-preview",
      modelRegistry: {
        find(_providerId: string, modelId: string) {
          if (modelId === "gemini-3.1-flash-preview") return cli31Template;
          if (modelId === "gemini-3-flash-preview") return cli30Template;
          return null;
        },
      },
    } as never);

    // Must select the 3.1 template, not the 3.0 fallback.
    expect(resolved).toBeDefined();
    expect(resolved).toMatchObject({
      provider: "google-gemini-cli",
      id: "gemini-3.1-flash-preview",
      contextWindow: 1_048_576,
    });
  });
});

import type { Mock } from "vitest";
import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadModelCatalog } from "../agents/model-catalog.js";
import * as modelSelection from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import {
  DEFAULT_AGENT_TURN_PAYLOAD,
  DEFAULT_MESSAGE,
  GMAIL_MODEL,
  expectEmbeddedProviderModel,
  runCronTurn,
  runGmailHookTurn,
  runTurnWithStoredModelOverride,
  withTempHome,
} from "./isolated-agent.turn-test-helpers.js";

describe("runCronIsolatedAgentTurn model overrides", () => {
  beforeEach(() => {
    vi.spyOn(modelSelection, "resolveThinkingDefault").mockReturnValue("off");
    (runEmbeddedPiAgent as Mock).mockClear();
    (loadModelCatalog as Mock).mockResolvedValue([]);
  });

  it("treats blank model overrides as unset", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "   " },
      });

      expect(res.status).toBe("ok");
      expect(runEmbeddedPiAgent as Mock).toHaveBeenCalledTimes(1);
    });
  });

  it("applies model overrides with correct precedence", async () => {
    await withTempHome(async (home) => {
      const deterministicCatalog = [
        {
          id: "gpt-4.1-mini",
          name: "GPT-4.1 Mini",
          provider: "openai",
        },
        {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.5",
          provider: "anthropic",
        },
      ];
      (loadModelCatalog as Mock).mockResolvedValue(deterministicCatalog);

      let res = (
        await runCronTurn(home, {
          jobPayload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openai/gpt-4.1-mini",
          },
        })
      ).res;
      expect(res.status).toBe("ok");
      const directModel = expectEmbeddedProviderModel({
        provider: "openai",
        model: "gpt-4.1-mini",
      });
      directModel.assert();

      res = (await runTurnWithStoredModelOverride(home, DEFAULT_AGENT_TURN_PAYLOAD)).res;
      expect(res.status).toBe("ok");
      const storedOverride = expectEmbeddedProviderModel({
        provider: "openai",
        model: "gpt-4.1-mini",
      });
      storedOverride.assert();

      res = (
        await runTurnWithStoredModelOverride(home, {
          kind: "agentTurn",
          message: DEFAULT_MESSAGE,
          model: "anthropic/claude-opus-4-6",
        })
      ).res;
      expect(res.status).toBe("ok");
      const explicitOverride = expectEmbeddedProviderModel({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      explicitOverride.assert();
    });
  });

  it("uses hooks.gmail.model and keeps precedence over stored session override", async () => {
    await withTempHome(async (home) => {
      let res = (await runGmailHookTurn(home)).res;
      expect(res.status).toBe("ok");
      const gmailModel = expectEmbeddedProviderModel({
        provider: "openrouter",
        model: GMAIL_MODEL.replace("openrouter/", ""),
      });
      gmailModel.assert();

      (runEmbeddedPiAgent as Mock).mockClear();
      res = (
        await runGmailHookTurn(home, {
          "agent:main:hook:gmail:msg-1": {
            sessionId: "existing-gmail-session",
            updatedAt: Date.now(),
            providerOverride: "anthropic",
            modelOverride: "claude-opus-4-6",
          },
        })
      ).res;
      expect(res.status).toBe("ok");
      const storedGmailModel = expectEmbeddedProviderModel({
        provider: "openrouter",
        model: GMAIL_MODEL.replace("openrouter/", ""),
      });
      storedGmailModel.assert();
    });
  });

  it("ignores hooks.gmail.model when not in the allowlist", async () => {
    await withTempHome(async (home) => {
      (loadModelCatalog as Mock).mockResolvedValueOnce([
        {
          id: "claude-opus-4-6",
          name: "Opus 4.5",
          provider: "anthropic",
        },
      ]);

      const { res } = await runCronTurn(home, {
        cfgOverrides: {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-6" },
              models: {
                "anthropic/claude-opus-4-6": { alias: "Opus" },
              },
            },
          },
          hooks: {
            gmail: {
              model: GMAIL_MODEL,
            },
          },
        },
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
        sessionKey: "hook:gmail:msg-2",
      });

      expect(res.status).toBe("ok");
      const ignoredGmailModel = expectEmbeddedProviderModel({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      ignoredGmailModel.assert();
    });
  });

  it("rejects invalid model override", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: {
          kind: "agentTurn",
          message: DEFAULT_MESSAGE,
          model: "openai/",
        },
        mockTexts: null,
      });

      expect(res.status).toBe("error");
      expect(res.error).toMatch("invalid model");
      expect(runEmbeddedPiAgent as Mock).not.toHaveBeenCalled();
    });
  });

  it("passes through the resolved default thinking level", async () => {
    await withTempHome(async (home) => {
      (modelSelection.resolveThinkingDefault as Mock).mockReturnValueOnce("low");

      await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
        mockTexts: ["done"],
      });

      const callArgs = (runEmbeddedPiAgent as Mock).mock.calls.at(-1)?.[0];
      expect(callArgs?.thinkLevel).toBe("low");
    });
  });
});

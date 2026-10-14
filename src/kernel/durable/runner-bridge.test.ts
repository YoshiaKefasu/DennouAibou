import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FauxProviderHandle, FauxResponseFactory } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded-runner/run.js";
import type { RunEmbeddedPiAgentParams } from "../../agents/pi-embedded-runner/run/params.js";
import type { EmbeddedPiRunResult } from "../../agents/pi-embedded-runner/types.js";
import { runDurableKernelAgent } from "./runner-bridge.js";

/** Model ref of the faux test provider's default model (`fauxProvider()`). */
const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A valid 1x1 RGBA PNG. */
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==";

/** faux-provider-backed pi-ai `Models` with the given queued answer. */
function openFauxModels(answer: string): { models: Models; faux: FauxProviderHandle } {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(answer)]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}

/**
 * Temporary directory cleanup. Windows + Bun keeps the SQLite file handle after close, so an
 * immediate delete can hit EBUSY; a leftover directory in %TEMP% must not fail the test.
 */
async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "runner-bridge-"));
  try {
    await run(dir);
  } finally {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await delay(300);
      }
    }
  }
}

/** Minimal run params aimed at the faux provider; stateDir/seams are injected per test. */
function baseKernelParams(stateDir: string): RunEmbeddedPiAgentParams {
  return {
    sessionId: "kernel-bridge-session",
    sessionKey: "agent:test:kernel-bridge",
    agentId: "main",
    sessionFile: join(stateDir, "session.jsonl"),
    workspaceDir: stateDir,
    prompt: "hello kernel",
    provider: FAUX_MODEL.provider,
    model: FAUX_MODEL.modelId,
    timeoutMs: 30_000,
    runId: "kernel-bridge-run",
  };
}

describe("runDurableKernelAgent", () => {
  it("returns the kernel answer as an EmbeddedPiRunResult payload", async () => {
    await withStateDir(async (stateDir) => {
      const { models, faux } = openFauxModels("Paris");
      const params = baseKernelParams(stateDir);

      const result = await runDurableKernelAgent(params, {
        resolveSessionStateDir: () => stateDir,
        createModels: () => models,
      });

      expect(result.payloads?.[0]?.text).toBe("Paris");
      expect(result.payloads?.[0]?.isError).toBeUndefined();
      expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.meta.agentMeta).toEqual({
        sessionId: "kernel-bridge-session",
        provider: "faux",
        model: "faux-1",
      });
      expect(faux.state.callCount).toBe(1);
      // Durable admission: the turn committed to <stateDir>/session.sqlite.
      expect(existsSync(join(stateDir, "session.sqlite"))).toBe(true);
    });
  });

  it("forwards images to the kernel as multimodal turn content", async () => {
    await withStateDir(async (stateDir) => {
      const imageResponse: FauxResponseFactory = (context) => {
        const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
        const blocks =
          lastUser && Array.isArray(lastUser.content) ? lastUser.content : ([] as const);
        const sawImage = blocks.some((block) => block.type === "image");
        return fauxAssistantMessage(sawImage ? "saw image" : "no image");
      };
      const faux = fauxProvider();
      faux.setResponses([imageResponse]);
      const models = createModels();
      models.setProvider(faux.provider);

      const result = await runDurableKernelAgent(
        {
          ...baseKernelParams(stateDir),
          images: [{ type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" }],
        },
        { resolveSessionStateDir: () => stateDir, createModels: () => models },
      );

      expect(result.payloads?.[0]?.text).toBe("saw image");
    });
  });

  it("notifies onPartialReply and onBlockReply with the answer", async () => {
    await withStateDir(async (stateDir) => {
      const { models } = openFauxModels("pong");
      const partials: string[] = [];
      const blocks: string[] = [];

      const result = await runDurableKernelAgent(
        {
          ...baseKernelParams(stateDir),
          onPartialReply: ({ text }) => {
            partials.push(text ?? "");
          },
          onBlockReply: ({ text }) => {
            blocks.push(text ?? "");
          },
        },
        { resolveSessionStateDir: () => stateDir, createModels: () => models },
      );

      expect(result.payloads?.[0]?.text).toBe("pong");
      expect(partials).toEqual(["pong"]);
      expect(blocks).toEqual(["pong"]);
    });
  });

  it("returns an isError payload instead of throwing when the kernel fails", async () => {
    await withStateDir(async (stateDir) => {
      const result = await runDurableKernelAgent(baseKernelParams(stateDir), {
        resolveSessionStateDir: () => stateDir,
        createModels: () => {
          throw new Error("boom");
        },
      });

      expect(result.payloads).toEqual([{ text: "boom", isError: true }]);
      expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});

const mockedRunDurableKernelAgent =
  vi.fn<(params: RunEmbeddedPiAgentParams) => Promise<EmbeddedPiRunResult>>();
const kernelResult: EmbeddedPiRunResult = {
  payloads: [{ text: "kernel answer" }],
  meta: { durationMs: 7 },
};

describe("runEmbeddedPiAgent kernel dispatch", () => {
  const baseParams: RunEmbeddedPiAgentParams = {
    sessionId: "test-session",
    sessionKey: "test-key",
    sessionFile: join(tmpdir(), "kernel-dispatch-session.jsonl"),
    workspaceDir: join(tmpdir(), "kernel-dispatch-workspace"),
    prompt: "hello",
    provider: "faux",
    model: "faux-1",
    timeoutMs: 30_000,
    runId: "kernel-dispatch-run",
    enqueue: <T>(task: () => Promise<T>): Promise<T> => task(),
  };

  beforeEach(() => {
    mockedRunDurableKernelAgent.mockReset();
    mockedRunDurableKernelAgent.mockResolvedValue(kernelResult);
  });

  it("dispatches to the durable kernel bridge when DENNOU_KERNEL=durable", async () => {
    setTestEnv("DENNOU_KERNEL", "durable");

    const result = await runEmbeddedPiAgent(baseParams, {
      runDurableKernelAgent: mockedRunDurableKernelAgent,
    });

    expect(mockedRunDurableKernelAgent).toHaveBeenCalledTimes(1);
    expect(mockedRunDurableKernelAgent).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "hello", sessionId: "test-session" }),
    );
    expect(result).toBe(kernelResult);
  });

  it("dispatches to the durable kernel bridge when agents.defaults.kernel=durable", async () => {
    setTestEnv("DENNOU_KERNEL", undefined);

    const result = await runEmbeddedPiAgent(
      {
        ...baseParams,
        config: { agents: { defaults: { kernel: "durable" } } },
      },
      { runDurableKernelAgent: mockedRunDurableKernelAgent },
    );

    expect(mockedRunDurableKernelAgent).toHaveBeenCalledTimes(1);
    expect(result).toBe(kernelResult);
  });

  it("keeps the legacy pi-embedded-runner when the kernel flag is unset", async () => {
    setTestEnv("DENNOU_KERNEL", undefined);

    await expect(
      runEmbeddedPiAgent(baseParams, {
        runDurableKernelAgent: mockedRunDurableKernelAgent,
        ensureRuntimePluginsLoaded: () => {},
        ensureOpenClawModelsJson: async () => ({ agentDir: "", wrote: false }),
        resolveModelAsync: async () => {
          throw new Error("legacy path entered");
        },
      }),
    ).rejects.toThrow("legacy path entered");

    expect(mockedRunDurableKernelAgent).not.toHaveBeenCalled();
  });
});

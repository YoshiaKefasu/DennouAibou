import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { DurableKernel } from "./durable-kernel.js";

/** Model ref of the faux test provider's default model. */
const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

/** A valid 1x1 RGBA PNG. */
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function openKernel(stateDir: string, faux: FauxProviderHandle): Promise<DurableKernel> {
  const models = createModels();
  models.setProvider(faux.provider);
  return await DurableKernel.create({ stateDir, models, defaultModel: { ...FAUX_MODEL } });
}

/**
 * Temporary directory cleanup. Windows + Bun keeps the SQLite file handle after close, so an
 * immediate delete can hit EBUSY; a leftover directory in %TEMP% must not fail the test.
 */
async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await delay(500);
    }
  }
}

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "durable-kernel-"));
  try {
    await run(dir);
  } finally {
    await cleanupDir(dir);
  }
}

describe("DurableKernel", () => {
  it("submitTurn が 1 ターンの応答を返す", async () => {
    await withStateDir(async (stateDir) => {
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage("Paris")]);
      const kernel = await openKernel(stateDir, faux);
      try {
        const result = await kernel.submitTurn({ text: "What is the capital of France?" });

        expect(result.answer).toBe("Paris");
        expect(result.turnId).toBeDefined();
        expect(result.toolResults).toEqual([]);
        expect(faux.state.callCount).toBe(1);
      } finally {
        await kernel.close();
      }
    });
  });

  it("installExtension で追加したツールをモデルが呼び、結果が返る", async () => {
    await withStateDir(async (stateDir) => {
      const echoCalls: string[] = [];
      const echoTool = defineTool({
        name: "echo",
        description: "Echoes the given text back.",
        parameters: Type.Object({ text: Type.String() }),
        async execute({ text }) {
          echoCalls.push(text);
          return { output: [{ type: "text", text: `echo:${text}` }] };
        },
      });

      // Tool-call turn, then the final turn that answers once the result is in the transcript.
      const echoResponse: FauxResponseFactory = (context) =>
        context.messages.some((message) => message.role === "toolResult")
          ? fauxAssistantMessage("tool done")
          : fauxAssistantMessage([fauxToolCall("echo", { text: "ping" })], {
              stopReason: "toolUse",
            });
      const faux = fauxProvider();
      faux.setResponses([echoResponse, echoResponse, echoResponse]);

      const kernel = await openKernel(stateDir, faux);
      try {
        kernel.installExtension(defineExtension({ name: "kernel-test-tools", tools: [echoTool] }));

        const result = await kernel.submitTurn({ text: "run the echo tool" });

        expect(result.answer).toBe("tool done");
        expect(echoCalls).toEqual(["ping"]);
        expect(result.toolResults).toEqual([{ name: "echo", output: "echo:ping", isError: false }]);
        expect(faux.state.callCount).toBe(2);
      } finally {
        await kernel.close();
      }
    });
  });

  it("画像ブロックがプロバイダまで渡る", async () => {
    await withStateDir(async (stateDir) => {
      const imageResponse: FauxResponseFactory = (context) => {
        const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
        const image =
          lastUser && Array.isArray(lastUser.content)
            ? lastUser.content.find((block) => block.type === "image")
            : undefined;
        return fauxAssistantMessage(image ? `image:${image.mimeType}` : "no image");
      };
      const faux = fauxProvider();
      faux.setResponses([imageResponse]);

      const kernel = await openKernel(stateDir, faux);
      try {
        const result = await kernel.submitTurn({
          content: [
            { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
            { type: "text", text: "describe this image" },
          ],
        });

        expect(result.answer).toBe("image:image/png");
        expect(faux.state.callCount).toBe(1);
      } finally {
        await kernel.close();
      }
    });
  });

  it("中断後に resume() と waitTurn() で同じターンが完走する", async () => {
    await withStateDir(async (stateDir) => {
      // A slow provider makes the first process close while the generation is still streaming.
      const faux = fauxProvider({ tokensPerSecond: 6 });
      const answer: FauxResponseFactory = () => fauxAssistantMessage("recovered after restart");
      faux.setResponses([answer]);

      const kernel1 = await openKernel(stateDir, faux);
      const turn = await kernel1.submit({ text: "durable ping" });
      const started = Date.now();
      while (faux.state.callCount === 0 && Date.now() - started < 5000) {
        await delay(20);
      }
      expect(faux.state.callCount).toBe(1);
      await kernel1.close(); // crash equivalent: the generation is still running

      // Second "process": same directory, resumed. The interrupted generation re-requests.
      faux.appendResponses([answer, answer]);
      const kernel2 = await openKernel(stateDir, faux);
      try {
        await kernel2.resume();
        const result = await kernel2.waitTurn(turn);

        expect(result.answer).toBe("recovered after restart");
        expect(faux.state.callCount).toBeGreaterThanOrEqual(1);
      } finally {
        await kernel2.close();
      }
    });
  });

  it("再オープンしたカーネルが前のターンを覚えている", async () => {
    await withStateDir(async (stateDir) => {
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

      let firstAnswer = "";
      const kernel1 = await openKernel(stateDir, faux);
      try {
        firstAnswer = (await kernel1.submitTurn({ text: "one" })).answer;
      } finally {
        await kernel1.close();
      }
      expect(firstAnswer).toBe("first");

      const kernel2 = await openKernel(stateDir, faux);
      try {
        const second = await kernel2.submitTurn({ text: "two" });
        expect(second.answer).toBe("second");
      } finally {
        await kernel2.close();
      }
    });
  });
});

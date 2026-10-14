import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  type Conversation,
} from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { FAUX_MODEL, openMemoryHarness, openSqliteHarness } from "../src/harness";
import { Type } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";

/** A valid 1x1 RGBA PNG, generated with node:zlib (see spike notes). */
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==";

const CONTEXT: Context = BACKGROUND_CONTEXT;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 一時ディレクトリの後始末。Windows + Bun の node:sqlite は close 後もファイルハンドルを保持し、
 * 直後に削除すると EBUSY になることがあるため、失敗してもテストは落とさない（%TEMP% に残るのみ）。
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

async function openRoot(provider: Provider): Promise<Conversation> {
  const { harness } = await openMemoryHarness(provider);
  return harness.root(CONTEXT, { agent: { model: { ...FAUX_MODEL } } });
}

async function lastAssistantText(root: Conversation): Promise<string> {
  const view = await root.context(CONTEXT);
  const last = [...view.messages].reverse().find((message) => message.role === "assistant");
  if (!last) throw new Error("no assistant message in transcript");
  return last.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function findToolResult(messages: readonly Message[]): ToolResultMessage | undefined {
  return [...messages]
    .reverse()
    .find((message): message is ToolResultMessage => message.role === "toolResult");
}

describe("pi-durable spike", () => {
  test("MemoryStorage で単発の会話が完走する", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("Paris")]);

    const root = await openRoot(faux.provider);
    const submission = await root.submit({ type: "input", content: "What is the capital of France?" }, CONTEXT);
    const settled = await submission.wait(CONTEXT);

    expect(settled.status).toBe("done");
    expect(await lastAssistantText(root)).toBe("Paris");
    expect(faux.state.callCount).toBe(1);
  });

  test("カスタムツールをモデルが呼び出し、結果が履歴に残る", async () => {
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
    const registry = createRegistry();
    registry.install(defineExtension({ name: "spike-tools", tools: [echoTool] }));

    const echoResponse: FauxResponseFactory = (context) =>
      context.messages.some((message) => message.role === "toolResult")
        ? fauxAssistantMessage("tool done")
        : fauxAssistantMessage([fauxToolCall("echo", { text: "ping" })], { stopReason: "toolUse" });
    const faux = fauxProvider();
    faux.setResponses([echoResponse, echoResponse, echoResponse]);

    const { harness } = await openMemoryHarness(faux.provider, { registry });
    const root = await harness.root(CONTEXT, { agent: { model: { ...FAUX_MODEL } } });
    const settled = await (
      await root.submit({ type: "input", content: "run the echo tool" }, CONTEXT)
    ).wait(CONTEXT);

    expect(settled.status, `settled=${JSON.stringify(settled)}`).toBe("done");
    expect(echoCalls).toEqual(["ping"]);
    expect(await lastAssistantText(root)).toBe("tool done");

    const toolResult = findToolResult((await root.context(CONTEXT)).messages);
    expect(toolResult).toBeDefined();
    expect(toolResult?.isError).toBe(false);
    expect(
      toolResult?.content.some(
        (block) => block.type === "text" && block.text.includes("echo:ping"),
      ),
    ).toBe(true);
    expect(faux.state.callCount).toBe(2); // tool-call turn + final turn

    await harness.close(CONTEXT);
  });

  test("プロセス中断後も SQLite から再開して完了できる（durable resume）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spike-pi-durable-"));
    const dbPath = join(dir, "session.sqlite");
    try {
      // tokensPerSecond を絞って provider 応答をわざと遅くし、確実にストリーム中で中断する。
      const faux = fauxProvider({ tokensPerSecond: 6 });
      const answer: FauxResponseFactory = () => fauxAssistantMessage("recovered after restart");
      faux.setResponses([answer]);

      // 1st "process": 入力を出して generation が provider に到達したところで完了を待たずに閉じる。
      const harness1 = await openSqliteHarness(dbPath, faux.provider);
      const root1 = await harness1.harness.root(CONTEXT, { agent: { model: { ...FAUX_MODEL } } });
      const submission = await root1.submit({ type: "input", content: "durable ping" }, CONTEXT);
      await delay(300); // generation が provider リクエスト中であることを待つ

      expect(faux.state.callCount).toBe(1);
      expect((await submission.status(CONTEXT)).status).not.toBe("done");

      await harness1.harness.close(CONTEXT); // crash 相当

      // 2nd "process": 同じファイルを開き直して resume() する。
      const harness2 = await openSqliteHarness(dbPath, faux.provider);
      faux.appendResponses([answer, answer]); // 中断された generation は再リクエストする
      harness2.harness.resume();
      const requeued = await harness2.harness.submission(submission.id, CONTEXT);
      expect(requeued).toBeDefined();
      expect((await requeued!.status(CONTEXT)).status).not.toBe("done"); // 作業は pending のまま
      const inspection = await harness2.harness.inspect(CONTEXT);
      expect(inspection.tasks.length).toBeGreaterThan(0); // generation task が生きている

      const settled = await requeued!.wait(CONTEXT);
      expect(settled.status).toBe("done");
      expect(faux.state.callCount).toBeGreaterThanOrEqual(2); // 再リクエストされた

      const root2 = await harness2.harness.root(CONTEXT, { agent: { model: { ...FAUX_MODEL } } });
      expect(await lastAssistantText(root2)).toBe("recovered after restart");
      await harness2.harness.close(CONTEXT);

      // 3rd reopen: 完了した transcript が永続化されている。
      const harness3 = await openSqliteHarness(dbPath, faux.provider);
      const root3 = await harness3.harness.root(CONTEXT, { agent: { model: { ...FAUX_MODEL } } });
      expect(await lastAssistantText(root3)).toBe("recovered after restart");
      await harness3.harness.close(CONTEXT);
    } finally {
      await cleanupDir(dir);
    }
  });

  test("画像入力を ImageContent として provider まで渡せる", async () => {
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

    const root = await openRoot(faux.provider);
    const settled = await (
      await root.submit(
        {
          type: "input",
          content: [
            { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
            { type: "text", text: "describe this image" },
          ],
        },
        CONTEXT,
      )
    ).wait(CONTEXT);

    expect(settled.status).toBe("done");
    expect(await lastAssistantText(root)).toBe("image:image/png");
    expect(faux.state.callCount).toBe(1);
  });

  test("read ツールが画像ファイルを ImageContent として返す（coding-tools + env）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spike-pi-durable-img-"));
    try {
      const pngPath = join(dir, "pixel.png");
      writeFileSync(pngPath, Buffer.from(PNG_1X1_BASE64, "base64"));

      const registry = createRegistry();
      registry.install(createCodingTools());

      const readResponse: FauxResponseFactory = (context) =>
        context.messages.some((message) => message.role === "toolResult")
          ? fauxAssistantMessage("read ok")
          : fauxAssistantMessage([fauxToolCall("read", { path: pngPath })], {
              stopReason: "toolUse",
            });
      const faux = fauxProvider();
      faux.setResponses([readResponse, readResponse, readResponse]);

      const { harness } = await openMemoryHarness(faux.provider, {
        registry,
        env: () => new NodeExecutionEnv({ cwd: dir }),
      });
      const root = await harness.root(CONTEXT, { agent: { model: { ...FAUX_MODEL } } });
      const settled = await (
        await root.submit({ type: "input", content: "read the png" }, CONTEXT)
      ).wait(CONTEXT);

      expect(settled.status, `settled=${JSON.stringify(settled)}`).toBe("done");
      expect(await lastAssistantText(root)).toBe("read ok");

      const toolResult = findToolResult((await root.context(CONTEXT)).messages);
      expect(toolResult).toBeDefined();
      expect(toolResult?.isError).toBe(false);
      expect(toolResult?.content.some((block) => block.type === "image")).toBe(true);

      await harness.close(CONTEXT);
    } finally {
      await cleanupDir(dir);
    }
  });
});

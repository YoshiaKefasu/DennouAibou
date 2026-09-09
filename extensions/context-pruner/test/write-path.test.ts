/**
 * context-pruner の書き込み経路（write-path）E2E テスト
 *
 * 実際のプラグインエントリ（extensions/context-pruner/index.ts）をプラグインローダ経由で
 * 登録し、guarded SessionManager を通してセッションJSONL相当の書き込みを行い、
 * 以下を検証する:
 *
 * - `tool_result_persist` フックが実配線で機能する
 * - 直近3ターン保護（フェンス）: 最初の keepLastAssistants ターンは生データ保持
 * - フェンス越え後の大きめツール結果は正準プレースホルダー化される
 * - JSON構造（id / parentId / toolCallId / toolName / isError）と親子リンクが不破壊
 *   （SESSION_INTEGRITY_GUARD 相当の検証を通過: 各行が有効JSON・孤児ツール結果なし）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { runHealthCheck } from "../../../extensions/session-integrity-guard/src/health-check.js";
import { guardSessionManager } from "../../../src/agents/session-tool-result-guard-wrapper.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../src/plugins/hook-runner-global.js";
import { loadOpenClawPlugins } from "../../../src/plugins/loader.js";

const REAL_PLUGIN_ENTRY = pathToFileURL(
  path.resolve(process.cwd(), "extensions/context-pruner/index.ts"),
).href;

function writeTempPlugin(dir: string, id: string, entryUrl: string): string {
  const pluginDir = path.join(dir, id);
  fs.mkdirSync(pluginDir, { recursive: true });
  const file = path.join(pluginDir, "index.mjs");
  fs.writeFileSync(
    file,
    `import entry from ${JSON.stringify(entryUrl)}; export default entry;`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      kind: "memory",
      // ローダは configSchema なしをロードエラー扱いするため最小スキーマを添える
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf8",
  );
  return file;
}

/** アシスタント（toolCall含む）→ ツール結果 の1ターン分を書き込む */
function appendOneTurn(sm: SessionManager, turnIndex: number, toolText: string): void {
  const append = sm.appendMessage.bind(sm) as unknown as (message: unknown) => void;
  append({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `call-${turnIndex}`,
        name: "read_file",
        arguments: { path: "/tmp/foo.ts" },
      },
    ],
    timestamp: Date.now(),
  } as never);
  append({
    role: "toolResult",
    toolCallId: `call-${turnIndex}`,
    toolName: "read_file",
    isError: false,
    content: [{ type: "text", text: toolText }],
    timestamp: Date.now(),
  } as never);
}

function persistedToolResultText(sm: SessionManager, turnIndex: number): string {
  const entries = sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: { role?: string } }).message)
    .filter((m) => m.role === "toolResult") as {
    toolCallId?: string;
    content: { text: string }[];
  }[];
  const match = entries.find((m) => m.toolCallId === `call-${turnIndex}`);
  if (!match) {
    throw new Error(`missing persisted toolResult for call-${turnIndex}`);
  }
  return match.content[0]?.text ?? "";
}

afterEach(() => {
  resetGlobalHookRunner();
  delete process.env.DENNOU_BUNDLED_PLUGINS_DIR;
});

describe("context-pruner write-path (real plugin entry)", () => {
  it("keeps the first keepLastAssistants turns raw and placeholder-izes later oversized results", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-pruner-e2e-"));
    process.env.DENNOU_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const pluginFile = writeTempPlugin(tmp, "context-pruner", REAL_PLUGIN_ENTRY);

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          // kind: "memory" のプラグインはメモリスロットに選定されないとロードされない
          slots: { memory: "context-pruner" },
          load: { paths: [pluginFile] },
          allow: ["context-pruner"],
        },
      },
    });
    initializeGlobalHookRunner(registry);

    // ロード確認（メモリスロット選定が効いていること）
    expect(getGlobalHookRunner()?.hasHooks("tool_result_persist")).toBe(true);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    const bigText = "T".repeat(2_000);
    // ターン1〜3: フェンス内 → 生データのまま
    for (let turn = 1; turn <= 3; turn++) {
      appendOneTurn(sm, turn, bigText);
      expect(persistedToolResultText(sm, turn)).toBe(bigText);
    }
    // ターン4〜5: フェンス越え → 正準プレースホルダー化（2000文字 → 2KB）
    for (let turn = 4; turn <= 5; turn++) {
      appendOneTurn(sm, turn, bigText);
      expect(persistedToolResultText(sm, turn)).toBe("[出力省略: 1行 / 2KB 正常終了]");
    }

    // ── JSONL 不破壊（SESSION_INTEGRITY_GUARD 相当）──
    // 全エントリをJSONLとして再シリアライズ → 各行が有効JSONで、構造フィールドが保持される
    const lines = sm
      .getEntries()
      .map((entry) => JSON.stringify(entry))
      .filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    const toolResults: Array<{
      type: string;
      id?: unknown;
      message: { role: string; toolCallId?: string; toolName?: string; isError?: boolean };
    }> = [];
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line) as {
        type?: string;
        id?: unknown;
        message?: { role?: string; toolCallId?: string; toolName?: string; isError?: boolean };
      };
      expect(parsed).toBeTruthy();
      if (parsed.type !== "message" || !parsed.message) {
        continue;
      }
      if (parsed.message.role === "toolResult") {
        toolResults.push(parsed as never);
      }
    }

    // ツール結果の親子リンク: 各 toolResult に toolCallId / toolName / isError が残っている
    expect(toolResults).toHaveLength(5);
    for (let i = 0; i < toolResults.length; i++) {
      const tr = toolResults[i]!;
      expect(tr.message.role).toBe("toolResult");
      expect(tr.message.toolCallId).toBe(`call-${i + 1}`);
      expect(tr.message.toolName).toBe("read_file");
      expect(tr.message.isError).toBe(false);
    }

    // 孤児ツール結果がない: 各 toolResult の toolCallId はアシスタント側の toolCall と一致する
    const assistantToolCallIds = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        message?: {
          role?: string;
          content?: Array<{ type?: string; id?: string }>;
        };
      };
      const content = parsed.message?.content ?? [];
      for (const block of content) {
        if (block?.type === "toolCall" && block.id) {
          assistantToolCallIds.add(block.id);
        }
      }
    }
    for (const tr of toolResults) {
      expect(assistantToolCallIds.has(tr.message.toolCallId!)).toBe(true);
    }

    // ── SESSION_INTEGRITY_GUARD 本体の検証を通過すること ──
    // 孤児ノード・不正JSON行・重複IDが一切ないことを、実際の integrity ヘルスチェックで確認する
    const health = runHealthCheck(lines.join("\n"));
    expect(health.jsonErrorCount).toBe(0);
    expect(health.duplicateIdCount).toBe(0);
    expect(health.orphanCount).toBe(0);
    expect(health.orphanEntries).toEqual([]);
    expect(health.totalLines).toBeGreaterThan(0);
  });
});

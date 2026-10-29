import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../src/agents/defaults.js";
import type { RunEmbeddedPiAgentParams } from "../../../src/agents/pi-embedded-runner/run/params.js";
import type { AnyAgentTool } from "../../../src/agents/tools/common.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import pluginEntry from "../index.js";
import {
  createEmbeddedSubagentRunner,
  resolveSubagentModel,
  type RunEmbeddedAgentFn,
} from "../src/agent-run.js";
import {
  loadAgentDefinitions,
  parseAgentDefinition,
  resolveAgentsDir,
  scanAgentDefinitions,
  splitFrontmatter,
} from "../src/agent-scanner.js";
import { createSystemEventNotifier, formatSubagentCompletionText } from "../src/notify.js";
import {
  createSubagentManager,
  type SubagentNotifyParams,
  type SubagentRunFn,
  type SubagentRunOutcome,
  type SubagentRunRequest,
  type SubagentStartResult,
} from "../src/runner.js";
import {
  createGetSubagentResultTool,
  createSubagentTool,
  formatSubagentResult,
} from "../src/tools.js";

const EXECUTOR_MD = `---
name: executor
description: コード実装・ファイル編集・コマンド実行を担当する自律エージェント
model: cli-router/kios-deepseek-v4.1-flash
tools:
  - bash
  - read
  - edit
---
あなたは電脳相棒 Kasou の右腕となる自律実行エージェント「Executor」です。
KISS 原則を徹底し、最小限の安全な変更でコード実装や検証を行います。
`;

const CUSTOM_MD = `あなたはワークスペース定義だけで動く custom エージェントです。`;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 後片付け失敗は無視する。
    }
  }
});

function makeWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dennou-subagent-test-"));
  tempDirs.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  return dir;
}

type ToolResultShape = {
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
};

async function callTool(
  tool: AnyAgentTool,
  args: Record<string, unknown>,
): Promise<ToolResultShape> {
  return (await tool.execute!("call_1", args)) as ToolResultShape;
}

function toolText(result: ToolResultShape): string {
  return result.content?.map((entry) => entry.text ?? "").join("\n") ?? "";
}

function toolDetails<T>(result: ToolResultShape): T {
  return result.details as T;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

/** バックグラウンド実行のマイクロタスクを確実に消化させる。 */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("agent-scanner: frontmatter", () => {
  it("extracts name / description / model / tools and keeps the body as the system prompt", () => {
    const definition = parseAgentDefinition(EXECUTOR_MD, {
      filePath: "/tmp/workspace/agents/executor.md",
    });

    expect(definition).toBeDefined();
    expect(definition?.name).toBe("executor");
    expect(definition?.description).toContain("コード実装");
    expect(definition?.model).toBe("cli-router/kios-deepseek-v4.1-flash");
    expect(definition?.tools).toEqual(["bash", "read", "edit"]);
    expect(definition?.systemPrompt).toContain("右腕となる自律実行エージェント");
    expect(definition?.systemPrompt).not.toContain("---");
    expect(definition?.source).toBe("workspace");
  });

  it("falls back to the file name when frontmatter is absent", () => {
    const definition = parseAgentDefinition(CUSTOM_MD, {
      fallbackName: "custom",
      filePath: "/tmp/workspace/agents/custom.md",
    });

    expect(definition?.name).toBe("custom");
    expect(definition?.description).toBe("");
    expect(definition?.model).toBeUndefined();
    expect(definition?.tools).toBeUndefined();
    expect(definition?.systemPrompt).toBe(CUSTOM_MD);
  });

  it("accepts a comma separated tools list and normalizes the name", () => {
    const definition = parseAgentDefinition(
      ["---", "name: Reviewer", "tools: read, grep", "---", "本文"].join("\n"),
      {},
    );

    expect(definition?.name).toBe("reviewer");
    expect(definition?.tools).toEqual(["read", "grep"]);
    expect(definition?.systemPrompt).toBe("本文");
  });

  it("splits CRLF content and reports empty metadata when the block is unterminated", () => {
    expect(splitFrontmatter("---\r\nname: a\r\n---\r\n本文").meta).toEqual({ name: "a" });
    expect(splitFrontmatter("---\r\nname: a\r\n---\r\n本文").body).toBe("本文");
    expect(splitFrontmatter("---\nname: a\n本文").meta).toEqual({});
  });
});

describe("agent-scanner: workspace loading", () => {
  it("scans *.md files, ignores other files, and lets workspace definitions override builtins", () => {
    const workspaceDir = makeWorkspace({
      "agents/executor.md": EXECUTOR_MD,
      "agents/custom.md": CUSTOM_MD,
      "agents/notes.txt": "これはエージェント定義ではない",
    });

    const scanned = scanAgentDefinitions(resolveAgentsDir(workspaceDir));
    expect(scanned.map((definition) => definition.name)).toEqual(["custom", "executor"]);

    const definitions = loadAgentDefinitions({ workspaceDir });
    expect([...definitions.keys()].sort()).toEqual(["custom", "executor", "explore", "reviewer"]);
    expect(definitions.get("executor")?.source).toBe("workspace");
    expect(definitions.get("executor")?.model).toBe("cli-router/kios-deepseek-v4.1-flash");
    expect(definitions.get("explore")?.source).toBe("builtin");
  });

  it("keeps builtin fallbacks when the workspace has no agents directory", () => {
    const workspaceDir = makeWorkspace({ "README.md": "empty workspace" });
    const definitions = loadAgentDefinitions({ workspaceDir });

    expect(definitions.has("executor")).toBe(true);
    expect(definitions.get("executor")?.tools).toContain("bash");
    expect(scanAgentDefinitions(resolveAgentsDir(workspaceDir))).toEqual([]);
  });

  it("supports a custom agents directory relative to the workspace", () => {
    const workspaceDir = makeWorkspace({ "custom-agents/custom.md": CUSTOM_MD });
    const definitions = loadAgentDefinitions({ workspaceDir, agentsDir: "custom-agents" });

    expect(definitions.get("custom")?.source).toBe("workspace");
    expect(definitions.get("executor")?.source).toBe("builtin");
  });
});

describe("subagent lifecycle", () => {
  it("starts in the background and reports progress then the final result", async () => {
    const workspaceDir = makeWorkspace({ "agents/executor.md": EXECUTOR_MD });
    const deferred = createDeferred<SubagentRunOutcome>();
    const requests: SubagentRunRequest[] = [];
    const notifications: SubagentNotifyParams[] = [];

    const runAgent: SubagentRunFn = async (request) => {
      requests.push(request);
      request.onLog("🔧 read");
      return await deferred.promise;
    };
    const manager = createSubagentManager({
      runAgent,
      notify: (params) => {
        notifications.push(params);
      },
      now: () => 1_730_000_000_000,
    });
    const context = { workspaceDir, sessionKey: "agent:main:main" };

    const started = await callTool(createSubagentTool({ manager, context }), {
      agent: "executor",
      task: "テストを書く",
    });
    const startedDetails = toolDetails<SubagentStartResult>(started);
    const agentId = startedDetails.agentId;

    expect(agentId).toMatch(/^sub-1730000000000-[0-9a-f]{6}$/);
    expect(startedDetails.status).toBe("running");
    expect(toolText(started)).toContain(`agent_id: ${agentId}`);

    const getResultTool = createGetSubagentResultTool({ manager });
    const running = await callTool(getResultTool, { agent_id: agentId });
    expect(toolText(running)).toContain("status: running");
    expect(toolText(running)).toContain("🔧 read");

    deferred.resolve({ output: "実装完了しました" });
    await flushAsync();

    const completed = await callTool(getResultTool, { agent_id: agentId });
    expect(toolText(completed)).toContain("status: completed");
    expect(toolText(completed)).toContain("実装完了しました");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.agent).toBe("executor");
    expect(requests[0]?.task).toBe("テストを書く");
    expect(requests[0]?.sessionKey).toBe(`dennou-subagent:${agentId}`);
    expect(requests[0]?.workspaceDir).toBe(workspaceDir);
    expect(requests[0]?.definition.model).toBe("cli-router/kios-deepseek-v4.1-flash");
    expect(requests[0]?.definition.tools).toEqual(["bash", "read", "edit"]);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.sessionKey).toBe("agent:main:main");
    expect(notifications[0]?.run.status).toBe("completed");
    expect(notifications[0]?.run.output).toBe("実装完了しました");
  });

  it("marks the run as failed when the runner throws", async () => {
    const workspaceDir = makeWorkspace({});
    const manager = createSubagentManager({
      runAgent: async () => {
        throw new Error("モデルが応答しませんでした");
      },
    });

    const started = await callTool(createSubagentTool({ manager, context: { workspaceDir } }), {
      agent: "explore",
      task: "調査して",
    });
    const agentId = toolDetails<SubagentStartResult>(started).agentId;
    await flushAsync();
    const result = await manager.get(agentId);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("モデルが応答しませんでした");
    expect(formatSubagentResult(result)).toContain("status: failed");
  });

  it("returns immediately while the run is still in progress (no blocking wait)", async () => {
    const workspaceDir = makeWorkspace({});
    const deferred = createDeferred<SubagentRunOutcome>();
    const manager = createSubagentManager({ runAgent: async () => await deferred.promise });

    const started = await callTool(createSubagentTool({ manager, context: { workspaceDir } }), {
      agent: "reviewer",
      task: "レビューして",
    });
    const agentId = toolDetails<SubagentStartResult>(started).agentId;
    const getResultTool = createGetSubagentResultTool({ manager });

    // 未完了でもブロックせず即座に running を返す。
    const running = await callTool(getResultTool, { agent_id: agentId });
    expect(toolText(running)).toContain("status: running");

    deferred.resolve({ output: "APPROVE" });
    await flushAsync();

    const completed = await callTool(getResultTool, { agent_id: agentId });
    expect(toolText(completed)).toContain("status: completed");
    expect(toolText(completed)).toContain("APPROVE");
  });

  it("keeps the interruption reason when stopAll aborts a run", async () => {
    const workspaceDir = makeWorkspace({});
    const deferred = createDeferred<SubagentRunOutcome>();
    const manager = createSubagentManager({ runAgent: async () => await deferred.promise });

    const started = await callTool(createSubagentTool({ manager, context: { workspaceDir } }), {
      agent: "executor",
      task: "長い作業",
    });
    const agentId = toolDetails<SubagentStartResult>(started).agentId;

    manager.stopAll("gateway 停止により中断されました");
    deferred.resolve({ error: "後から届いた別のエラー" });
    await flushAsync();

    const result = await manager.get(agentId);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("gateway 停止により中断されました");
  });

  it("exposes only agent_id in the get_subagent_result schema", () => {
    const manager = createSubagentManager({ runAgent: async () => ({ output: "unused" }) });
    const tool = createGetSubagentResultTool({ manager });
    const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;

    expect(Object.keys(properties ?? {})).toEqual(["agent_id"]);
  });
  it("prunes the oldest finished runs beyond maxRuns", async () => {
    const workspaceDir = makeWorkspace({});
    let clock = 1_000;
    const manager = createSubagentManager({
      runAgent: async () => ({ output: "ok" }),
      now: () => (clock += 1),
      maxRuns: 2,
    });
    const tool = createSubagentTool({ manager, context: { workspaceDir } });

    const agentIds: string[] = [];
    for (const task of ["a", "b", "c"]) {
      const started = await callTool(tool, { agent: "executor", task });
      const agentId = toolDetails<SubagentStartResult>(started).agentId;
      agentIds.push(agentId);
      await flushAsync();
    }

    expect(manager.list()).toHaveLength(2);
    await expect(manager.get(agentIds[0] ?? "")).rejects.toThrow(/見つかりません/);
    expect((await manager.get(agentIds[2] ?? "")).status).toBe("completed");
  });
});

describe("subagent error handling", () => {
  it("rejects an unknown agent and lists the available ones", async () => {
    const workspaceDir = makeWorkspace({});
    const manager = createSubagentManager({ runAgent: async () => ({ output: "unused" }) });
    const tool = createSubagentTool({ manager, context: { workspaceDir } });

    await expect(tool.execute!("call_1", { agent: "ghost", task: "なにか" })).rejects.toThrow(
      /'ghost' は未定義です。利用可能: executor, explore, reviewer/,
    );
  });

  it("rejects a missing task", async () => {
    const workspaceDir = makeWorkspace({});
    const manager = createSubagentManager({ runAgent: async () => ({ output: "unused" }) });
    const tool = createSubagentTool({ manager, context: { workspaceDir } });

    await expect(tool.execute!("call_1", { agent: "executor" })).rejects.toThrow(/task required/);
  });

  it("rejects an unknown agent_id", async () => {
    const manager = createSubagentManager({ runAgent: async () => ({ output: "unused" }) });
    const tool = createGetSubagentResultTool({ manager });

    await expect(tool.execute!("call_1", { agent_id: "sub-000" })).rejects.toThrow(
      /'sub-000' が見つかりません/,
    );
  });

  it("throws when neither workspaceDir nor config is available", async () => {
    const manager = createSubagentManager({ runAgent: async () => ({ output: "unused" }) });
    const tool = createSubagentTool({ manager, context: {} });

    await expect(tool.execute!("call_1", { agent: "executor", task: "なにか" })).rejects.toThrow(
      /ワークスペースが解決できません/,
    );
  });
});

describe("completion notification", () => {
  it("formats a completion summary for the main session", () => {
    const text = formatSubagentCompletionText({
      agentId: "sub-1-abcdef",
      agent: "executor",
      task: "実装",
      status: "completed",
      startedAt: 1,
      endedAt: 2,
      log: [],
      output: "実装が終わりました\nテストも pass です",
    });

    expect(text).toContain(
      "[システム通知] サブエージェント executor (sub-1-abcdef) が完了しました",
    );
    expect(text).toContain("実装が終わりました テストも pass です");
  });

  it("formats a failure summary", () => {
    const text = formatSubagentCompletionText({
      agentId: "sub-2-abcdef",
      agent: "explore",
      task: "調査",
      status: "failed",
      startedAt: 1,
      endedAt: 2,
      log: [],
      error: "タイムアウトしました",
    });

    expect(text).toContain("が失敗しました");
    expect(text).toContain("タイムアウトしました");
  });

  it("enqueues the event and pumps the caller session", async () => {
    const enqueued: Array<{ text: string; sessionKey: string }> = [];
    const pumped: Array<{ sessionKey?: string; reason?: string }> = [];
    const notifier = createSystemEventNotifier({
      enqueueSystemEvent: (text, options) => {
        enqueued.push({ text, sessionKey: options.sessionKey });
        return true;
      },
      runEventPumpOnce: async (opts) => {
        pumped.push({ sessionKey: opts.sessionKey, reason: opts.reason });
        return { status: "ran", durationMs: 1 };
      },
      requestWakeNow: () => {
        throw new Error("wake must not be called when the pump ran");
      },
      resolveSessionKey: () => "agent:main:main",
    });

    await notifier({
      run: {
        agentId: "sub-3-abcdef",
        agent: "executor",
        task: "実装",
        status: "completed",
        startedAt: 1,
        endedAt: 2,
        log: [],
        output: "完了",
      },
      sessionKey: "agent:main:main",
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.sessionKey).toBe("agent:main:main");
    expect(enqueued[0]?.text).toContain("が完了しました");
    expect(pumped[0]?.reason).toBe("dennou-subagent:sub-3-abcdef");
  });

  it("queues a wake when the pump skips the run", async () => {
    const wakes: string[] = [];
    const notifier = createSystemEventNotifier({
      enqueueSystemEvent: () => true,
      runEventPumpOnce: async () => ({ status: "skipped", reason: "requests-in-flight" }),
      requestWakeNow: (opts) => {
        wakes.push(opts?.reason ?? "");
      },
      resolveSessionKey: () => "agent:main:main",
    });

    await notifier({
      run: {
        agentId: "sub-4-abcdef",
        agent: "executor",
        task: "実装",
        status: "completed",
        startedAt: 1,
        endedAt: 2,
        log: [],
        output: "完了",
      },
    });

    expect(wakes).toEqual(["dennou-subagent:sub-4-abcdef"]);
  });
});

type CapturedRequest = {
  request: SubagentRunRequest;
  logs: string[];
};

function makeRunRequest(overrides: Partial<SubagentRunRequest> = {}): CapturedRequest {
  const logs: string[] = [];
  const request: SubagentRunRequest = {
    runId: "sub-test-1",
    agent: "executor",
    task: "テストを書く",
    definition: {
      name: "executor",
      description: "実装担当",
      model: "cli-router/kios-deepseek-v4.1-flash",
      tools: ["bash", "read"],
      systemPrompt: "あなたは Executor です。",
      source: "workspace",
    },
    sessionKey: "dennou-subagent:sub-test-1",
    workspaceDir: os.tmpdir(),
    timeoutMs: 1_234,
    signal: new AbortController().signal,
    onLog: (text) => logs.push(text),
    ...overrides,
  };
  return { request, logs };
}

describe("agent-run: model resolution", () => {
  it("prefers the model declared in the agent definition", () => {
    const { request } = makeRunRequest();

    expect(resolveSubagentModel(request)).toEqual({
      provider: "cli-router",
      model: "kios-deepseek-v4.1-flash",
    });
  });

  it("inherits the caller agent model when the definition omits one", () => {
    const { request } = makeRunRequest({
      definition: {
        name: "explore",
        description: "",
        systemPrompt: "調査担当",
        source: "builtin",
      },
      config: {
        agents: { defaults: { model: "cli-router/kios-gemini-3.8-flash" } },
      } as unknown as OpenClawConfig,
      configAgentId: "main",
    });

    expect(resolveSubagentModel(request)).toEqual({
      provider: "cli-router",
      model: "kios-gemini-3.8-flash",
    });
  });

  it("falls back to the default provider and model", () => {
    const { request } = makeRunRequest({
      definition: {
        name: "explore",
        description: "",
        systemPrompt: "調査担当",
        source: "builtin",
      },
      config: undefined,
      configAgentId: undefined,
    });

    expect(resolveSubagentModel(request)).toEqual({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
    });
  });
});

describe("agent-run: embedded run wiring", () => {
  it("runs the definition as an independent embedded session", async () => {
    const { request, logs } = makeRunRequest();
    const calls: RunEmbeddedPiAgentParams[] = [];
    const runEmbedded: RunEmbeddedAgentFn = async (params) => {
      calls.push(params);
      params.onAgentEvent?.({ stream: "tool", data: { phase: "start", name: "bash" } });
      params.onAgentEvent?.({ stream: "tool", data: { phase: "end", name: "bash" } });
      params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "end" } });
      return {
        payloads: [{ text: "実装しました" }, { text: "テストも pass" }],
        meta: { durationMs: 5 },
      };
    };
    const runner = createEmbeddedSubagentRunner({ runEmbedded });

    const outcome = await runner(request);

    expect(outcome).toEqual({ output: "実装しました\nテストも pass" });
    expect(calls).toHaveLength(1);
    const params = calls[0]!;
    expect(params.prompt).toBe("テストを書く");
    expect(params.sessionKey).toBe("dennou-subagent:sub-test-1");
    expect(params.sessionId).toBe("sub-test-1");
    expect(params.runId).toBe("sub-test-1");
    expect(params.provider).toBe("cli-router");
    expect(params.model).toBe("kios-deepseek-v4.1-flash");
    expect(params.extraSystemPrompt).toBe("あなたは Executor です。");
    expect(params.toolsAllow).toEqual(["bash", "read"]);
    expect(params.timeoutMs).toBe(1_234);
    expect(params.abortSignal).toBe(request.signal);
    expect(logs).toEqual(["▶ 開始 (cli-router/kios-deepseek-v4.1-flash)", "🔧 bash"]);
  });

  it("passes undefined toolsAllow when the definition lists no tools", async () => {
    const { request } = makeRunRequest({
      definition: {
        name: "explore",
        description: "",
        systemPrompt: "",
        source: "builtin",
      },
    });
    const calls: RunEmbeddedPiAgentParams[] = [];
    const runner = createEmbeddedSubagentRunner({
      runEmbedded: async (params) => {
        calls.push(params);
        return { payloads: [{ text: "ok" }], meta: { durationMs: 1 } };
      },
    });

    await runner(request);

    expect(calls[0]?.toolsAllow).toBeUndefined();
    expect(calls[0]?.extraSystemPrompt).toBeUndefined();
  });

  it("maps a run error into a failed outcome", async () => {
    const { request } = makeRunRequest();
    const runner = createEmbeddedSubagentRunner({
      runEmbedded: async () => ({
        payloads: [{ text: "途中まで" }],
        meta: {
          durationMs: 5,
          error: { kind: "retry_limit", message: "レート制限に達しました" },
        },
      }),
    });

    const outcome = await runner(request);

    expect(outcome.error).toBe("レート制限に達しました");
    expect(outcome.output).toBe("途中まで");
  });

  it("reports an aborted run as an error", async () => {
    const { request } = makeRunRequest();
    const runner = createEmbeddedSubagentRunner({
      runEmbedded: async () => ({ payloads: [], meta: { durationMs: 5, aborted: true } }),
    });

    const outcome = await runner(request);

    expect(outcome.error).toContain("中断されました");
    expect(outcome.output).toBeUndefined();
  });

  it("falls back to a placeholder when the run produced no text", async () => {
    const { request } = makeRunRequest();
    const runner = createEmbeddedSubagentRunner({
      runEmbedded: async () => ({ payloads: [], meta: { durationMs: 1 } }),
    });

    const outcome = await runner(request);

    expect(outcome.output).toBe("(サブエージェントからのテキスト出力はありません)");
  });
});

type RegisterApi = Parameters<typeof pluginEntry.register>[0];

function makeRegisterApi(overrides: Partial<RegisterApi>): RegisterApi {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerTool: () => {},
    registerService: () => {},
    ...overrides,
  } as unknown as RegisterApi;
}

describe("plugin registration", () => {
  it("registers both tools and the background manager service", () => {
    const toolNames: string[] = [];
    const serviceIds: string[] = [];
    pluginEntry.register(
      makeRegisterApi({
        registerTool: (_tool, opts) => {
          toolNames.push(...(opts?.names ?? []));
        },
        registerService: (service) => {
          serviceIds.push(service.id);
        },
      }),
    );

    expect(toolNames).toEqual(["subagent", "get_subagent_result"]);
    expect(serviceIds).toEqual(["dennou-subagent"]);
  });

  it("skips registration when disabled by config", () => {
    const logs: string[] = [];
    let registered = 0;
    pluginEntry.register(
      makeRegisterApi({
        pluginConfig: { enabled: false },
        logger: {
          info: (message) => logs.push(message),
          warn: () => {},
          error: () => {},
        },
        registerTool: () => {
          registered += 1;
        },
        registerService: () => {
          registered += 1;
        },
      }),
    );

    expect(registered).toBe(0);
    expect(logs).toEqual(["dennou-subagent: disabled by config"]);
  });
});

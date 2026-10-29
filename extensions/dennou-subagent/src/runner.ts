/**
 * 電脳サブエージェント — バックグラウンド実行マネージャー (DENNOU_SUBAGENT.md §4, §5).
 *
 * `subagent` ツールから渡されたタスクを非同期で起動し、`agent_id` を即座に返す。
 * 進捗（最新ログ）と最終結果は `get_subagent_result` から取得する。
 * 並列度の安全弁として、通常セッションは最大 7 体、
 * 通話セッション（`call:` 接頭辞）は最大 1 体までに制限する。
 * 実際のモデルセッション実行は `runAgent` 依存として注入する
 * （本番実装は `./agent-run.ts`、テストはフェイク）。
 */

import crypto from "node:crypto";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { AGENTS_SUBDIR, type AgentDefinition } from "./agent-scanner.js";

export type SubagentStatus = "running" | "completed" | "failed";

export type SubagentRun = {
  agentId: string;
  agent: string;
  task: string;
  status: SubagentStatus;
  model?: string;
  startedAt: number;
  endedAt?: number;
  /** 最新ログ（古いものから新しいものへ。上限 `maxLogLines` 行）。 */
  log: string[];
  output?: string;
  error?: string;
};

export type SubagentRunRequest = {
  /** サブエージェント実行ID（`sub-<timestamp>-<hash>`）。 */
  runId: string;
  /** エージェント定義名。 */
  agent: string;
  /** 依頼内容。 */
  task: string;
  definition: AgentDefinition;
  /** サブエージェント自身の独立セッションキー。 */
  sessionKey: string;
  workspaceDir: string;
  agentDir?: string;
  /** 呼び出し元の設定エージェントID（モデル継承・ポリシー解決に使う）。 */
  configAgentId?: string;
  config?: OpenClawConfig;
  timeoutMs: number;
  signal: AbortSignal;
  /** 進捗ログを1行追加する。 */
  onLog: (text: string) => void;
};

export type SubagentRunOutcome = {
  output?: string;
  error?: string;
};

export type SubagentRunFn = (request: SubagentRunRequest) => Promise<SubagentRunOutcome>;

export type SubagentNotifyParams = {
  /** 完了/失敗した実行のスナップショット。 */
  run: SubagentRun;
  /** 通知先（呼び出し元セッションキー。未指定ならメインセッション）。 */
  sessionKey?: string;
  config?: OpenClawConfig;
};

export type SubagentNotifier = (params: SubagentNotifyParams) => void | Promise<void>;

export type SubagentLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type SubagentManagerOptions = {
  runAgent: SubagentRunFn;
  notify?: SubagentNotifier;
  now?: () => number;
  defaultTimeoutMs?: number;
  /** タイムアウト監視の余裕（既定 30秒）。 */
  timeoutGuardGraceMs?: number;
  maxLogLines?: number;
  maxRuns?: number;
  logger?: SubagentLogger;
};

export type SubagentStartContext = {
  workspaceDir: string;
  agentDir?: string;
  configAgentId?: string;
  config?: OpenClawConfig;
  /** 呼び出し元セッションキー（完了通知の宛先）。 */
  sessionKey?: string;
};

export type SubagentStartParams = {
  agent: string;
  task: string;
  definitions: Map<string, AgentDefinition>;
  context: SubagentStartContext;
};

export type SubagentStartResult = {
  agentId: string;
  /** 解決済みのエージェント定義名（小文字）。 */
  agent: string;
  status: "running";
  message: string;
};

export type SubagentResult = {
  agentId: string;
  agent: string;
  status: SubagentStatus;
  output: string;
  log: string[];
  error?: string;
  startedAt: number;
  endedAt?: number;
};

export type SubagentManager = {
  start: (params: SubagentStartParams) => SubagentStartResult;
  /** 常に即座に現在のステータス・ログ・結果を返す（ブロッキング待機はしない）。 */
  get: (agentId: string) => Promise<SubagentResult>;
  list: () => SubagentRun[];
  stopAll: (reason?: string) => void;
};

/** 1実行あたりの既定タイムアウト（10分）。 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60_000;
/** タイムアウト監視がランナーの自己中断より先に発火しないための余裕。 */
export const DEFAULT_TIMEOUT_GUARD_GRACE_MS = 30_000;
export const MAX_LOG_LINES = 20;
/** 保持する実行履歴の上限（超過分は古い完了済み実行から破棄）。 */
export const MAX_RETAINED_RUNS = 50;
/**
 * 通常セッション（メインセッション等）で同時に走らせられるサブエージェント数。
 * カウントはマネージャー全体（セッション横断）で行う。
 */
export const MAX_CONCURRENT_SUBAGENTS_DEFAULT = 7;
/**
 * 通話セッション（`call:` 接頭辞）から起動する場合の上限。
 * 通話中は全体で 1 体に厳格化する（他に実行中が 1 体でもあれば拒否）。
 */
export const MAX_CONCURRENT_SUBAGENTS_CALL = 1;
/**
 * 通話（電脳架電）セッションを見分けるセッションキー接頭辞。
 *
 * 判定契約: 呼び出し元 `sessionKey` が `call:` で始まる場合のみ「通話セッション」と見なす。
 * メインセッション（例: `agent:main:main`）から通話中に起動された場合は通常セッション扱い
 * （＝7体上限）になるため、通話中に厳格制限を効かせたい場合は電脳架電側が
 * `call:<callId>` 形式のセッションキーを渡す必要がある。
 */
export const CALL_SESSION_KEY_PREFIX = "call:";
/** サブエージェントが使う独立セッションキーの接頭辞（`dennou-subagent:<agentId>`）。 */
export const SUBAGENT_SESSION_KEY_PREFIX = "dennou-subagent:";

type InternalRun = {
  run: SubagentRun;
  /** 完了通知の宛先（呼び出し元セッションキー）。 */
  notifySessionKey?: string;
  config?: OpenClawConfig;
  controller: AbortController;
};

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "不明なエラー";
}

function snapshot(run: SubagentRun): SubagentRun {
  return { ...run, log: [...run.log] };
}

/** 通話（電脳架電）セッションかどうか。判定は `call:` 接頭辞のみで行う。 */
export function isCallSessionKey(sessionKey?: string): boolean {
  return typeof sessionKey === "string" && sessionKey.trim().startsWith(CALL_SESSION_KEY_PREFIX);
}

/** サブエージェントの独立セッションキーかどうか（`memo` 遮断フックの判定に使う）。 */
export function isSubagentSessionKey(sessionKey?: string): boolean {
  return (
    typeof sessionKey === "string" && sessionKey.trim().startsWith(SUBAGENT_SESSION_KEY_PREFIX)
  );
}

export function createSubagentManager(options: SubagentManagerOptions): SubagentManager {
  const now = options.now ?? Date.now;
  const maxLogLines = options.maxLogLines ?? MAX_LOG_LINES;
  const maxRuns = options.maxRuns ?? MAX_RETAINED_RUNS;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  const timeoutGuardGraceMs = options.timeoutGuardGraceMs ?? DEFAULT_TIMEOUT_GUARD_GRACE_MS;
  const runs = new Map<string, InternalRun>();

  const generateAgentId = (): string => {
    for (;;) {
      const candidate = `sub-${now()}-${crypto.randomBytes(3).toString("hex")}`;
      if (!runs.has(candidate)) {
        return candidate;
      }
    }
  };

  const appendLog = (run: SubagentRun, text: string): void => {
    const cleaned = text.trim();
    if (!cleaned) {
      return;
    }
    run.log.push(cleaned);
    if (run.log.length > maxLogLines) {
      run.log.splice(0, run.log.length - maxLogLines);
    }
  };

  const notifySafe = async (internal: InternalRun): Promise<void> => {
    const notify = options.notify;
    if (!notify) {
      return;
    }
    try {
      await notify({
        run: snapshot(internal.run),
        sessionKey: internal.notifySessionKey,
        config: internal.config,
      });
    } catch (error) {
      options.logger?.warn?.(`dennou-subagent: 完了通知に失敗しました: ${describeError(error)}`);
    }
  };

  /** 完了済み実行が上限を超えたら古い順に破棄する（長時間稼働のメモリ肥大防止）。 */
  const pruneRuns = (): void => {
    if (runs.size <= maxRuns) {
      return;
    }
    const finished = [...runs.values()]
      .filter((internal) => internal.run.status !== "running")
      .sort((left, right) => left.run.startedAt - right.run.startedAt);
    for (const internal of finished) {
      if (runs.size <= maxRuns) {
        break;
      }
      runs.delete(internal.run.agentId);
    }
  };

  const execute = async (
    internal: InternalRun,
    params: {
      definition: AgentDefinition;
      workspaceDir: string;
      agentDir?: string;
      configAgentId?: string;
    },
  ): Promise<void> => {
    const { run } = internal;
    // タイムアウト監視（安全弁）。ランナーがハングしても枠を永久占有しないよう、
    // `defaultTimeoutMs + grace` を超えたら強制失敗にする。
    const guardMs = defaultTimeoutMs + timeoutGuardGraceMs;
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutGuard = new Promise<never>((_resolve, reject) => {
      guardTimer = setTimeout(() => {
        internal.controller.abort("dennou-subagent: timeout");
        reject(
          new Error(`サブエージェントがタイムアウトしました（${Math.round(guardMs / 1000)}秒）。`),
        );
      }, guardMs);
      // 監視タイマーだけでプロセスを生かし続けない。
      guardTimer.unref?.();
    });
    try {
      const runPromise = options.runAgent({
        runId: run.agentId,
        agent: run.agent,
        task: run.task,
        definition: params.definition,
        sessionKey: `${SUBAGENT_SESSION_KEY_PREFIX}${run.agentId}`,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        configAgentId: params.configAgentId,
        config: internal.config,
        timeoutMs: defaultTimeoutMs,
        signal: internal.controller.signal,
        onLog: (text) => appendLog(run, text),
      });
      // ガードが先に落ちた場合に未処理拒否を出さない。
      runPromise.catch(() => {});
      const outcome = await Promise.race([runPromise, timeoutGuard]);
      if (outcome.error) {
        // stopAll で中断済みの場合は中断理由を保持する。
        if (run.status === "running") {
          run.status = "failed";
          run.error = outcome.error;
          run.output = outcome.output;
        }
      } else if (run.status === "running") {
        run.status = "completed";
        run.output = outcome.output ?? "";
      }
    } catch (error) {
      // stopAll で中断済みの場合は、中断理由を上書きしない。
      if (run.status === "running") {
        run.status = "failed";
        run.error = describeError(error);
      }
    } finally {
      if (guardTimer) {
        clearTimeout(guardTimer);
      }
      run.endedAt = now();
      options.logger?.info?.(
        `dennou-subagent: ${run.agentId} (${run.agent}) -> ${run.status}${
          run.error ? `: ${run.error}` : ""
        }`,
      );
      // 完了通知（メインセッションのポンプ）は結果取得をブロックしない。
      // システムイベントは同期的にキューへ積まれるため取りこぼしはしない。
      void notifySafe(internal);
      pruneRuns();
    }
  };

  /** 現在実行中（`running`）のサブエージェント数。 */
  const countRunningRuns = (): number => {
    let running = 0;
    for (const internal of runs.values()) {
      if (internal.run.status === "running") {
        running += 1;
      }
    }
    return running;
  };

  /**
   * 並列度の安全弁。
   *
   * - カウントはマネージャー全体（セッション横断）の `running` 数。
   * - 通話セッション（`call:`）からの起動は全体で 1 体に厳格化（他に実行中があれば拒否）。
   * - 通常セッションからの起動は全体で 7 体まで。
   */
  const assertConcurrencyAvailable = (sessionKey?: string): void => {
    const running = countRunningRuns();
    if (isCallSessionKey(sessionKey)) {
      if (running >= MAX_CONCURRENT_SUBAGENTS_CALL) {
        throw new Error(
          "通話セッションでは並列サブエージェントは1体までです。実行中のサブエージェントが完了するのをお待ちください。",
        );
      }
      return;
    }
    if (running >= MAX_CONCURRENT_SUBAGENTS_DEFAULT) {
      throw new Error(
        `同時実行可能なサブエージェントの上限（${MAX_CONCURRENT_SUBAGENTS_DEFAULT}体）に達しています。いずれかの完了をお待ちください。`,
      );
    }
  };

  const start = (params: SubagentStartParams): SubagentStartResult => {
    const agentName = (params.agent ?? "").trim().toLowerCase();
    if (!agentName) {
      throw new Error("サブエージェント名 'agent' は必須です。");
    }
    const definition = params.definitions.get(agentName);
    if (!definition) {
      const available = [...params.definitions.keys()].sort((left, right) =>
        left.localeCompare(right),
      );
      throw new Error(
        `サブエージェント '${agentName}' は未定義です。利用可能: ${
          available.length > 0 ? available.join(", ") : "(なし)"
        }。workspace/${AGENTS_SUBDIR}/${agentName}.md を追加するか、既存の名前を指定してください。`,
      );
    }
    const task = (params.task ?? "").trim();
    if (!task) {
      throw new Error("サブエージェントへの指示 'task' は必須です。");
    }
    const workspaceDir = params.context.workspaceDir?.trim();
    if (!workspaceDir) {
      throw new Error("サブエージェントのワークスペースが解決できません。");
    }

    // 引数バリデーション通過後に並列度を判定する（不正な引数で上限エラーを出さない）。
    assertConcurrencyAvailable(params.context.sessionKey);

    const agentId = generateAgentId();
    const run: SubagentRun = {
      agentId,
      agent: definition.name,
      task,
      status: "running",
      model: definition.model,
      startedAt: now(),
      log: [],
    };
    const internal: InternalRun = {
      run,
      notifySessionKey: params.context.sessionKey,
      config: params.context.config,
      controller: new AbortController(),
    };
    runs.set(agentId, internal);
    void execute(internal, {
      definition,
      workspaceDir,
      agentDir: params.context.agentDir,
      configAgentId: params.context.configAgentId,
    });

    return {
      agentId,
      agent: definition.name,
      status: "running",
      message: `サブエージェント ${definition.name} を開始しました。進捗は get_subagent_result で確認できます。`,
    };
  };

  const toResult = (run: SubagentRun): SubagentResult => ({
    agentId: run.agentId,
    agent: run.agent,
    status: run.status,
    output: run.output ?? "",
    log: [...run.log],
    error: run.error,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  });

  const get = async (agentId: string): Promise<SubagentResult> => {
    const key = agentId.trim();
    const internal = runs.get(key);
    if (!internal) {
      const known = [...runs.keys()].slice(-5);
      const overflow = runs.size - known.length;
      throw new Error(
        `サブエージェント '${key}' が見つかりません。${
          known.length > 0
            ? `直近の実行: ${known.join(", ")}${overflow > 0 ? ` ほか ${overflow} 件` : ""}`
            : "まだ実行されたサブエージェントはありません。"
        }`,
      );
    }
    return toResult(internal.run);
  };

  const list = (): SubagentRun[] =>
    [...runs.values()]
      .map((internal) => snapshot(internal.run))
      .sort((left, right) => right.startedAt - left.startedAt);

  const stopAll = (reason = "プラグインが停止しました"): void => {
    for (const internal of runs.values()) {
      if (internal.run.status !== "running") {
        continue;
      }
      internal.run.status = "failed";
      internal.run.error = reason;
      internal.run.endedAt = now();
      internal.controller.abort();
    }
  };

  return { start, get, list, stopAll };
}

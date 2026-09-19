import { afterEach, expect, test, vi } from "vitest";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { SpawnProcessAdapter } from "../process/supervisor/types.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";

// Drive the real supervisor with an injected PTY adapter instead of mocking
// `@lydell/node-pty` at module level (Bun cannot intercept ESM imports). The
// adapter double mirrors the `SpawnProcessAdapter` contract, so the supervisor's
// dispose/terminate wiring is still exercised end to end.
type FakePtyAdapterOptions = {
  exitOnWait?: boolean;
  exitCode?: number;
  exitOnKill?: boolean;
  exitSignal?: number;
};

type PtyExit = { code: number | null; signal: NodeJS.Signals | number | null };

function createFakePtyAdapter(options: FakePtyAdapterOptions) {
  const dispose = vi.fn();
  let stdoutListener: ((chunk: string) => void) | undefined;
  let resolveWait: ((value: PtyExit) => void) | undefined;
  const settle = (code: number | null, signal: NodeJS.Signals | number | null) => {
    resolveWait?.({ code, signal });
  };
  const kill = vi.fn(() => {
    if (options.exitOnKill === true) {
      settle(137, 9);
    }
  });

  const adapter: SpawnProcessAdapter = {
    pid: 4242,
    stdin: { write: vi.fn(), end: vi.fn(), destroyed: false },
    onStdout: (listener) => {
      stdoutListener = listener;
      setTimeout(() => listener("ok"), 0);
    },
    onStderr: () => {},
    wait: () =>
      new Promise<PtyExit>((resolve) => {
        resolveWait = resolve;
        if (options.exitOnWait === true) {
          setTimeout(() => settle(options.exitCode ?? 0, options.exitSignal ?? null), 0);
        }
      }),
    kill,
    dispose,
  };

  return { adapter, dispose, kill };
}

function createToolWithPtyAdapter(adapter: SpawnProcessAdapter) {
  const supervisor = createProcessSupervisor({
    createPtyAdapter: async () => adapter,
  });
  return createExecTool({
    allowBackground: false,
    host: "gateway",
    security: "full",
    ask: "off",
    execRuntimeDeps: { getProcessSupervisor: () => supervisor },
  });
}

afterEach(() => {
  resetProcessRegistryForTests();
  vi.clearAllMocks();
});

test("exec disposes PTY listeners after normal exit", async () => {
  const { adapter, dispose } = createFakePtyAdapter({ exitOnWait: true, exitCode: 0 });

  const tool = createToolWithPtyAdapter(adapter);
  const result = await tool.execute("toolcall", {
    command: "echo ok",
    pty: true,
  });

  expect(result.details.status).toBe("completed");
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("exec tears down PTY resources on timeout", async () => {
  const { adapter, dispose, kill } = createFakePtyAdapter({ exitOnKill: true });

  const tool = createToolWithPtyAdapter(adapter);
  const result = await tool.execute("toolcall", {
    command: "sleep 5",
    pty: true,
    timeout: 0.01,
  });

  expect(result.details).toMatchObject({
    status: "failed",
    timedOut: true,
    exitCode: 137,
  });
  expect((result.content[0] as { text?: string }).text).toMatch(/Command timed out/);
  expect(kill).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
});

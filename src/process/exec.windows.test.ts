import type { execFile as execFileType } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout, runExec, type ExecDeps } from "./exec.js";

const spawnMock = vi.fn();
const execFileMock = vi.fn();

const NODE_EXEC_PATH = "C:\\Program Files\\nodejs\\node.exe";
const COM_SPEC = "cmd.exe";
const NPM_CLI_PATH = path.join(
  path.dirname(NODE_EXEC_PATH),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);

function createDeps(overrides: Partial<ExecDeps> = {}): ExecDeps {
  return {
    platform: "win32",
    execPath: NODE_EXEC_PATH,
    comSpec: COM_SPEC,
    existsSync: () => true,
    spawn: spawnMock,
    execFile: execFileMock as unknown as typeof execFileType,
    ...overrides,
  };
}

type MockChild = EventEmitter & {
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  pid?: number;
  killed?: boolean;
};

function createMockChild(params?: {
  closeCode?: number | null;
  closeSignal?: NodeJS.Signals | null;
  exitCode?: number | null;
  exitCodeAfterClose?: number | null;
  exitCodeAfterCloseDelayMs?: number;
  signal?: NodeJS.Signals | null;
}): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = params?.exitCode ?? params?.closeCode ?? 0;
  child.signalCode = params?.signal ?? null;
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  child.kill = vi.fn(() => true);
  child.pid = 1234;
  child.killed = false;
  queueMicrotask(() => {
    child.emit("close", params?.closeCode ?? 0, params?.closeSignal ?? params?.signal ?? null);
    if (params?.exitCodeAfterClose !== undefined) {
      setTimeout(() => {
        child.exitCode = params.exitCodeAfterClose ?? null;
      }, params.exitCodeAfterCloseDelayMs ?? 0);
    }
  });
  return child;
}

type SpawnCall = [string, string[], Record<string, unknown>];

type ExecCall = [
  string,
  string[],
  Record<string, unknown>,
  (err: Error | null, stdout: string, stderr: string) => void,
];

function expectCmdWrappedInvocation(params: {
  captured: SpawnCall | ExecCall | undefined;
  expectedComSpec: string;
}) {
  if (!params.captured) {
    throw new Error("expected command wrapper to be called");
  }
  expect(params.captured[0]).toBe(params.expectedComSpec);
  expect(params.captured[1].slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  expect(params.captured[1][3]).toContain("pnpm.cmd --version");
  expect(params.captured[2].windowsHide).toBe(true);
  expect(params.captured[2].windowsVerbatimArguments).toBe(true);
}

describe("windows command wrapper behavior", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps .cmd commands via cmd.exe in runCommandWithTimeout", async () => {
    const expectedComSpec = COM_SPEC;

    spawnMock.mockImplementation(() => createMockChild());

    const result = await runCommandWithTimeout(
      ["pnpm", "--version"],
      { timeoutMs: 1000 },
      createDeps(),
    );
    expect(result.code).toBe(0);
    const captured = spawnMock.mock.calls[0] as SpawnCall | undefined;
    expectCmdWrappedInvocation({ captured, expectedComSpec });
  });

  it("wraps corepack.cmd via cmd.exe in runCommandWithTimeout", async () => {
    const expectedComSpec = COM_SPEC;

    spawnMock.mockImplementation(() => createMockChild());

    const result = await runCommandWithTimeout(
      ["corepack", "--version"],
      { timeoutMs: 1000 },
      createDeps(),
    );
    expect(result.code).toBe(0);
    const captured = spawnMock.mock.calls[0] as SpawnCall | undefined;
    if (!captured) {
      throw new Error("expected corepack shim spawn");
    }
    expect(captured[0]).toBe(expectedComSpec);
    expect(captured[1].slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(captured[1][3]).toContain("corepack.cmd --version");
    expect(captured[2].windowsHide).toBe(true);
    expect(captured[2].windowsVerbatimArguments).toBe(true);
  });

  it("keeps child exitCode when close reports null on Windows npm shims", async () => {
    const child = createMockChild({ closeCode: null, exitCode: 0 });

    spawnMock.mockImplementation(() => child);

    const result = await runCommandWithTimeout(
      ["npm", "--version"],
      { timeoutMs: 1000 },
      createDeps(),
    );
    expect(result.code).toBe(0);
  });

  it("spawns node + npm-cli.js for npm argv to avoid direct .cmd execution", async () => {
    const child = createMockChild({ closeCode: 0, exitCode: 0 });

    spawnMock.mockImplementation(() => child);

    const result = await runCommandWithTimeout(
      ["npm", "--version"],
      { timeoutMs: 1000 },
      createDeps(),
    );
    expect(result.code).toBe(0);
    const captured = spawnMock.mock.calls[0] as SpawnCall | undefined;
    if (!captured) {
      throw new Error("expected npm shim spawn");
    }
    expect(captured[0]).toBe(NODE_EXEC_PATH);
    expect(captured[1][0]).toBe(NPM_CLI_PATH);
    expect(captured[1][1]).toBe("--version");
    expect(captured[2].windowsHide).toBe(true);
    expect(captured[2].windowsVerbatimArguments).toBeUndefined();
    expect(captured[2].stdio).toEqual(["inherit", "pipe", "pipe"]);
  });

  it("falls back to npm.cmd when npm-cli.js is unavailable", async () => {
    const expectedComSpec = COM_SPEC;

    spawnMock.mockImplementation(() => createMockChild());

    const result = await runCommandWithTimeout(
      ["npm", "--version"],
      { timeoutMs: 1000 },
      createDeps({ existsSync: () => false }),
    );
    expect(result.code).toBe(0);
    const captured = spawnMock.mock.calls[0] as SpawnCall | undefined;
    if (!captured) {
      throw new Error("expected npm.cmd fallback spawn");
    }
    expect(captured[0]).toBe(expectedComSpec);
    expect(captured[1].slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(captured[1][3]).toContain("npm.cmd --version");
    expect(captured[2].windowsHide).toBe(true);
    expect(captured[2].windowsVerbatimArguments).toBe(true);
    expect(captured[2].stdio).toEqual(["inherit", "pipe", "pipe"]);
  });

  it("waits for Windows exitCode settlement after close reports null", async () => {
    const child = createMockChild({
      closeCode: null,
      exitCode: null,
      exitCodeAfterClose: 0,
      exitCodeAfterCloseDelayMs: 50,
    });

    spawnMock.mockImplementation(() => child);

    const result = await runCommandWithTimeout(
      ["npm", "--version"],
      { timeoutMs: 1000 },
      createDeps(),
    );
    expect(result.code).toBe(0);
  });

  it("treats shimmed Windows commands without a reported exit code as success when they close cleanly", async () => {
    const child = createMockChild({
      closeCode: null,
      exitCode: null,
    });

    spawnMock.mockImplementation(() => child);

    const result = await runCommandWithTimeout(
      ["npm", "--version"],
      { timeoutMs: 1000 },
      createDeps(),
    );
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.termination).toBe("exit");
  });

  it("treats shimmed Windows commands without a reported exit code as success even when child.killed is true", async () => {
    const child = createMockChild({
      closeCode: null,
      exitCode: null,
    });
    child.killed = true;

    spawnMock.mockImplementation(() => child);

    const result = await runCommandWithTimeout(
      ["npm", "--version"],
      { timeoutMs: 1000 },
      createDeps(),
    );
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.termination).toBe("exit");
  });

  it("uses cmd.exe wrapper with windowsVerbatimArguments in runExec for .cmd shims", async () => {
    const expectedComSpec = COM_SPEC;

    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "ok", "");
      },
    );

    await runExec("pnpm", ["--version"], 1000, createDeps());
    const captured = execFileMock.mock.calls[0] as ExecCall | undefined;
    expectCmdWrappedInvocation({ captured, expectedComSpec });
  });

  it("sets windowsHide on direct runExec invocations too", async () => {
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "ok", "");
      },
    );

    await runExec("node", ["--version"], 1000, createDeps());
    const captured = execFileMock.mock.calls[0] as ExecCall | undefined;
    if (!captured) {
      throw new Error("expected direct execFile invocation");
    }
    expect(captured[0]).toBe("node");
    expect(captured[1]).toEqual(["--version"]);
    expect(captured[2].windowsHide).toBe(true);
  });

  it("sets windowsHide on direct runCommandWithTimeout invocations too", async () => {
    spawnMock.mockImplementation(() => createMockChild());

    const result = await runCommandWithTimeout(
      ["node", "--version"],
      { timeoutMs: 1000 },
      createDeps(),
    );
    expect(result.code).toBe(0);
    const captured = spawnMock.mock.calls[0] as SpawnCall | undefined;
    if (!captured) {
      throw new Error("expected direct spawn invocation");
    }
    expect(captured[0]).toBe("node");
    expect(captured[1]).toEqual(["--version"]);
    expect(captured[2].windowsHide).toBe(true);
    expect(captured[2].windowsVerbatimArguments).toBeUndefined();
  });
});

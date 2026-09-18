import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSshSandboxCommand, uploadDirectoryToSshTarget, type SshSandboxDeps } from "./ssh.js";

const spawnMock = vi.fn();
const deps: SshSandboxDeps = { spawn: spawnMock };

type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function createClosingChild(): ChildProcess {
  const child = createMockChildProcess();
  process.nextTick(() => {
    child.emit("close", 0);
  });
  return child as unknown as ChildProcess;
}

const SESSION = {
  command: "ssh",
  configPath: "/tmp/openclaw-test-ssh-config",
  host: "openclaw-sandbox",
};

describe("ssh subprocess env sanitization", () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  afterEach(async () => {
    spawnMock.mockReset();
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true });
      }),
    );
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("filters blocked secrets before spawning ssh commands", async () => {
    spawnMock.mockImplementationOnce(() => createClosingChild());

    process.env.OPENAI_API_KEY = "sk-test-secret";
    process.env.LANG = "en_US.UTF-8";

    await runSshSandboxCommand(
      {
        session: SESSION,
        remoteCommand: "true",
      },
      deps,
    );

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined;
    const env = spawnOptions?.env;
    expect(env?.OPENAI_API_KEY).toBeUndefined();
    expect(env?.LANG).toBe("en_US.UTF-8");
  });

  it("filters blocked secrets before spawning ssh uploads", async () => {
    spawnMock.mockImplementation(() => createClosingChild());

    process.env.ANTHROPIC_API_KEY = "sk-test-secret";
    process.env.NODE_ENV = "test";
    const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-upload-env-"));
    tempDirs.push(localDir);

    await uploadDirectoryToSshTarget(
      {
        session: SESSION,
        localDir,
        remoteDir: "/remote/workspace",
      },
      deps,
    );

    const sshSpawnOptions = spawnMock.mock.calls[1]?.[2] as SpawnOptions | undefined;
    const env = sshSpawnOptions?.env;
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env?.NODE_ENV).toBe("test");
  });

  it.skipIf(process.platform === "win32")(
    "allows in-workspace symlinks to upload normally",
    async () => {
      spawnMock.mockImplementation(() => createClosingChild());

      const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-upload-safe-"));
      tempDirs.push(localDir);
      await fs.mkdir(path.join(localDir, "real"), { recursive: true });
      await fs.writeFile(path.join(localDir, "real", "payload.txt"), "ok\n", "utf8");
      await fs.symlink("real", path.join(localDir, "linked-dir"));

      await uploadDirectoryToSshTarget(
        {
          session: SESSION,
          localDir,
          remoteDir: "/remote/workspace",
        },
        deps,
      );

      expect(spawnMock).toHaveBeenCalledTimes(2);
    },
  );
});

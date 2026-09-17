import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { noteSessionLockHealth } from "./doctor-session-locks.js";

describe("noteSessionLockHealth", () => {
  let root: string;
  let envSnapshot: ReturnType<typeof captureEnv>;
  let note: Mock<(message: string, title?: string) => void>;

  beforeEach(async () => {
    note = vi.fn<(message: string, title?: string) => void>();
    envSnapshot = captureEnv(["DENNOU_STATE_DIR"]);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-locks-"));
    process.env.DENNOU_STATE_DIR = root;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(root, { recursive: true, force: true });
  });

  // Note: Bun's `fs.promises.access` resolves to `null` instead of `undefined`,
  // so existence checks stay explicit to keep both runners passing.
  async function pathExists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  it("reports existing lock files with pid status and age", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const lockPath = path.join(sessionsDir, "active.jsonl.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 1500).toISOString() }),
      "utf8",
    );

    await noteSessionLockHealth({ shouldRepair: false, staleMs: 60_000, note });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] as [string, string | undefined];
    expect(title).toBe("Session locks");
    expect(message).toContain("Found 1 session lock file");
    expect(message).toContain(`pid=${process.pid} (alive)`);
    expect(message).toContain("stale=no");
    expect(await pathExists(lockPath)).toBe(true);
  });

  it("removes stale locks in repair mode", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const staleLock = path.join(sessionsDir, "stale.jsonl.lock");
    const freshLock = path.join(sessionsDir, "fresh.jsonl.lock");

    await fs.writeFile(
      staleLock,
      JSON.stringify({ pid: -1, createdAt: new Date(Date.now() - 120_000).toISOString() }),
      "utf8",
    );
    await fs.writeFile(
      freshLock,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );

    await noteSessionLockHealth({ shouldRepair: true, staleMs: 30_000, note });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string | undefined];
    expect(message).toContain("[removed]");
    expect(message).toContain("Removed 1 stale session lock file");

    expect(await pathExists(staleLock)).toBe(false);
    expect(await pathExists(freshLock)).toBe(true);
  });
});

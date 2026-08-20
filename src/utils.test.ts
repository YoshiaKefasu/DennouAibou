import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureDir,
  resolveConfigDir,
  resolveHomeDir,
  resolveUserPath,
  shortenHomeInString,
  shortenHomePath,
  sleep,
} from "./utils.js";

async function withTempDir<T>(
  prefix: string,
  run: (dir: string) => T | Promise<T>,
): Promise<Awaited<T>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("ensureDir", () => {
  it("creates nested directory", async () => {
    await withTempDir("openclaw-test-", async (tmp) => {
      const target = path.join(tmp, "nested", "dir");
      await ensureDir(target);
      expect(fs.existsSync(target)).toBe(true);
    });
  });
});

describe("sleep", () => {
  it("resolves after delay using fake timers", async () => {
    vi.useFakeTimers();
    const promise = sleep(1000);
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe("resolveConfigDir", () => {
  it("prefers ~/.dennou-aibou when legacy dir is missing", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-config-dir-"));
    try {
      const newDir = path.join(root, ".openclaw");
      await fs.promises.mkdir(newDir, { recursive: true });
      const resolved = resolveConfigDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("expands DENNOU_STATE_DIR using the provided env", () => {
    const env = {
      HOME: "/tmp/openclaw-home",
      DENNOU_STATE_DIR: "~/state",
    } as NodeJS.ProcessEnv;

    expect(resolveConfigDir(env)).toBe(path.resolve("/tmp/openclaw-home", "state"));
  });
});

describe("resolveHomeDir", () => {
  it("prefers DENNOU_HOME over HOME", () => {
    vi.stubEnv("DENNOU_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    expect(resolveHomeDir()).toBe(path.resolve("/srv/openclaw-home"));

    vi.unstubAllEnvs();
  });
});

describe("shortenHomePath", () => {
  it("uses $DENNOU_HOME prefix when DENNOU_HOME is set", () => {
    vi.stubEnv("DENNOU_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    expect(shortenHomePath(`${path.resolve("/srv/openclaw-home")}/.openclaw/dennou-aibou.json`)).toBe(
      "$DENNOU_HOME/.openclaw/dennou-aibou.json",
    );

    vi.unstubAllEnvs();
  });
});

describe("shortenHomeInString", () => {
  it("uses $DENNOU_HOME replacement when DENNOU_HOME is set", () => {
    vi.stubEnv("DENNOU_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    expect(
      shortenHomeInString(`config: ${path.resolve("/srv/openclaw-home")}/.openclaw/dennou-aibou.json`),
    ).toBe("config: $DENNOU_HOME/.openclaw/dennou-aibou.json");

    vi.unstubAllEnvs();
  });
});

describe("resolveUserPath", () => {
  it("expands ~ to home dir", () => {
    expect(resolveUserPath("~", {}, () => "/Users/thoffman")).toBe(path.resolve("/Users/thoffman"));
  });

  it("expands ~/ to home dir", () => {
    expect(resolveUserPath("~/openclaw", {}, () => "/Users/thoffman")).toBe(
      path.resolve("/Users/thoffman", "openclaw"),
    );
  });

  it("resolves relative paths", () => {
    expect(resolveUserPath("tmp/dir")).toBe(path.resolve("tmp/dir"));
  });

  it("prefers DENNOU_HOME for tilde expansion", () => {
    vi.stubEnv("DENNOU_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    expect(resolveUserPath("~/openclaw")).toBe(path.resolve("/srv/openclaw-home", "openclaw"));

    vi.unstubAllEnvs();
  });

  it("uses the provided env for tilde expansion", () => {
    const env = {
      HOME: "/tmp/openclaw-home",
      DENNOU_HOME: "/srv/openclaw-home",
    } as NodeJS.ProcessEnv;

    expect(resolveUserPath("~/openclaw", env)).toBe(path.resolve("/srv/openclaw-home", "openclaw"));
  });

  it("keeps blank paths blank", () => {
    expect(resolveUserPath("")).toBe("");
    expect(resolveUserPath("   ")).toBe("");
  });

  it("returns empty string for undefined/null input", () => {
    expect(resolveUserPath(undefined as unknown as string)).toBe("");
    expect(resolveUserPath(null as unknown as string)).toBe("");
  });
});

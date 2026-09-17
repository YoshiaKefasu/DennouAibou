import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureOpenClawCliOnPath, type EnsureOpenClawPathFs } from "./path-env.js";

const abs = (p: string) => path.resolve(p);

type Harness = {
  fs: EnsureOpenClawPathFs;
  setDir: (p: string) => void;
  setExe: (p: string) => void;
};

function createHarness(): Harness {
  const dirs = new Set<string>();
  const executables = new Set<string>();
  return {
    fs: {
      constants: { X_OK: 1 },
      accessSync: (p: string) => {
        if (executables.has(abs(p))) {
          return;
        }
        throw new Error(`ENOENT: ${p}`);
      },
      statSync: (p: string) => {
        if (dirs.has(abs(p))) {
          return { isDirectory: () => true };
        }
        throw new Error(`ENOENT: ${p}`);
      },
    },
    setDir: (p) => dirs.add(abs(p)),
    setExe: (p) => executables.add(abs(p)),
  };
}

function createDefaultHarness(): Harness {
  const harness = createHarness();
  harness.setDir("/usr/bin");
  harness.setDir("/bin");
  return harness;
}

function createEnv(pathValue = "/usr/bin"): NodeJS.ProcessEnv {
  return { PATH: pathValue };
}

function bootstrapPath(
  harness: Harness,
  env: NodeJS.ProcessEnv,
  params: {
    execPath: string;
    cwd: string;
    homeDir: string;
    platform: NodeJS.Platform;
    allowProjectLocalBin?: boolean;
  },
) {
  ensureOpenClawCliOnPath({ ...params, env, fs: harness.fs });
  return (env.PATH ?? "").split(path.delimiter);
}

function setupAppCliRoot(harness: Harness, name: string) {
  const tmp = abs(`/tmp/openclaw-path/${name}`);
  const appBinDir = path.join(tmp, "AppBin");
  const appCli = path.join(appBinDir, "openclaw");
  harness.setDir(tmp);
  harness.setDir(appBinDir);
  harness.setExe(appCli);
  return { tmp, appBinDir, appCli };
}

function expectPathsAfter(parts: string[], anchor: string, expectedPaths: string[]) {
  const anchorIndex = parts.indexOf(anchor);
  expect(anchorIndex).toBeGreaterThanOrEqual(0);
  for (const expectedPath of expectedPaths) {
    expect(
      parts.indexOf(expectedPath),
      `${expectedPath} should come after ${anchor}`,
    ).toBeGreaterThan(anchorIndex);
  }
}

describe("ensureOpenClawCliOnPath", () => {
  it("prepends the bundled app bin dir when a sibling openclaw exists", () => {
    const harness = createDefaultHarness();
    const { tmp, appBinDir, appCli } = setupAppCliRoot(harness, "case-bundled");
    const env = createEnv();

    const updated = bootstrapPath(harness, env, {
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "darwin",
    });
    expect(updated[0]).toBe(appBinDir);
  });

  it("is idempotent", () => {
    const harness = createDefaultHarness();
    const env = { PATH: "/bin", DENNOU_PATH_BOOTSTRAPPED: "1" };
    ensureOpenClawCliOnPath({
      execPath: "/tmp/does-not-matter",
      cwd: "/tmp",
      homeDir: "/tmp",
      platform: "darwin",
      env,
      fs: harness.fs,
    });
    expect(env.PATH).toBe("/bin");
  });

  it("appends mise shims after system dirs", () => {
    const harness = createDefaultHarness();
    const { tmp, appCli } = setupAppCliRoot(harness, "case-mise");
    const miseDataDir = path.join(tmp, "mise");
    const shimsDir = path.join(miseDataDir, "shims");
    harness.setDir(miseDataDir);
    harness.setDir(shimsDir);

    const env = createEnv();
    env.MISE_DATA_DIR = miseDataDir;

    const updated = bootstrapPath(harness, env, {
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "darwin",
    });
    expectPathsAfter(updated, "/usr/bin", [shimsDir]);
  });

  it.each([
    {
      name: "explicit option",
      envValue: undefined,
      allowProjectLocalBin: true,
    },
    {
      name: "truthy env",
      envValue: "1",
      allowProjectLocalBin: undefined,
    },
  ])(
    "only appends project-local node_modules/.bin when enabled via $name",
    ({ envValue, allowProjectLocalBin }) => {
      const harness = createDefaultHarness();
      const { tmp, appCli } = setupAppCliRoot(harness, "case-project-local");
      const localBinDir = path.join(tmp, "node_modules", ".bin");
      const localCli = path.join(localBinDir, "openclaw");
      harness.setDir(path.join(tmp, "node_modules"));
      harness.setDir(localBinDir);
      harness.setExe(localCli);

      const withoutOptIn = bootstrapPath(harness, createEnv(), {
        execPath: appCli,
        cwd: tmp,
        homeDir: tmp,
        platform: "darwin",
      });
      expect(withoutOptIn.includes(localBinDir)).toBe(false);

      const withOptInEnv = createEnv();
      if (envValue !== undefined) {
        withOptInEnv.DENNOU_ALLOW_PROJECT_LOCAL_BIN = envValue;
      }

      const withOptIn = bootstrapPath(harness, withOptInEnv, {
        execPath: appCli,
        cwd: tmp,
        homeDir: tmp,
        platform: "darwin",
        ...(allowProjectLocalBin === undefined ? {} : { allowProjectLocalBin }),
      });
      expectPathsAfter(withOptIn, "/usr/bin", [localBinDir]);
    },
  );

  it("prepends XDG_BIN_HOME ahead of other user bin fallbacks", () => {
    const harness = createDefaultHarness();
    const { tmp, appCli } = setupAppCliRoot(harness, "case-xdg-bin-home");
    const xdgBinHome = path.join(tmp, "xdg-bin");
    const localBin = path.join(tmp, ".local", "bin");
    harness.setDir(xdgBinHome);
    harness.setDir(path.join(tmp, ".local"));
    harness.setDir(localBin);

    const env = createEnv();
    env.XDG_BIN_HOME = xdgBinHome;

    const updated = bootstrapPath(harness, env, {
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "linux",
    });
    expect(updated.indexOf(xdgBinHome)).toBeLessThan(updated.indexOf(localBin));
  });

  it("places ~/.local/bin AFTER /usr/bin to prevent PATH hijack", () => {
    const harness = createDefaultHarness();
    const { tmp, appCli } = setupAppCliRoot(harness, "case-path-hijack");
    const localBin = path.join(tmp, ".local", "bin");
    harness.setDir(path.join(tmp, ".local"));
    harness.setDir(localBin);

    const updated = bootstrapPath(harness, createEnv("/usr/bin:/bin"), {
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "linux",
    });
    expectPathsAfter(updated, "/usr/bin", [localBin]);
  });

  it("places all user-writable home dirs after system dirs", () => {
    const harness = createDefaultHarness();
    const { tmp, appCli } = setupAppCliRoot(harness, "case-user-writable-after-system");
    const localBin = path.join(tmp, ".local", "bin");
    const pnpmBin = path.join(tmp, ".local", "share", "pnpm");
    const bunBin = path.join(tmp, ".bun", "bin");
    const yarnBin = path.join(tmp, ".yarn", "bin");
    harness.setDir(path.join(tmp, ".local"));
    harness.setDir(localBin);
    harness.setDir(path.join(tmp, ".local", "share"));
    harness.setDir(pnpmBin);
    harness.setDir(path.join(tmp, ".bun"));
    harness.setDir(bunBin);
    harness.setDir(path.join(tmp, ".yarn"));
    harness.setDir(yarnBin);

    const updated = bootstrapPath(harness, createEnv("/usr/bin:/bin"), {
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "linux",
    });
    expectPathsAfter(updated, "/usr/bin", [localBin, pnpmBin, bunBin, yarnBin]);
  });

  it.each([
    {
      name: "appends Homebrew dirs after immutable OS dirs",
      setup: (harness: Harness) => {
        const { tmp, appCli } = setupAppCliRoot(harness, "case-homebrew-after-system");
        harness.setDir("/opt/homebrew/bin");
        harness.setDir("/usr/local/bin");
        return {
          env: createEnv("/usr/bin:/bin"),
          params: {
            execPath: appCli,
            cwd: tmp,
            homeDir: tmp,
            platform: "darwin" as const,
          },
          expectedPaths: ["/opt/homebrew/bin", "/usr/local/bin"],
          anchor: "/usr/bin",
        };
      },
    },
    {
      name: "appends Linuxbrew dirs after system dirs",
      setup: (harness: Harness) => {
        const tmp = abs("/tmp/openclaw-path/case-linuxbrew");
        const execDir = path.join(tmp, "exec");
        harness.setDir(tmp);
        harness.setDir(execDir);
        const linuxbrewDir = path.join(tmp, ".linuxbrew");
        const linuxbrewBin = path.join(linuxbrewDir, "bin");
        const linuxbrewSbin = path.join(linuxbrewDir, "sbin");
        harness.setDir(linuxbrewDir);
        harness.setDir(linuxbrewBin);
        harness.setDir(linuxbrewSbin);
        return {
          env: createEnv(),
          params: {
            execPath: path.join(execDir, "node"),
            cwd: tmp,
            homeDir: tmp,
            platform: "linux" as const,
          },
          expectedPaths: [linuxbrewBin, linuxbrewSbin],
          anchor: "/usr/bin",
        };
      },
    },
  ])("$name", ({ setup }) => {
    const harness = createDefaultHarness();
    const { env, params, expectedPaths, anchor } = setup(harness);
    const updated = bootstrapPath(harness, env, params);
    expectPathsAfter(updated, anchor, expectedPaths);
  });
});

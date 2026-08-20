import { beforeEach, describe, expect, it, vi } from "vitest";
import { bundledPluginRootAt } from "../../test/helpers/bundled-plugin-paths.js";
import type { OpenClawConfig } from "../config/config.js";

const APP_ROOT = "/app";

function appBundledPluginRoot(pluginId: string): string {
  return bundledPluginRootAt(APP_ROOT, pluginId);
}

const installPluginFromNpmSpecMock = vi.fn();
const installPluginFromMarketplaceMock = vi.fn();
const installPluginFromClawHubMock = vi.fn();
const resolveClawHubPluginVersionMock = vi.fn();
const resolveBundledPluginSourcesMock = vi.fn();
const readInstalledPackageVersionMock = vi.fn();

vi.mock("./install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpecMock(...args),
  resolvePluginInstallDir: (pluginId: string) => `/tmp/${pluginId}`,
  PLUGIN_INSTALL_ERROR_CODE: {
    NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  },
}));

vi.mock("./marketplace.js", () => ({
  installPluginFromMarketplace: (...args: unknown[]) => installPluginFromMarketplaceMock(...args),
}));

vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: (...args: unknown[]) => installPluginFromClawHubMock(...args),
  resolveClawHubPluginVersion: (...args: unknown[]) => resolveClawHubPluginVersionMock(...args),
}));

vi.mock("./bundled-sources.js", () => ({
  resolveBundledPluginSources: (...args: unknown[]) => resolveBundledPluginSourcesMock(...args),
}));

vi.mock("../infra/package-update-utils.js", () => ({
  readInstalledPackageVersion: (...args: unknown[]) => readInstalledPackageVersionMock(...args),
  expectedIntegrityForUpdate: (spec: string | undefined, integrity: string | undefined) => {
    if (!integrity || !spec) {
      return undefined;
    }
    const value = spec.trim();
    if (!value) {
      return undefined;
    }
    const at = value.lastIndexOf("@");
    if (at <= 0 || at >= value.length - 1) {
      return undefined;
    }
    const version = value.slice(at + 1).trim();
    if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
      return undefined;
    }
    return integrity;
  },
}));

const { syncPluginsForUpdateChannel, updateNpmInstalledPlugins } = await import("./update.js");

function createSuccessfulNpmUpdateResult(params?: {
  pluginId?: string;
  targetDir?: string;
  version?: string;
  npmResolution?: {
    name: string;
    version: string;
    resolvedSpec: string;
  };
}) {
  return {
    ok: true,
    pluginId: params?.pluginId ?? "opik-openclaw",
    targetDir: params?.targetDir ?? "/tmp/opik-openclaw",
    version: params?.version ?? "0.2.6",
    extensions: ["index.ts"],
    ...(params?.npmResolution ? { npmResolution: params.npmResolution } : {}),
  };
}

function createNpmInstallConfig(params: {
  pluginId: string;
  spec: string;
  installPath: string;
  integrity?: string;
  resolvedName?: string;
  resolvedSpec?: string;
}) {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          source: "npm" as const,
          spec: params.spec,
          installPath: params.installPath,
          ...(params.integrity ? { integrity: params.integrity } : {}),
          ...(params.resolvedName ? { resolvedName: params.resolvedName } : {}),
          ...(params.resolvedSpec ? { resolvedSpec: params.resolvedSpec } : {}),
        },
      },
    },
  };
}

function createMarketplaceInstallConfig(params: {
  pluginId: string;
  installPath: string;
  marketplaceSource: string;
  marketplacePlugin: string;
  marketplaceName?: string;
}): OpenClawConfig {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          source: "marketplace" as const,
          installPath: params.installPath,
          marketplaceSource: params.marketplaceSource,
          marketplacePlugin: params.marketplacePlugin,
          ...(params.marketplaceName ? { marketplaceName: params.marketplaceName } : {}),
        },
      },
    },
  };
}

function createClawHubInstallConfig(params: {
  pluginId: string;
  installPath: string;
  clawhubUrl: string;
  clawhubPackage: string;
  clawhubFamily: "bundle-plugin" | "code-plugin";
  clawhubChannel: "community" | "official" | "private";
}): OpenClawConfig {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          source: "clawhub" as const,
          spec: `clawhub:${params.clawhubPackage}`,
          installPath: params.installPath,
          clawhubUrl: params.clawhubUrl,
          clawhubPackage: params.clawhubPackage,
          clawhubFamily: params.clawhubFamily,
          clawhubChannel: params.clawhubChannel,
        },
      },
    },
  };
}

function createBundledPathInstallConfig(params: {
  loadPaths: string[];
  installPath: string;
  sourcePath?: string;
  spec?: string;
}): OpenClawConfig {
  return {
    plugins: {
      load: { paths: params.loadPaths },
      installs: {
        feishu: {
          source: "path",
          sourcePath: params.sourcePath ?? appBundledPluginRoot("feishu"),
          installPath: params.installPath,
          ...(params.spec ? { spec: params.spec } : {}),
        },
      },
    },
  };
}

function createCodexAppServerInstallConfig(params: {
  spec: string;
  resolvedName?: string;
  resolvedSpec?: string;
}) {
  return {
    plugins: {
      installs: {
        "openclaw-codex-app-server": {
          source: "npm" as const,
          spec: params.spec,
          installPath: "/tmp/openclaw-codex-app-server",
          ...(params.resolvedName ? { resolvedName: params.resolvedName } : {}),
          ...(params.resolvedSpec ? { resolvedSpec: params.resolvedSpec } : {}),
        },
      },
    },
  };
}

function expectNpmUpdateCall(params: {
  spec: string;
  expectedIntegrity?: string;
  expectedPluginId?: string;
}) {
  expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
    expect.objectContaining({
      spec: params.spec,
      expectedIntegrity: params.expectedIntegrity,
      ...(params.expectedPluginId ? { expectedPluginId: params.expectedPluginId } : {}),
    }),
  );
}

function createBundledSource(params?: { pluginId?: string; localPath?: string; npmSpec?: string }) {
  const pluginId = params?.pluginId ?? "feishu";
  return {
    pluginId,
    localPath: params?.localPath ?? appBundledPluginRoot(pluginId),
    npmSpec: params?.npmSpec ?? `@openclaw/${pluginId}`,
  };
}

function mockBundledSources(...sources: ReturnType<typeof createBundledSource>[]) {
  resolveBundledPluginSourcesMock.mockReturnValue(
    new Map(sources.map((source) => [source.pluginId, source])),
  );
}

function expectBundledPathInstall(params: {
  install: Record<string, unknown> | undefined;
  sourcePath: string;
  installPath: string;
  spec?: string;
}) {
  expect(params.install).toMatchObject({
    source: "path",
    sourcePath: params.sourcePath,
    installPath: params.installPath,
    ...(params.spec ? { spec: params.spec } : {}),
  });
}

function expectCodexAppServerInstallState(params: {
  result: Awaited<ReturnType<typeof updateNpmInstalledPlugins>>;
  spec: string;
  version: string;
  resolvedSpec?: string;
}) {
  expect(params.result.config.plugins?.installs?.["openclaw-codex-app-server"]).toMatchObject({
    source: "npm",
    spec: params.spec,
    installPath: "/tmp/openclaw-codex-app-server",
    version: params.version,
    ...(params.resolvedSpec ? { resolvedSpec: params.resolvedSpec } : {}),
  });
}

describe("updateNpmInstalledPlugins", () => {
  beforeEach(() => {
    installPluginFromNpmSpecMock.mockReset();
    installPluginFromMarketplaceMock.mockReset();
    installPluginFromClawHubMock.mockReset();
    resolveClawHubPluginVersionMock.mockReset();
    resolveBundledPluginSourcesMock.mockReset();
    readInstalledPackageVersionMock.mockReset();
  });

  it.each([
    {
      name: "skips integrity drift checks for unpinned npm specs during dry-run updates",
      config: createNpmInstallConfig({
        pluginId: "opik-openclaw",
        spec: "@opik/opik-openclaw",
        integrity: "sha512-old",
        installPath: "/tmp/opik-openclaw",
      }),
      pluginIds: ["opik-openclaw"],
      dryRun: true,
      expectedCall: {
        spec: "@opik/opik-openclaw",
        expectedIntegrity: undefined,
      },
    },
    {
      name: "keeps integrity drift checks for exact-version npm specs during dry-run updates",
      config: createNpmInstallConfig({
        pluginId: "opik-openclaw",
        spec: "@opik/opik-openclaw@0.2.5",
        integrity: "sha512-old",
        installPath: "/tmp/opik-openclaw",
      }),
      pluginIds: ["opik-openclaw"],
      dryRun: true,
      expectedCall: {
        spec: "@opik/opik-openclaw@0.2.5",
        expectedIntegrity: "sha512-old",
      },
    },
    {
      name: "skips recorded integrity checks when an explicit npm version override changes the spec",
      config: createNpmInstallConfig({
        pluginId: "openclaw-codex-app-server",
        spec: "openclaw-codex-app-server@0.2.0-beta.3",
        integrity: "sha512-old",
        installPath: "/tmp/openclaw-codex-app-server",
      }),
      pluginIds: ["openclaw-codex-app-server"],
      specOverrides: {
        "openclaw-codex-app-server": "openclaw-codex-app-server@0.2.0-beta.4",
      },
      installerResult: createSuccessfulNpmUpdateResult({
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-beta.4",
      }),
      expectedCall: {
        spec: "openclaw-codex-app-server@0.2.0-beta.4",
        expectedIntegrity: undefined,
      },
    },
  ] as const)(
    "$name",
    async ({ config, pluginIds, dryRun, specOverrides, installerResult, expectedCall }) => {
      installPluginFromNpmSpecMock.mockResolvedValue(
        installerResult ?? createSuccessfulNpmUpdateResult(),
      );

      await updateNpmInstalledPlugins({
        config,
        pluginIds: [...pluginIds],
        ...(dryRun ? { dryRun: true } : {}),
        ...(specOverrides ? { specOverrides } : {}),
      });

      expectNpmUpdateCall(expectedCall);
    },
  );

  it.each([
    {
      name: "formats package-not-found updates with a stable message",
      installerResult: {
        ok: false,
        code: "npm_package_not_found",
        error: "Package not found on npm: @openclaw/missing.",
      },
      config: createNpmInstallConfig({
        pluginId: "missing",
        spec: "@openclaw/missing",
        installPath: "/tmp/missing",
      }),
      pluginId: "missing",
      expectedMessage: "Failed to check missing: npm package not found for @openclaw/missing.",
    },
    {
      name: "falls back to raw installer error for unknown error codes",
      installerResult: {
        ok: false,
        code: "invalid_npm_spec",
        error: "unsupported npm spec: github:evil/evil",
      },
      config: createNpmInstallConfig({
        pluginId: "bad",
        spec: "github:evil/evil",
        installPath: "/tmp/bad",
      }),
      pluginId: "bad",
      expectedMessage: "Failed to check bad: unsupported npm spec: github:evil/evil",
    },
  ] as const)("$name", async ({ installerResult, config, pluginId, expectedMessage }) => {
    installPluginFromNpmSpecMock.mockResolvedValue(installerResult);

    const result = await updateNpmInstalledPlugins({
      config,
      pluginIds: [pluginId],
      dryRun: true,
    });

    expect(result.outcomes).toEqual([
      {
        pluginId,
        status: "error",
        message: expectedMessage,
      },
    ]);
  });

  it.each([
    {
      name: "reuses a recorded npm dist-tag spec for id-based updates",
      installerResult: {
        ok: true,
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-beta.4",
        extensions: ["index.ts"],
      },
      config: createCodexAppServerInstallConfig({
        spec: "openclaw-codex-app-server@beta",
        resolvedName: "openclaw-codex-app-server",
        resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.3",
      }),
      expectedSpec: "openclaw-codex-app-server@beta",
      expectedVersion: "0.2.0-beta.4",
    },
    {
      name: "uses and persists an explicit npm spec override during updates",
      installerResult: {
        ok: true,
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-beta.4",
        extensions: ["index.ts"],
        npmResolution: {
          name: "openclaw-codex-app-server",
          version: "0.2.0-beta.4",
          resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
        },
      },
      config: createCodexAppServerInstallConfig({
        spec: "openclaw-codex-app-server",
      }),
      specOverrides: {
        "openclaw-codex-app-server": "openclaw-codex-app-server@beta",
      },
      expectedSpec: "openclaw-codex-app-server@beta",
      expectedVersion: "0.2.0-beta.4",
      expectedResolvedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
    },
  ] as const)(
    "$name",
    async ({
      installerResult,
      config,
      specOverrides,
      expectedSpec,
      expectedVersion,
      expectedResolvedSpec,
    }) => {
      installPluginFromNpmSpecMock.mockResolvedValue(installerResult);

      const result = await updateNpmInstalledPlugins({
        config,
        pluginIds: ["openclaw-codex-app-server"],
        ...(specOverrides ? { specOverrides } : {}),
      });

      expectNpmUpdateCall({
        spec: expectedSpec,
        expectedPluginId: "openclaw-codex-app-server",
      });
      expectCodexAppServerInstallState({
        result,
        spec: expectedSpec,
        version: expectedVersion,
        ...(expectedResolvedSpec ? { resolvedSpec: expectedResolvedSpec } : {}),
      });
    },
  );

  it("updates ClawHub-installed plugins via recorded package metadata", async () => {
    installPluginFromClawHubMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/demo",
      version: "1.2.4",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        integrity: "sha256-next",
        resolvedAt: "2026-03-22T00:00:00.000Z",
      },
    });

    const result = await updateNpmInstalledPlugins({
      config: createClawHubInstallConfig({
        pluginId: "demo",
        installPath: "/tmp/demo",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
      }),
      pluginIds: ["demo"],
    });

    expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
        baseUrl: "https://clawhub.ai",
        expectedPluginId: "demo",
        mode: "update",
      }),
    );
    expect(result.config.plugins?.installs?.demo).toMatchObject({
      source: "clawhub",
      spec: "clawhub:demo",
      installPath: "/tmp/demo",
      version: "1.2.4",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      clawhubChannel: "official",
      integrity: "sha256-next",
    });
  });

  it("resolves legacy exact ClawHub record by id to unversioned latest line", async () => {
    readInstalledPackageVersionMock.mockResolvedValue("0.5.0");
    resolveClawHubPluginVersionMock.mockResolvedValue({
      ok: true,
      packageName: "episodic-claw",
      version: "0.5.1",
      compatibility: null,
      detail: {
        package: {
          name: "episodic-claw",
          family: "code-plugin",
          channel: "official",
        },
      },
    });
    installPluginFromClawHubMock.mockResolvedValue({
      ok: true,
      pluginId: "episodic-claw",
      targetDir: "/tmp/episodic-claw",
      version: "0.5.1",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "episodic-claw",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        integrity: "sha256-next",
        resolvedAt: "2026-06-30T00:00:00.000Z",
      },
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "episodic-claw": {
              source: "clawhub",
              spec: "clawhub:episodic-claw@0.5.0",
              installPath: "/tmp/episodic-claw",
              clawhubUrl: "https://clawhub.ai",
              clawhubPackage: "episodic-claw",
              clawhubFamily: "code-plugin",
              clawhubChannel: "official",
              version: "0.5.0",
            },
          },
        },
      },
      pluginIds: ["episodic-claw"],
    });

    // Metadata resolver should be called once with the unversioned latest-line spec.
    expect(resolveClawHubPluginVersionMock).toHaveBeenCalledTimes(1);
    expect(resolveClawHubPluginVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:episodic-claw",
        baseUrl: "https://clawhub.ai",
      }),
    );
    // Should call installer once with unversioned spec (latest line), not the legacy @0.5.0.
    expect(installPluginFromClawHubMock).toHaveBeenCalledTimes(1);
    expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:episodic-claw",
        baseUrl: "https://clawhub.ai",
        expectedPluginId: "episodic-claw",
        mode: "update",
      }),
    );
    // After successful update, saved spec should be normalized to unversioned.
    expect(result.config.plugins?.installs?.["episodic-claw"]).toMatchObject({
      source: "clawhub",
      spec: "clawhub:episodic-claw",
      version: "0.5.1",
    });
  });

  it("keeps explicit exact ClawHub selector pinned", async () => {
    readInstalledPackageVersionMock.mockResolvedValue("0.5.0");
    resolveClawHubPluginVersionMock.mockResolvedValue({
      ok: true,
      packageName: "episodic-claw",
      version: "0.5.0",
      compatibility: null,
      detail: {
        package: {
          name: "episodic-claw",
          family: "code-plugin",
          channel: "official",
        },
      },
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "episodic-claw": {
              source: "clawhub",
              spec: "clawhub:episodic-claw@0.5.0",
              installPath: "/tmp/episodic-claw",
              clawhubUrl: "https://clawhub.ai",
              clawhubPackage: "episodic-claw",
              clawhubFamily: "code-plugin",
              clawhubChannel: "official",
              version: "0.5.0",
            },
          },
        },
      },
      pluginIds: ["episodic-claw"],
      specOverrides: {
        "episodic-claw": "clawhub:episodic-claw@0.5.0",
      },
    });

    // Metadata resolver should be called with the exact pinned spec.
    expect(resolveClawHubPluginVersionMock).toHaveBeenCalledTimes(1);
    expect(resolveClawHubPluginVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:episodic-claw@0.5.0",
        baseUrl: "https://clawhub.ai",
      }),
    );
    // Version is unchanged — installer should NOT be called.
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    // Saved spec should remain pinned.
    expect(result.config.plugins?.installs?.["episodic-claw"]).toMatchObject({
      source: "clawhub",
      spec: "clawhub:episodic-claw@0.5.0",
    });
  });

  it("keeps beta dist-tag ClawHub selector pinned", async () => {
    readInstalledPackageVersionMock.mockResolvedValue("0.6.0-beta.1");
    resolveClawHubPluginVersionMock.mockResolvedValue({
      ok: true,
      packageName: "episodic-claw",
      version: "0.6.0-beta.1",
      compatibility: null,
      detail: {
        package: {
          name: "episodic-claw",
          family: "code-plugin",
          channel: "official",
        },
      },
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "episodic-claw": {
              source: "clawhub",
              spec: "clawhub:episodic-claw@beta",
              installPath: "/tmp/episodic-claw",
              clawhubUrl: "https://clawhub.ai",
              clawhubPackage: "episodic-claw",
              clawhubFamily: "code-plugin",
              clawhubChannel: "official",
              version: "0.6.0-beta.1",
            },
          },
        },
      },
      pluginIds: ["episodic-claw"],
    });

    // Metadata resolver should be called with the beta dist-tag spec.
    expect(resolveClawHubPluginVersionMock).toHaveBeenCalledTimes(1);
    expect(resolveClawHubPluginVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:episodic-claw@beta",
        baseUrl: "https://clawhub.ai",
      }),
    );
    // Version is unchanged — installer should NOT be called.
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    // Saved spec should remain pinned.
    expect(result.config.plugins?.installs?.["episodic-claw"]).toMatchObject({
      source: "clawhub",
      spec: "clawhub:episodic-claw@beta",
    });
  });

  it("skips ClawHub reinstall when version is unchanged", async () => {
    // Mock readInstalledPackageVersion to return the installed version.
    readInstalledPackageVersionMock.mockResolvedValue("1.2.4");

    // Mock metadata resolver returns same version as installed.
    resolveClawHubPluginVersionMock.mockResolvedValue({
      ok: true,
      packageName: "demo",
      version: "1.2.4",
      compatibility: null,
      detail: {
        package: {
          name: "demo",
          family: "code-plugin",
          channel: "official",
        },
      },
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            demo: {
              source: "clawhub",
              spec: "clawhub:demo",
              installPath: "/tmp/demo",
              clawhubUrl: "https://clawhub.ai",
              clawhubPackage: "demo",
              clawhubFamily: "code-plugin",
              clawhubChannel: "official",
              version: "1.2.4",
            },
          },
        },
      },
      pluginIds: ["demo"],
    });

    // Should report unchanged and not re-download.
    expect(result.outcomes).toEqual([
      {
        pluginId: "demo",
        status: "unchanged",
        currentVersion: "1.2.4",
        nextVersion: "1.2.4",
        message: "demo is up to date (1.2.4).",
      },
    ]);
    // Should NOT have called the archive installer at all.
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    // Should have called the metadata resolver.
    expect(resolveClawHubPluginVersionMock).toHaveBeenCalledTimes(1);
  });

  it("calls real installer exactly once when ClawHub version changes", async () => {
    // Mock readInstalledPackageVersion to return the old installed version.
    readInstalledPackageVersionMock.mockResolvedValue("0.5.0");

    // Mock metadata resolver returns a newer version.
    resolveClawHubPluginVersionMock.mockResolvedValue({
      ok: true,
      packageName: "episodic-claw",
      version: "0.5.1",
      compatibility: null,
      detail: {
        package: {
          name: "episodic-claw",
          family: "code-plugin",
          channel: "official",
        },
      },
    });

    // Mock real installer returns success.
    installPluginFromClawHubMock.mockResolvedValue({
      ok: true,
      pluginId: "episodic-claw",
      targetDir: "/tmp/episodic-claw",
      version: "0.5.1",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "episodic-claw",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        integrity: "sha256-next",
        resolvedAt: "2026-07-12T00:00:00.000Z",
      },
    });

    const result = await updateNpmInstalledPlugins({
      config: createClawHubInstallConfig({
        pluginId: "episodic-claw",
        installPath: "/tmp/episodic-claw",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "episodic-claw",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
      }),
      pluginIds: ["episodic-claw"],
    });

    // Should have called metadata resolver once (for version check).
    expect(resolveClawHubPluginVersionMock).toHaveBeenCalledTimes(1);
    // Should have called real installer exactly once (no dry-run probe).
    expect(installPluginFromClawHubMock).toHaveBeenCalledTimes(1);
    expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:episodic-claw",
        baseUrl: "https://clawhub.ai",
        expectedPluginId: "episodic-claw",
        mode: "update",
      }),
    );
    expect(result.outcomes).toEqual([
      {
        pluginId: "episodic-claw",
        status: "updated",
        currentVersion: "0.5.0",
        nextVersion: "0.5.1",
        message: "Updated episodic-claw: 0.5.0 -> 0.5.1.",
      },
    ]);
  });

  it("surfaces ClawHub metadata resolution error directly", async () => {
    // Mock readInstalledPackageVersion to return the installed version.
    readInstalledPackageVersionMock.mockResolvedValue("1.0.0");

    // Mock metadata resolver returns an error.
    resolveClawHubPluginVersionMock.mockResolvedValue({
      ok: false,
      error: "Package not found on ClawHub.",
      code: "package_not_found",
    });

    const result = await updateNpmInstalledPlugins({
      config: createClawHubInstallConfig({
        pluginId: "missing-pkg",
        installPath: "/tmp/missing-pkg",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "missing-pkg",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
      }),
      pluginIds: ["missing-pkg"],
    });

    // Should report the metadata error directly.
    expect(result.outcomes).toEqual([
      {
        pluginId: "missing-pkg",
        status: "error",
        message: "Failed to check missing-pkg: Package not found on ClawHub. (ClawHub clawhub:missing-pkg).",
      },
    ]);
    // Should NOT have called the real installer.
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
  });

  it("normalizes legacy exact ClawHub record after successful id-only update", async () => {
    readInstalledPackageVersionMock.mockResolvedValue("0.5.0");
    resolveClawHubPluginVersionMock.mockResolvedValue({
      ok: true,
      packageName: "episodic-claw",
      version: "0.6.0",
      compatibility: null,
      detail: {
        package: {
          name: "episodic-claw",
          family: "code-plugin",
          channel: "official",
        },
      },
    });
    installPluginFromClawHubMock.mockResolvedValue({
      ok: true,
      pluginId: "episodic-claw",
      targetDir: "/tmp/episodic-claw",
      version: "0.6.0",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "episodic-claw",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        integrity: "sha256-new",
        resolvedAt: "2026-06-30T00:00:00.000Z",
      },
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "episodic-claw": {
              source: "clawhub",
              spec: "clawhub:episodic-claw@0.5.0",
              installPath: "/tmp/episodic-claw",
              clawhubUrl: "https://clawhub.ai",
              clawhubPackage: "episodic-claw",
              clawhubFamily: "code-plugin",
              clawhubChannel: "official",
              version: "0.5.0",
            },
          },
        },
      },
      pluginIds: ["episodic-claw"],
    });

    // Metadata resolver should be called once with unversioned spec.
    expect(resolveClawHubPluginVersionMock).toHaveBeenCalledTimes(1);
    expect(resolveClawHubPluginVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:episodic-claw",
        baseUrl: "https://clawhub.ai",
      }),
    );
    // Installer should be called once (version changed from 0.5.0 to 0.6.0).
    expect(installPluginFromClawHubMock).toHaveBeenCalledTimes(1);
    // After successful update, saved spec should be normalized to unversioned.
    expect(result.config.plugins?.installs?.["episodic-claw"]).toMatchObject({
      source: "clawhub",
      spec: "clawhub:episodic-claw",
      version: "0.6.0",
      integrity: "sha256-new",
    });
  });

  it("stays on latest line after migration", async () => {
    // Mock readInstalledPackageVersion to return installed versions.
    readInstalledPackageVersionMock.mockResolvedValue("0.5.0");

    // First update: metadata resolver says 0.6.0 is available (differs from 0.5.0).
    resolveClawHubPluginVersionMock.mockResolvedValue({
      ok: true,
      packageName: "episodic-claw",
      version: "0.6.0",
      compatibility: null,
      detail: {
        package: {
          name: "episodic-claw",
          family: "code-plugin",
          channel: "official",
        },
      },
    });

    // First update: migrate from legacy exact to unversioned.
    installPluginFromClawHubMock.mockResolvedValueOnce({
      ok: true,
      pluginId: "episodic-claw",
      targetDir: "/tmp/episodic-claw",
      version: "0.6.0",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "episodic-claw",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        integrity: "sha256-v060",
        resolvedAt: "2026-06-30T00:00:00.000Z",
      },
    });

    const firstResult = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "episodic-claw": {
              source: "clawhub",
              spec: "clawhub:episodic-claw@0.5.0",
              installPath: "/tmp/episodic-claw",
              clawhubUrl: "https://clawhub.ai",
              clawhubPackage: "episodic-claw",
              clawhubFamily: "code-plugin",
              clawhubChannel: "official",
              version: "0.5.0",
            },
          },
        },
      },
      pluginIds: ["episodic-claw"],
    });

    // First update should normalize the spec.
    expect(firstResult.config.plugins?.installs?.["episodic-claw"]?.spec).toBe("clawhub:episodic-claw");

    // Update mock to return 0.7.0 for the second call.
    readInstalledPackageVersionMock.mockResolvedValue("0.6.0");
    resolveClawHubPluginVersionMock.mockResolvedValue({
      ok: true,
      packageName: "episodic-claw",
      version: "0.7.0",
      compatibility: null,
      detail: {
        package: {
          name: "episodic-claw",
          family: "code-plugin",
          channel: "official",
        },
      },
    });
    installPluginFromClawHubMock.mockResolvedValueOnce({
      ok: true,
      pluginId: "episodic-claw",
      targetDir: "/tmp/episodic-claw",
      version: "0.7.0",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "episodic-claw",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        integrity: "sha256-v070",
        resolvedAt: "2026-07-01T00:00:00.000Z",
      },
    });

    const secondResult = await updateNpmInstalledPlugins({
      config: firstResult.config,
      pluginIds: ["episodic-claw"],
    });

    // Second update should still use unversioned spec.
    expect(installPluginFromClawHubMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        spec: "clawhub:episodic-claw",
        baseUrl: "https://clawhub.ai",
        expectedPluginId: "episodic-claw",
        mode: "update",
      }),
    );
    expect(secondResult.config.plugins?.installs?.["episodic-claw"]).toMatchObject({
      source: "clawhub",
      spec: "clawhub:episodic-claw",
      version: "0.7.0",
    });
  });

  it("migrates legacy unscoped install keys when a scoped npm package updates", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "@openclaw/voice-call",
      targetDir: "/tmp/openclaw-voice-call",
      version: "0.0.2",
      extensions: ["index.ts"],
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          allow: ["voice-call"],
          deny: ["voice-call"],
          slots: { memory: "voice-call" },
          entries: {
            "voice-call": {
              enabled: false,
              hooks: { allowPromptInjection: false },
            },
          },
          installs: {
            "voice-call": {
              source: "npm",
              spec: "@openclaw/voice-call",
              installPath: "/tmp/voice-call",
            },
          },
        },
      },
      pluginIds: ["voice-call"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/voice-call",
        expectedPluginId: "voice-call",
      }),
    );
    expect(result.config.plugins?.allow).toEqual(["@openclaw/voice-call"]);
    expect(result.config.plugins?.deny).toEqual(["@openclaw/voice-call"]);
    expect(result.config.plugins?.slots?.memory).toBe("@openclaw/voice-call");
    expect(result.config.plugins?.entries?.["@openclaw/voice-call"]).toEqual({
      enabled: false,
      hooks: { allowPromptInjection: false },
    });
    expect(result.config.plugins?.entries?.["voice-call"]).toBeUndefined();
    expect(result.config.plugins?.installs?.["@openclaw/voice-call"]).toMatchObject({
      source: "npm",
      spec: "@openclaw/voice-call",
      installPath: "/tmp/openclaw-voice-call",
      version: "0.0.2",
    });
    expect(result.config.plugins?.installs?.["voice-call"]).toBeUndefined();
  });

  it("checks marketplace installs during dry-run updates", async () => {
    installPluginFromMarketplaceMock.mockResolvedValue({
      ok: true,
      pluginId: "claude-bundle",
      targetDir: "/tmp/claude-bundle",
      version: "1.2.0",
      extensions: ["index.ts"],
      marketplaceSource: "vincentkoc/claude-marketplace",
      marketplacePlugin: "claude-bundle",
    });

    const result = await updateNpmInstalledPlugins({
      config: createMarketplaceInstallConfig({
        pluginId: "claude-bundle",
        installPath: "/tmp/claude-bundle",
        marketplaceSource: "vincentkoc/claude-marketplace",
        marketplacePlugin: "claude-bundle",
      }),
      pluginIds: ["claude-bundle"],
      dryRun: true,
    });

    expect(installPluginFromMarketplaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "vincentkoc/claude-marketplace",
        plugin: "claude-bundle",
        expectedPluginId: "claude-bundle",
        dryRun: true,
      }),
    );
    expect(result.outcomes).toEqual([
      {
        pluginId: "claude-bundle",
        status: "updated",
        currentVersion: undefined,
        nextVersion: "1.2.0",
        message: "Would update claude-bundle: unknown -> 1.2.0.",
      },
    ]);
  });

  it("updates marketplace installs and preserves source metadata", async () => {
    installPluginFromMarketplaceMock.mockResolvedValue({
      ok: true,
      pluginId: "claude-bundle",
      targetDir: "/tmp/claude-bundle",
      version: "1.3.0",
      extensions: ["index.ts"],
      marketplaceName: "Vincent's Claude Plugins",
      marketplaceSource: "vincentkoc/claude-marketplace",
      marketplacePlugin: "claude-bundle",
    });

    const result = await updateNpmInstalledPlugins({
      config: createMarketplaceInstallConfig({
        pluginId: "claude-bundle",
        installPath: "/tmp/claude-bundle",
        marketplaceName: "Vincent's Claude Plugins",
        marketplaceSource: "vincentkoc/claude-marketplace",
        marketplacePlugin: "claude-bundle",
      }),
      pluginIds: ["claude-bundle"],
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.installs?.["claude-bundle"]).toMatchObject({
      source: "marketplace",
      installPath: "/tmp/claude-bundle",
      version: "1.3.0",
      marketplaceName: "Vincent's Claude Plugins",
      marketplaceSource: "vincentkoc/claude-marketplace",
      marketplacePlugin: "claude-bundle",
    });
  });

  it("forwards dangerous force unsafe install to plugin update installers", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-beta.4",
      }),
    );

    await updateNpmInstalledPlugins({
      config: createCodexAppServerInstallConfig({
        spec: "openclaw-codex-app-server@beta",
      }),
      pluginIds: ["openclaw-codex-app-server"],
      dangerouslyForceUnsafeInstall: true,
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "openclaw-codex-app-server@beta",
        dangerouslyForceUnsafeInstall: true,
        expectedPluginId: "openclaw-codex-app-server",
      }),
    );
  });
});

describe("syncPluginsForUpdateChannel", () => {
  beforeEach(() => {
    installPluginFromNpmSpecMock.mockReset();
    resolveBundledPluginSourcesMock.mockReset();
  });

  it.each([
    {
      name: "keeps bundled path installs on beta without reinstalling from npm",
      config: createBundledPathInstallConfig({
        loadPaths: [appBundledPluginRoot("feishu")],
        installPath: appBundledPluginRoot("feishu"),
        spec: "@openclaw/feishu",
      }),
      expectedChanged: false,
      expectedLoadPaths: [appBundledPluginRoot("feishu")],
      expectedInstallPath: appBundledPluginRoot("feishu"),
    },
    {
      name: "repairs bundled install metadata when the load path is re-added",
      config: createBundledPathInstallConfig({
        loadPaths: [],
        installPath: "/tmp/old-feishu",
        spec: "@openclaw/feishu",
      }),
      expectedChanged: true,
      expectedLoadPaths: [appBundledPluginRoot("feishu")],
      expectedInstallPath: appBundledPluginRoot("feishu"),
    },
  ] as const)(
    "$name",
    async ({ config, expectedChanged, expectedLoadPaths, expectedInstallPath }) => {
      mockBundledSources(createBundledSource());

      const result = await syncPluginsForUpdateChannel({
        channel: "beta",
        config,
      });

      expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
      expect(result.changed).toBe(expectedChanged);
      expect(result.summary.switchedToNpm).toEqual([]);
      expect(result.config.plugins?.load?.paths).toEqual(expectedLoadPaths);
      expectBundledPathInstall({
        install: result.config.plugins?.installs?.feishu,
        sourcePath: appBundledPluginRoot("feishu"),
        installPath: expectedInstallPath,
        spec: "@openclaw/feishu",
      });
    },
  );

  it("forwards an explicit env to bundled plugin source resolution", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
    const env = { DENNOU_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    await syncPluginsForUpdateChannel({
      channel: "beta",
      config: {},
      workspaceDir: "/workspace",
      env,
    });

    expect(resolveBundledPluginSourcesMock).toHaveBeenCalledWith({
      workspaceDir: "/workspace",
      env,
    });
  });

  it("uses the provided env when matching bundled load and install paths", async () => {
    const bundledHome = "/tmp/openclaw-home";
    mockBundledSources(
      createBundledSource({
        localPath: `${bundledHome}/plugins/feishu`,
      }),
    );

    const previousHome = process.env.HOME;
    process.env.HOME = "/tmp/process-home";
    try {
      const result = await syncPluginsForUpdateChannel({
        channel: "beta",
        env: {
          ...process.env,
          DENNOU_HOME: bundledHome,
          HOME: "/tmp/ignored-home",
        },
        config: {
          plugins: {
            load: { paths: ["~/plugins/feishu"] },
            installs: {
              feishu: {
                source: "path",
                sourcePath: "~/plugins/feishu",
                installPath: "~/plugins/feishu",
                spec: "@openclaw/feishu",
              },
            },
          },
        },
      });

      expect(result.changed).toBe(false);
      expect(result.config.plugins?.load?.paths).toEqual(["~/plugins/feishu"]);
      expectBundledPathInstall({
        install: result.config.plugins?.installs?.feishu,
        sourcePath: "~/plugins/feishu",
        installPath: "~/plugins/feishu",
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });
});

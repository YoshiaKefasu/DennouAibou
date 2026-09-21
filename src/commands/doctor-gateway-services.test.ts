import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { writeConfigFile } from "../config/config.js";
import { resolveGatewayPort, resolveIsNixMode } from "../config/paths.js";
import { findExtraGatewayServices, renderGatewayServiceCleanupHints } from "../daemon/inspect.js";
import { renderSystemNodeWarning, resolveSystemNodeInfo } from "../daemon/runtime-paths.js";
import {
  auditGatewayServiceConfig,
  needsNodeRuntimeMigration,
  readEmbeddedGatewayToken,
} from "../daemon/service-audit.js";
import { resolveGatewayService, type GatewayService } from "../daemon/service.js";
import { uninstallLegacySystemdUnits } from "../daemon/systemd.js";
import { note } from "../terminal/note.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";
import { resolveGatewayAuthTokenForService } from "./doctor-gateway-auth-token.js";
import {
  maybeRepairGatewayServiceConfig as maybeRepairGatewayServiceConfigImpl,
  maybeScanExtraGatewayServices as maybeScanExtraGatewayServicesImpl,
  type DoctorGatewayServicesDeps,
} from "./doctor-gateway-services.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { readEmbeddedGatewayTokenForTest } from "./doctor-service-audit.test-helpers.js";

// Explicit dependency injection replaces the module-level `vi.mock` calls
// (Bun cannot intercept ESM imports).

const service = {
  label: "systemd",
  loadedText: "enabled",
  notLoadedText: "disabled",
  stage: vi.fn<GatewayService["stage"]>(async () => {}),
  install: vi.fn<GatewayService["install"]>(async () => {}),
  uninstall: vi.fn<GatewayService["uninstall"]>(async () => {}),
  stop: vi.fn<GatewayService["stop"]>(async () => {}),
  restart: vi.fn<GatewayService["restart"]>(async () => ({ outcome: "completed" })),
  isLoaded: vi.fn<GatewayService["isLoaded"]>(async () => true),
  readCommand: vi.fn<GatewayService["readCommand"]>(),
  readRuntime: vi.fn<GatewayService["readRuntime"]>(),
} satisfies GatewayService;
const readCommandMock = service.readCommand;
const stageMock = service.stage;
const installMock = service.install;

const realpathMock = vi.fn<(path: string) => Promise<string>>(async (value) => value);
const writeConfigFileMock = vi.fn<typeof writeConfigFile>(async () => {});
const auditGatewayServiceConfigMock = vi.fn<typeof auditGatewayServiceConfig>();
const buildGatewayInstallPlanMock = vi.fn<typeof buildGatewayInstallPlan>();
const resolveGatewayAuthTokenForServiceMock = vi.fn<typeof resolveGatewayAuthTokenForService>();
const resolveGatewayPortMock = vi.fn<typeof resolveGatewayPort>(() => 18789);
const resolveIsNixModeMock = vi.fn<typeof resolveIsNixMode>(() => false);
const findExtraGatewayServicesMock = vi.fn<typeof findExtraGatewayServices>();
const renderGatewayServiceCleanupHintsMock = vi.fn<typeof renderGatewayServiceCleanupHints>(
  () => [],
);
const uninstallLegacySystemdUnitsMock = vi.fn<typeof uninstallLegacySystemdUnits>();
const noteMock = vi.fn<typeof note>();
const needsNodeRuntimeMigrationMock = vi.fn<typeof needsNodeRuntimeMigration>(() => false);
const resolveSystemNodeInfoMock = vi.fn<typeof resolveSystemNodeInfo>();
const renderSystemNodeWarningMock = vi.fn<typeof renderSystemNodeWarning>(() => null);

const deps: DoctorGatewayServicesDeps = {
  realpath: realpathMock,
  resolveIsNixMode: resolveIsNixModeMock,
  writeConfigFile: writeConfigFileMock,
  resolveGatewayService: () => service,
  resolveGatewayPort: resolveGatewayPortMock,
  resolveGatewayAuthTokenForService: resolveGatewayAuthTokenForServiceMock,
  auditGatewayServiceConfig: auditGatewayServiceConfigMock,
  readEmbeddedGatewayToken: readEmbeddedGatewayTokenForTest,
  needsNodeRuntimeMigration: needsNodeRuntimeMigrationMock,
  resolveSystemNodeInfo: resolveSystemNodeInfoMock,
  renderSystemNodeWarning: renderSystemNodeWarningMock,
  buildGatewayInstallPlan: buildGatewayInstallPlanMock,
  findExtraGatewayServices: findExtraGatewayServicesMock,
  renderGatewayServiceCleanupHints: renderGatewayServiceCleanupHintsMock,
  uninstallLegacySystemdUnits: uninstallLegacySystemdUnitsMock,
  note: noteMock,
};

const maybeRepairGatewayServiceConfig = (
  cfg: Parameters<typeof maybeRepairGatewayServiceConfigImpl>[0],
  mode: Parameters<typeof maybeRepairGatewayServiceConfigImpl>[1],
  runtime: Parameters<typeof maybeRepairGatewayServiceConfigImpl>[2],
  prompter: Parameters<typeof maybeRepairGatewayServiceConfigImpl>[3],
) => maybeRepairGatewayServiceConfigImpl(cfg, mode, runtime, prompter, deps);

const maybeScanExtraGatewayServices = (
  options: Parameters<typeof maybeScanExtraGatewayServicesImpl>[0],
  runtime: Parameters<typeof maybeScanExtraGatewayServicesImpl>[1],
  prompter: Parameters<typeof maybeScanExtraGatewayServicesImpl>[2],
) => maybeScanExtraGatewayServicesImpl(options, runtime, prompter, deps);

const originalStdinIsTTY = process.stdin.isTTY;
const originalUpdateInProgress = process.env.DENNOU_UPDATE_IN_PROGRESS;

function makeDoctorIo() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function makeDoctorPrompts() {
  return {
    confirm: vi.fn().mockResolvedValue(true),
    confirmAutoFix: vi.fn().mockResolvedValue(true),
    confirmAggressiveAutoFix: vi.fn().mockResolvedValue(true),
    confirmRuntimeRepair: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue("node"),
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  };
}

async function runRepair(cfg: OpenClawConfig) {
  await maybeRepairGatewayServiceConfig(cfg, "local", makeDoctorIo(), makeDoctorPrompts());
}

async function runNonInteractiveRepair(params: {
  cfg?: OpenClawConfig;
  updateInProgress?: boolean;
}) {
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
  if (params.updateInProgress) {
    process.env.DENNOU_UPDATE_IN_PROGRESS = "1";
  } else {
    delete process.env.DENNOU_UPDATE_IN_PROGRESS;
  }
  await maybeRepairGatewayServiceConfig(
    params.cfg ?? { gateway: {} },
    "local",
    makeDoctorIo(),
    createDoctorPrompter({
      runtime: makeDoctorIo(),
      options: {
        repair: true,
        nonInteractive: true,
      },
    }),
  );
}

const gatewayProgramArguments = [
  "/usr/bin/node",
  "/usr/local/bin/openclaw",
  "gateway",
  "--port",
  "18789",
];

function createGatewayCommand(entrypoint: string) {
  return {
    programArguments: ["/usr/bin/node", entrypoint, "gateway", "--port", "18789"],
    environment: {},
  };
}

function setupGatewayEntrypointRepairScenario(params: {
  currentEntrypoint: string;
  installEntrypoint: string;
  installWorkingDirectory?: string;
  realpath?: (value: string) => Promise<string>;
  realpathError?: Error;
}) {
  readCommandMock.mockResolvedValue(createGatewayCommand(params.currentEntrypoint));
  auditGatewayServiceConfigMock.mockResolvedValue({
    ok: true,
    issues: [],
  });
  buildGatewayInstallPlanMock.mockResolvedValue({
    ...createGatewayCommand(params.installEntrypoint),
    ...(params.installWorkingDirectory ? { workingDirectory: params.installWorkingDirectory } : {}),
  });
  if (params.realpath) {
    realpathMock.mockImplementation(params.realpath);
  } else if (params.realpathError) {
    realpathMock.mockRejectedValue(params.realpathError);
  } else {
    realpathMock.mockImplementation(async (value: string) => value);
  }
}

function setupGatewayTokenRepairScenario() {
  readCommandMock.mockResolvedValue({
    programArguments: gatewayProgramArguments,
    environment: {
      DENNOU_GATEWAY_TOKEN: "stale-token",
    },
  });
  auditGatewayServiceConfigMock.mockResolvedValue({
    ok: false,
    issues: [
      {
        code: "gateway-token-mismatch",
        message: "Gateway service DENNOU_GATEWAY_TOKEN does not match gateway.auth.token",
        level: "recommended",
      },
    ],
  });
  buildGatewayInstallPlanMock.mockResolvedValue({
    programArguments: gatewayProgramArguments,
    workingDirectory: "/tmp",
    environment: {},
  });
  installMock.mockResolvedValue(undefined);
}

describe("maybeRepairGatewayServiceConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    realpathMock.mockImplementation(async (value: string) => value);
    resolveGatewayAuthTokenForServiceMock.mockImplementation(async (cfg: OpenClawConfig, env) => {
      const configToken =
        typeof cfg.gateway?.auth?.token === "string" ? cfg.gateway.auth.token.trim() : undefined;
      const envToken = env.DENNOU_GATEWAY_TOKEN?.trim() || undefined;
      return { token: configToken || envToken };
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
      configurable: true,
    });
    if (originalUpdateInProgress === undefined) {
      delete process.env.DENNOU_UPDATE_IN_PROGRESS;
    } else {
      process.env.DENNOU_UPDATE_IN_PROGRESS = originalUpdateInProgress;
    }
  });

  it("treats gateway.auth.token as source of truth for service token repairs", async () => {
    setupGatewayTokenRepairScenario();

    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "config-token",
        },
      },
    };

    await runRepair(cfg);

    expect(auditGatewayServiceConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGatewayToken: "config-token",
      }),
    );
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          gateway: expect.objectContaining({
            auth: expect.objectContaining({
              token: "config-token",
            }),
          }),
        }),
      }),
    );
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(stageMock).not.toHaveBeenCalled();
    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it("uses DENNOU_GATEWAY_TOKEN when config token is missing", async () => {
    await withEnvAsync({ DENNOU_GATEWAY_TOKEN: "env-token" }, async () => {
      setupGatewayTokenRepairScenario();

      const cfg: OpenClawConfig = {
        gateway: {},
      };

      await runRepair(cfg);

      expect(auditGatewayServiceConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedGatewayToken: "env-token",
        }),
      );
      expect(buildGatewayInstallPlanMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            gateway: expect.objectContaining({
              auth: expect.objectContaining({
                token: "env-token",
              }),
            }),
          }),
        }),
      );
      expect(writeConfigFileMock).toHaveBeenCalledWith(
        expect.objectContaining({
          gateway: expect.objectContaining({
            auth: expect.objectContaining({
              token: "env-token",
            }),
          }),
        }),
      );
      expect(stageMock).not.toHaveBeenCalled();
      expect(installMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not flag entrypoint mismatch when symlink and realpath match", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint: "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js",
      installEntrypoint:
        "/Users/test/Library/pnpm/global/5/node_modules/.pnpm/openclaw@2026.3.12/node_modules/openclaw/dist/index.js",
      realpath: async (value: string) => {
        // path.resolve() yields platform separators; match the symlink mapping on
        // both POSIX and Windows so the fixture stays platform-agnostic.
        const from = "/global/5/node_modules/openclaw/";
        const to = "/global/5/node_modules/.pnpm/openclaw@2026.3.12/node_modules/openclaw/";
        if (value.includes(from) || value.includes(from.replace(/\//g, "\\"))) {
          return value
            .replace(from, to)
            .replace(from.replace(/\//g, "\\"), to.replace(/\//g, "\\"));
        }
        return value;
      },
    });

    await runRepair({ gateway: {} });

    expect(noteMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Gateway service entrypoint does not match the current install."),
      "Gateway service config",
    );
    expect(stageMock).not.toHaveBeenCalled();
    expect(installMock).not.toHaveBeenCalled();
  });

  it("does not flag entrypoint mismatch when realpath fails but normalized absolute paths match", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint: "/opt/openclaw/../openclaw/dist/index.js",
      installEntrypoint: "/opt/openclaw/dist/index.js",
      realpathError: new Error("no realpath"),
    });

    await runRepair({ gateway: {} });

    expect(noteMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Gateway service entrypoint does not match the current install."),
      "Gateway service config",
    );
    expect(stageMock).not.toHaveBeenCalled();
    expect(installMock).not.toHaveBeenCalled();
  });

  it("still flags entrypoint mismatch when canonicalized paths differ", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint:
        "/Users/test/.nvm/versions/node/v22.0.0/lib/node_modules/openclaw/dist/index.js",
      installEntrypoint: "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js",
    });

    await runRepair({ gateway: {} });

    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Gateway service entrypoint does not match the current install."),
      "Gateway service config",
    );
    expect(stageMock).not.toHaveBeenCalled();
    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it("repairs entrypoint mismatch in non-interactive fix mode", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/entry.js",
      installEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/index.js",
      installWorkingDirectory: "/tmp",
    });

    await runNonInteractiveRepair({
      cfg: { gateway: {} },
      updateInProgress: false,
    });

    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Gateway service entrypoint does not match the current install."),
      "Gateway service config",
    );
    expect(stageMock).not.toHaveBeenCalled();
    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it("stages service config repairs during non-interactive update repairs", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/entry.js",
      installEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/index.js",
      installWorkingDirectory: "/tmp",
    });

    await runNonInteractiveRepair({
      cfg: { gateway: {} },
      updateInProgress: true,
    });

    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Gateway service entrypoint does not match the current install."),
      "Gateway service config",
    );
    expect(stageMock).toHaveBeenCalledTimes(1);
    expect(installMock).not.toHaveBeenCalled();
  });

  it("treats SecretRef-managed gateway token as non-persisted service state", async () => {
    readCommandMock.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: {
        DENNOU_GATEWAY_TOKEN: "stale-token",
      },
    });
    auditGatewayServiceConfigMock.mockResolvedValue({
      ok: false,
      issues: [],
    });
    buildGatewayInstallPlanMock.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {},
    });
    installMock.mockResolvedValue(undefined);

    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: {
            source: "env",
            provider: "default",
            id: "DENNOU_GATEWAY_TOKEN",
          },
        },
      },
    };

    await runRepair(cfg);

    expect(auditGatewayServiceConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGatewayToken: undefined,
      }),
    );
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
      }),
    );
    expect(stageMock).not.toHaveBeenCalled();
    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to embedded service token when config and env tokens are missing", async () => {
    await withEnvAsync(
      {
        DENNOU_GATEWAY_TOKEN: undefined,
      },
      async () => {
        setupGatewayTokenRepairScenario();

        const cfg: OpenClawConfig = {
          gateway: {},
        };

        await runRepair(cfg);

        expect(auditGatewayServiceConfigMock).toHaveBeenCalledWith(
          expect.objectContaining({
            expectedGatewayToken: undefined,
          }),
        );
        expect(writeConfigFileMock).toHaveBeenCalledWith(
          expect.objectContaining({
            gateway: expect.objectContaining({
              auth: expect.objectContaining({
                token: "stale-token",
              }),
            }),
          }),
        );
        expect(buildGatewayInstallPlanMock).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({
              gateway: expect.objectContaining({
                auth: expect.objectContaining({
                  token: "stale-token",
                }),
              }),
            }),
          }),
        );
        expect(stageMock).not.toHaveBeenCalled();
        expect(installMock).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("does not persist embedded service tokens during non-interactive update repairs", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    process.env.DENNOU_UPDATE_IN_PROGRESS = "1";

    await withEnvAsync(
      {
        DENNOU_GATEWAY_TOKEN: undefined,
      },
      async () => {
        setupGatewayTokenRepairScenario();

        const cfg: OpenClawConfig = {
          gateway: {},
        };

        await maybeRepairGatewayServiceConfig(
          cfg,
          "local",
          makeDoctorIo(),
          createDoctorPrompter({
            runtime: makeDoctorIo(),
            options: {
              repair: true,
              nonInteractive: true,
            },
          }),
        );

        expect(writeConfigFileMock).not.toHaveBeenCalled();
        expect(stageMock).toHaveBeenCalledTimes(1);
        expect(installMock).not.toHaveBeenCalled();
      },
    );
  });

  it("does not persist EnvironmentFile-backed service tokens into config", async () => {
    await withEnvAsync(
      {
        DENNOU_GATEWAY_TOKEN: undefined,
      },
      async () => {
        readCommandMock.mockResolvedValue({
          programArguments: gatewayProgramArguments,
          environment: {
            DENNOU_GATEWAY_TOKEN: "env-file-token",
          },
          environmentValueSources: {
            DENNOU_GATEWAY_TOKEN: "file",
          },
        });
        auditGatewayServiceConfigMock.mockResolvedValue({
          ok: false,
          issues: [],
        });
        buildGatewayInstallPlanMock.mockResolvedValue({
          programArguments: gatewayProgramArguments,
          workingDirectory: "/tmp",
          environment: {},
        });
        installMock.mockResolvedValue(undefined);

        const cfg: OpenClawConfig = {
          gateway: {},
        };

        await runRepair(cfg);

        expect(writeConfigFileMock).not.toHaveBeenCalled();
        expect(buildGatewayInstallPlanMock).toHaveBeenCalledWith(
          expect.objectContaining({
            config: cfg,
          }),
        );
        expect(stageMock).not.toHaveBeenCalled();
      },
    );
  });
});

describe("maybeScanExtraGatewayServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findExtraGatewayServicesMock.mockResolvedValue([]);
    renderGatewayServiceCleanupHintsMock.mockReturnValue([]);
    uninstallLegacySystemdUnitsMock.mockResolvedValue([]);
  });

  it("removes legacy Linux user systemd services", async () => {
    findExtraGatewayServicesMock.mockResolvedValue([
      {
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: "unit: /home/test/.config/systemd/user/clawdbot-gateway.service",
        scope: "user",
        legacy: true,
      },
    ]);
    uninstallLegacySystemdUnitsMock.mockResolvedValue([
      {
        name: "clawdbot-gateway",
        unitPath: "/home/test/.config/systemd/user/clawdbot-gateway.service",
        enabled: true,
        exists: true,
      },
    ]);

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const prompter = {
      confirm: vi.fn(),
      confirmAutoFix: vi.fn(),
      confirmAggressiveAutoFix: vi.fn(),
      confirmRuntimeRepair: vi.fn().mockResolvedValue(true),
      select: vi.fn(),
      shouldRepair: false,
      shouldForce: false,
      repairMode: {
        shouldRepair: false,
        shouldForce: false,
        nonInteractive: false,
        canPrompt: true,
        updateInProgress: false,
      },
    };

    await maybeScanExtraGatewayServices({ deep: false }, runtime, prompter);

    expect(uninstallLegacySystemdUnitsMock).toHaveBeenCalledTimes(1);
    expect(uninstallLegacySystemdUnitsMock).toHaveBeenCalledWith({
      env: process.env,
      stdout: process.stdout,
    });
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("clawdbot-gateway.service"),
      "Legacy gateway removed",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Legacy gateway services removed. Installing OpenClaw gateway next.",
    );
  });
});

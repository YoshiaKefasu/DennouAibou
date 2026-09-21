import fsPromises from "node:fs/promises";
import nodePath from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { readConfigFileSnapshot, replaceConfigFile, resolveGatewayPort } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { note } from "../terminal/note.js";
import { resolveUserPath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { resolveSetupSecretInputString } from "../wizard/setup.secret-input.js";
import { removeChannelConfigWizard } from "./configure.channels.js";
import { maybeInstallDaemon } from "./configure.daemon.js";
import { promptAuthConfig } from "./configure.gateway-auth.js";
import { promptGatewayConfig } from "./configure.gateway.js";
import type {
  ChannelsWizardMode,
  ConfigureWizardParams,
  WizardSection,
} from "./configure.shared.js";
import {
  CONFIGURE_SECTION_OPTIONS,
  confirm,
  intro,
  outro,
  select,
  text,
} from "./configure.shared.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { healthCommand } from "./health.js";
import { noteChannelStatus, setupChannels } from "./onboard-channels.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  guardCancel,
  probeGatewayReachable,
  resolveControlUiLinks,
  summarizeExistingConfig,
  waitForGatewayReachable,
} from "./onboard-helpers.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";
// Note: was a dynamic import; kept static intentionally (jiti race avoidance).
import { resolveSearchProviderOptions, setupSearch } from "./onboard-search.js";
import { setupSkills } from "./onboard-skills.js";

export type ConfigureWizardDeps = {
  intro?: typeof intro;
  outro?: typeof outro;
  select?: typeof select;
  confirm?: typeof confirm;
  text?: typeof text;
  readConfigFileSnapshot?: typeof readConfigFileSnapshot;
  replaceConfigFile?: typeof replaceConfigFile;
  resolveGatewayPort?: typeof resolveGatewayPort;
  logConfigUpdated?: typeof logConfigUpdated;
  ensureControlUiAssetsBuilt?: typeof ensureControlUiAssetsBuilt;
  note?: typeof note;
  createClackPrompter?: typeof createClackPrompter;
  promptAuthConfig?: typeof promptAuthConfig;
  promptGatewayConfig?: typeof promptGatewayConfig;
  removeChannelConfigWizard?: typeof removeChannelConfigWizard;
  maybeInstallDaemon?: typeof maybeInstallDaemon;
  promptRemoteGatewayConfig?: typeof promptRemoteGatewayConfig;
  setupSkills?: typeof setupSkills;
  setupChannels?: typeof setupChannels;
  noteChannelStatus?: typeof noteChannelStatus;
  healthCommand?: typeof healthCommand;
  formatHealthCheckFailure?: typeof formatHealthCheckFailure;
  applyWizardMetadata?: typeof applyWizardMetadata;
  ensureWorkspaceAndSessions?: typeof ensureWorkspaceAndSessions;
  probeGatewayReachable?: typeof probeGatewayReachable;
  resolveControlUiLinks?: typeof resolveControlUiLinks;
  summarizeExistingConfig?: typeof summarizeExistingConfig;
  waitForGatewayReachable?: typeof waitForGatewayReachable;
  resolveSearchProviderOptions?: typeof resolveSearchProviderOptions;
  setupSearch?: typeof setupSearch;
};

type ConfigureSectionChoice = WizardSection | "__continue";

async function resolveGatewaySecretInputForWizard(params: {
  cfg: OpenClawConfig;
  value: unknown;
  path: string;
}): Promise<string | undefined> {
  try {
    return await resolveSetupSecretInputString({
      config: params.cfg,
      value: params.value,
      path: params.path,
      env: process.env,
    });
  } catch {
    return undefined;
  }
}

async function runGatewayHealthCheck(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  port: number;
  deps: ConfigureWizardDeps;
}): Promise<void> {
  const localLinks = (params.deps.resolveControlUiLinks ?? resolveControlUiLinks)({
    bind: params.cfg.gateway?.bind ?? "loopback",
    port: params.port,
    customBindHost: params.cfg.gateway?.customBindHost,
    basePath: undefined,
  });
  const remoteUrl = params.cfg.gateway?.remote?.url?.trim();
  const wsUrl = params.cfg.gateway?.mode === "remote" && remoteUrl ? remoteUrl : localLinks.wsUrl;
  const configuredToken = await resolveGatewaySecretInputForWizard({
    cfg: params.cfg,
    value: params.cfg.gateway?.auth?.token,
    path: "gateway.auth.token",
  });
  const configuredPassword = await resolveGatewaySecretInputForWizard({
    cfg: params.cfg,
    value: params.cfg.gateway?.auth?.password,
    path: "gateway.auth.password",
  });
  const token = process.env.DENNOU_GATEWAY_TOKEN ?? configuredToken;
  const password = process.env.DENNOU_GATEWAY_PASSWORD ?? configuredPassword;

  await (params.deps.waitForGatewayReachable ?? waitForGatewayReachable)({
    url: wsUrl,
    token,
    password,
    deadlineMs: 15_000,
  });

  try {
    await (params.deps.healthCommand ?? healthCommand)(
      { json: false, timeoutMs: 10_000 },
      params.runtime,
    );
  } catch (err) {
    params.runtime.error((params.deps.formatHealthCheckFailure ?? formatHealthCheckFailure)(err));
    (params.deps.note ?? note)(
      [
        "Docs:",
        "https://docs.openclaw.ai/gateway/health",
        "https://docs.openclaw.ai/gateway/troubleshooting",
      ].join("\n"),
      "Health check help",
    );
  }
}

async function promptConfigureSection(
  runtime: RuntimeEnv,
  hasSelection: boolean,
  deps: ConfigureWizardDeps,
): Promise<ConfigureSectionChoice> {
  return guardCancel(
    await (deps.select ?? select)<ConfigureSectionChoice>({
      message: "Select sections to configure",
      options: [
        ...CONFIGURE_SECTION_OPTIONS,
        {
          value: "__continue",
          label: "Continue",
          hint: hasSelection ? "Done" : "Skip for now",
        },
      ],
      initialValue: CONFIGURE_SECTION_OPTIONS[0]?.value,
    }),
    runtime,
  );
}

async function promptChannelMode(
  runtime: RuntimeEnv,
  deps: ConfigureWizardDeps,
): Promise<ChannelsWizardMode> {
  return guardCancel(
    await (deps.select ?? select)({
      message: "Channels",
      options: [
        {
          value: "configure",
          label: "Configure/link",
          hint: "Add/update channels; disable unselected accounts",
        },
        {
          value: "remove",
          label: "Remove channel config",
          hint: "Delete channel tokens/settings from dennou-aibou.json",
        },
      ],
      initialValue: "configure",
    }),
    runtime,
  ) as ChannelsWizardMode;
}

async function promptWebToolsConfig(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: ReturnType<typeof createClackPrompter>,
  deps: ConfigureWizardDeps,
): Promise<OpenClawConfig> {
  type WebSearchConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"];
  const existingSearch = nextConfig.tools?.web?.search;
  const existingFetch = nextConfig.tools?.web?.fetch;
  const resolveSearchProviderOptionsImpl =
    deps.resolveSearchProviderOptions ?? resolveSearchProviderOptions;
  const setupSearchImpl = deps.setupSearch ?? setupSearch;
  const searchProviderOptions = resolveSearchProviderOptionsImpl(nextConfig);

  (deps.note ?? note)(
    [
      "Web search lets your agent look things up online using the `web_search` tool.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const enableSearch = guardCancel(
    await (deps.confirm ?? confirm)({
      message: "Enable web_search?",
      initialValue: existingSearch?.enabled ?? searchProviderOptions.length > 0,
    }),
    runtime,
  );

  let nextSearch: WebSearchConfig = {
    ...existingSearch,
    enabled: enableSearch,
  };
  let workingConfig = nextConfig;

  if (enableSearch) {
    let configureManagedProvider = true;

    if (searchProviderOptions.length === 0) {
      if (configureManagedProvider) {
        (deps.note ?? note)(
          [
            "No web search providers are currently available under this plugin policy.",
            "Enable plugins or remove deny rules, then rerun configure.",
            "Docs: https://docs.openclaw.ai/tools/web",
          ].join("\n"),
          "Web search",
        );
      }
      if (nextSearch.openaiCodex?.enabled !== true) {
        nextSearch = {
          ...existingSearch,
          enabled: false,
        };
      }
    } else if (configureManagedProvider) {
      workingConfig = await setupSearchImpl(workingConfig, runtime, prompter);
      nextSearch = {
        ...workingConfig.tools?.web?.search,
        enabled: workingConfig.tools?.web?.search?.provider ? true : existingSearch?.enabled,
        openaiCodex: {
          ...existingSearch?.openaiCodex,
          ...(nextSearch.openaiCodex as Record<string, unknown> | undefined),
        },
      };
    }
  }

  const enableFetch = guardCancel(
    await (deps.confirm ?? confirm)({
      message: "Enable web_fetch (keyless HTTP fetch)?",
      initialValue: existingFetch?.enabled ?? true,
    }),
    runtime,
  );

  const nextFetch = {
    ...existingFetch,
    enabled: enableFetch,
  };

  return {
    ...workingConfig,
    tools: {
      ...workingConfig.tools,
      web: {
        ...workingConfig.tools?.web,
        search: nextSearch,
        fetch: nextFetch,
      },
    },
  };
}

export async function runConfigureWizard(
  opts: ConfigureWizardParams,
  runtime: RuntimeEnv = defaultRuntime,
  deps: ConfigureWizardDeps = {},
) {
  const introImpl = deps.intro ?? intro;
  const outroImpl = deps.outro ?? outro;
  const selectImpl = deps.select ?? select;
  const textImpl = deps.text ?? text;
  const noteImpl = deps.note ?? note;
  const readConfigFileSnapshotImpl = deps.readConfigFileSnapshot ?? readConfigFileSnapshot;
  const replaceConfigFileImpl = deps.replaceConfigFile ?? replaceConfigFile;
  const resolveGatewayPortImpl = deps.resolveGatewayPort ?? resolveGatewayPort;
  const logConfigUpdatedImpl = deps.logConfigUpdated ?? logConfigUpdated;
  const createClackPrompterImpl = deps.createClackPrompter ?? createClackPrompter;
  const ensureControlUiAssetsBuiltImpl =
    deps.ensureControlUiAssetsBuilt ?? ensureControlUiAssetsBuilt;
  const promptAuthConfigImpl = deps.promptAuthConfig ?? promptAuthConfig;
  const promptGatewayConfigImpl = deps.promptGatewayConfig ?? promptGatewayConfig;
  const removeChannelConfigWizardImpl = deps.removeChannelConfigWizard ?? removeChannelConfigWizard;
  const maybeInstallDaemonImpl = deps.maybeInstallDaemon ?? maybeInstallDaemon;
  const promptRemoteGatewayConfigImpl = deps.promptRemoteGatewayConfig ?? promptRemoteGatewayConfig;
  const setupSkillsImpl = deps.setupSkills ?? setupSkills;
  const setupChannelsImpl = deps.setupChannels ?? setupChannels;
  const noteChannelStatusImpl = deps.noteChannelStatus ?? noteChannelStatus;
  const applyWizardMetadataImpl = deps.applyWizardMetadata ?? applyWizardMetadata;
  const ensureWorkspaceAndSessionsImpl =
    deps.ensureWorkspaceAndSessions ?? ensureWorkspaceAndSessions;
  const probeGatewayReachableImpl = deps.probeGatewayReachable ?? probeGatewayReachable;
  const resolveControlUiLinksImpl = deps.resolveControlUiLinks ?? resolveControlUiLinks;
  const summarizeExistingConfigImpl = deps.summarizeExistingConfig ?? summarizeExistingConfig;
  try {
    introImpl(opts.command === "update" ? "OpenClaw update wizard" : "OpenClaw configure");
    const prompter = createClackPrompterImpl();

    const snapshot = await readConfigFileSnapshotImpl();
    let currentBaseHash = snapshot.hash;
    const baseConfig: OpenClawConfig = snapshot.valid
      ? (snapshot.sourceConfig ?? snapshot.config)
      : {};

    if (snapshot.exists) {
      const title = snapshot.valid ? "Existing config detected" : "Invalid config";
      noteImpl(summarizeExistingConfigImpl(baseConfig), title);
      if (!snapshot.valid && snapshot.issues.length > 0) {
        noteImpl(
          [
            ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
            "",
            "Docs: https://docs.openclaw.ai/gateway/configuration",
          ].join("\n"),
          "Config issues",
        );
      }
      if (!snapshot.valid) {
        outroImpl(
          `Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run configure.`,
        );
        runtime.exit(1);
        return;
      }
    }

    const localUrl = "ws://127.0.0.1:18789";
    const baseLocalProbeToken = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      value: baseConfig.gateway?.auth?.token,
      path: "gateway.auth.token",
    });
    const baseLocalProbePassword = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      value: baseConfig.gateway?.auth?.password,
      path: "gateway.auth.password",
    });
    const localProbe = await probeGatewayReachableImpl({
      url: localUrl,
      token: process.env.DENNOU_GATEWAY_TOKEN ?? baseLocalProbeToken,
      password: process.env.DENNOU_GATEWAY_PASSWORD ?? baseLocalProbePassword,
    });
    const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
    const baseRemoteProbeToken = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      value: baseConfig.gateway?.remote?.token,
      path: "gateway.remote.token",
    });
    const remoteProbe = remoteUrl
      ? await probeGatewayReachableImpl({
          url: remoteUrl,
          token: baseRemoteProbeToken,
        })
      : null;

    const mode = guardCancel(
      await selectImpl({
        message: "Where will the Gateway run?",
        options: [
          {
            value: "local",
            label: "Local (this machine)",
            hint: localProbe.ok
              ? `Gateway reachable (${localUrl})`
              : `No gateway detected (${localUrl})`,
          },
          {
            value: "remote",
            label: "Remote (info-only)",
            hint: !remoteUrl
              ? "No remote URL configured yet"
              : remoteProbe?.ok
                ? `Gateway reachable (${remoteUrl})`
                : `Configured but unreachable (${remoteUrl})`,
          },
        ],
      }),
      runtime,
    );

    if (mode === "remote") {
      let remoteConfig = await promptRemoteGatewayConfigImpl(baseConfig, prompter);
      remoteConfig = applyWizardMetadataImpl(remoteConfig, {
        command: opts.command,
        mode,
      });
      await replaceConfigFileImpl({
        nextConfig: remoteConfig,
        ...(currentBaseHash !== undefined ? { baseHash: currentBaseHash } : {}),
      });
      currentBaseHash = undefined;
      logConfigUpdatedImpl(runtime);
      outroImpl("Remote gateway configured.");
      return;
    }

    let nextConfig = { ...baseConfig };
    let didSetGatewayMode = false;
    if (nextConfig.gateway?.mode !== "local") {
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          mode: "local",
        },
      };
      didSetGatewayMode = true;
    }
    let workspaceDir =
      nextConfig.agents?.defaults?.workspace ??
      baseConfig.agents?.defaults?.workspace ??
      DEFAULT_WORKSPACE;
    let gatewayPort = resolveGatewayPortImpl(baseConfig);

    const persistConfig = async () => {
      nextConfig = applyWizardMetadataImpl(nextConfig, {
        command: opts.command,
        mode,
      });
      await replaceConfigFileImpl({
        nextConfig,
        ...(currentBaseHash !== undefined ? { baseHash: currentBaseHash } : {}),
      });
      currentBaseHash = undefined;
      logConfigUpdatedImpl(runtime);
    };

    const configureWorkspace = async () => {
      const workspaceInput = guardCancel(
        await textImpl({
          message: "Workspace directory",
          initialValue: workspaceDir,
        }),
        runtime,
      );
      workspaceDir = resolveUserPath(String(workspaceInput ?? "").trim() || DEFAULT_WORKSPACE);
      if (!snapshot.exists) {
        const indicators = ["MEMORY.md", "memory", ".git"].map((name) =>
          nodePath.join(workspaceDir, name),
        );
        const hasExistingContent = (
          await Promise.all(
            indicators.map(async (candidate) => {
              try {
                await fsPromises.access(candidate);
                return true;
              } catch {
                return false;
              }
            }),
          )
        ).some(Boolean);
        if (hasExistingContent) {
          noteImpl(
            [
              `Existing workspace detected at ${workspaceDir}`,
              "Existing files are preserved. Missing templates may be created, never overwritten.",
            ].join("\n"),
            "Existing workspace",
          );
        }
      }
      nextConfig = {
        ...nextConfig,
        agents: {
          ...nextConfig.agents,
          defaults: {
            ...nextConfig.agents?.defaults,
            workspace: workspaceDir,
          },
        },
      };
      await ensureWorkspaceAndSessionsImpl(workspaceDir, runtime);
    };

    const configureChannelsSection = async () => {
      await noteChannelStatusImpl({ cfg: nextConfig, prompter });
      const channelMode = await promptChannelMode(runtime, deps);
      if (channelMode === "configure") {
        nextConfig = await setupChannelsImpl(nextConfig, runtime, prompter, {
          allowDisable: true,
          allowSignalInstall: true,
          skipConfirm: true,
          skipStatusNote: true,
        });
      } else {
        nextConfig = await removeChannelConfigWizardImpl(nextConfig, runtime);
      }
    };

    const promptDaemonPort = async () => {
      const portInput = guardCancel(
        await textImpl({
          message: "Gateway port for service install",
          initialValue: String(gatewayPort),
          validate: (value) => (Number.isFinite(Number(value)) ? undefined : "Invalid port"),
        }),
        runtime,
      );
      gatewayPort = Number.parseInt(String(portInput), 10);
    };

    if (opts.sections) {
      const selected = opts.sections;
      if (!selected || selected.length === 0) {
        outroImpl("No changes selected.");
        return;
      }

      if (selected.includes("workspace")) {
        await configureWorkspace();
      }

      if (selected.includes("model")) {
        nextConfig = await promptAuthConfigImpl(nextConfig, runtime, prompter);
      }

      if (selected.includes("web")) {
        nextConfig = await promptWebToolsConfig(nextConfig, runtime, prompter, deps);
      }

      if (selected.includes("gateway")) {
        const gateway = await promptGatewayConfigImpl(nextConfig, runtime);
        nextConfig = gateway.config;
        gatewayPort = gateway.port;
      }

      if (selected.includes("channels")) {
        await configureChannelsSection();
      }

      if (selected.includes("plugins")) {
        const { configurePluginConfig } = await import("../wizard/setup.plugin-config.js");
        nextConfig = await configurePluginConfig({
          config: nextConfig,
          prompter,
          workspaceDir: resolveUserPath(workspaceDir),
        });
      }

      if (selected.includes("skills")) {
        const wsDir = resolveUserPath(workspaceDir);
        nextConfig = await setupSkillsImpl(nextConfig, wsDir, runtime, prompter);
      }

      await persistConfig();

      if (selected.includes("daemon")) {
        if (!selected.includes("gateway")) {
          await promptDaemonPort();
        }

        await maybeInstallDaemonImpl({ runtime, port: gatewayPort });
      }

      if (selected.includes("health")) {
        await runGatewayHealthCheck({
          cfg: nextConfig,
          runtime,
          port: gatewayPort,
          deps,
        });
      }
    } else {
      let ranSection = false;
      let didConfigureGateway = false;

      while (true) {
        const choice = await promptConfigureSection(runtime, ranSection, deps);
        if (choice === "__continue") {
          break;
        }
        ranSection = true;

        if (choice === "workspace") {
          await configureWorkspace();
          await persistConfig();
        }

        if (choice === "model") {
          nextConfig = await promptAuthConfigImpl(nextConfig, runtime, prompter);
          await persistConfig();
        }

        if (choice === "web") {
          nextConfig = await promptWebToolsConfig(nextConfig, runtime, prompter, deps);
          await persistConfig();
        }

        if (choice === "gateway") {
          const gateway = await promptGatewayConfigImpl(nextConfig, runtime);
          nextConfig = gateway.config;
          gatewayPort = gateway.port;
          didConfigureGateway = true;
          await persistConfig();
        }

        if (choice === "channels") {
          await configureChannelsSection();
          await persistConfig();
        }

        if (choice === "plugins") {
          const { configurePluginConfig } = await import("../wizard/setup.plugin-config.js");
          nextConfig = await configurePluginConfig({
            config: nextConfig,
            prompter,
            workspaceDir: resolveUserPath(workspaceDir),
          });
          await persistConfig();
        }

        if (choice === "skills") {
          const wsDir = resolveUserPath(workspaceDir);
          nextConfig = await setupSkillsImpl(nextConfig, wsDir, runtime, prompter);
          await persistConfig();
        }

        if (choice === "daemon") {
          if (!didConfigureGateway) {
            await promptDaemonPort();
          }
          await maybeInstallDaemonImpl({
            runtime,
            port: gatewayPort,
          });
        }

        if (choice === "health") {
          await runGatewayHealthCheck({
            cfg: nextConfig,
            runtime,
            port: gatewayPort,
            deps,
          });
        }
      }

      if (!ranSection) {
        if (didSetGatewayMode) {
          await persistConfig();
          outroImpl("Gateway mode set to local.");
          return;
        }
        outroImpl("No changes selected.");
        return;
      }
    }

    const controlUiAssets = await ensureControlUiAssetsBuiltImpl(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
    }

    const bind = nextConfig.gateway?.bind ?? "loopback";
    const links = resolveControlUiLinksImpl({
      bind,
      port: gatewayPort,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: nextConfig.gateway?.controlUi?.basePath,
    });
    const newPassword =
      process.env.DENNOU_GATEWAY_PASSWORD ??
      (await resolveGatewaySecretInputForWizard({
        cfg: nextConfig,
        value: nextConfig.gateway?.auth?.password,
        path: "gateway.auth.password",
      }));
    const oldPassword =
      process.env.DENNOU_GATEWAY_PASSWORD ??
      (await resolveGatewaySecretInputForWizard({
        cfg: baseConfig,
        value: baseConfig.gateway?.auth?.password,
        path: "gateway.auth.password",
      }));
    const token =
      process.env.DENNOU_GATEWAY_TOKEN ??
      (await resolveGatewaySecretInputForWizard({
        cfg: nextConfig,
        value: nextConfig.gateway?.auth?.token,
        path: "gateway.auth.token",
      }));

    let gatewayProbe = await probeGatewayReachableImpl({
      url: links.wsUrl,
      token,
      password: newPassword,
    });
    if (!gatewayProbe.ok && newPassword !== oldPassword && oldPassword) {
      gatewayProbe = await probeGatewayReachableImpl({
        url: links.wsUrl,
        token,
        password: oldPassword,
      });
    }
    const gatewayStatusLine = gatewayProbe.ok
      ? "Gateway: reachable"
      : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;

    noteImpl(
      [
        `Web UI: ${links.httpUrl}`,
        `Gateway WS: ${links.wsUrl}`,
        gatewayStatusLine,
        "Docs: https://docs.openclaw.ai/web/control-ui",
      ].join("\n"),
      "Control UI",
    );

    outroImpl("Configure complete.");
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}

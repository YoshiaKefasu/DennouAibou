import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ConfigFileSnapshot } from "../config/config.js";
import { readConfigFileSnapshot, replaceConfigFile, resolveGatewayPort } from "../config/config.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import { note } from "../terminal/note.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { runConfigureWizard, type ConfigureWizardDeps } from "./configure.wizard.js";
import {
  probeGatewayReachable,
  resolveControlUiLinks,
  summarizeExistingConfig,
  waitForGatewayReachable,
} from "./onboard-helpers.js";
import { resolveSearchProviderOptions, setupSearch } from "./onboard-search.js";

const writeConfigFile = vi.fn();
const emptyWriteSnapshot: ConfigFileSnapshot = {
  path: "",
  exists: true,
  raw: null,
  parsed: {},
  sourceConfig: {},
  resolved: {},
  valid: true,
  runtimeConfig: {},
  config: {},
  issues: [],
  warnings: [],
  legacyIssues: [],
};
const mocks = {
  clackIntro: vi.fn(),
  clackOutro: vi.fn(),
  clackSelect: vi.fn(),
  clackText: vi.fn(),
  clackConfirm: vi.fn(),
  resolveSearchProviderOptions: vi.fn(),
  setupSearch: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile,
  replaceConfigFile: vi.fn<typeof replaceConfigFile>(async (params) => {
    await writeConfigFile(params.nextConfig);
    return {
      path: emptyWriteSnapshot.path,
      previousHash: null,
      snapshot: emptyWriteSnapshot,
      nextConfig: params.nextConfig as OpenClawConfig,
    };
  }),
  resolveGatewayPort: vi.fn(),
  ensureControlUiAssetsBuilt: vi.fn(),
  createClackPrompter: vi.fn(),
  note: vi.fn(),
  printWizardHeader: vi.fn(),
  probeGatewayReachable: vi.fn(),
  waitForGatewayReachable: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  summarizeExistingConfig: vi.fn(),
};

const configureDeps: ConfigureWizardDeps = {
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  replaceConfigFile: mocks.replaceConfigFile,
  resolveGatewayPort: mocks.resolveGatewayPort,
  ensureControlUiAssetsBuilt: mocks.ensureControlUiAssetsBuilt,
  createClackPrompter: mocks.createClackPrompter,
  note: mocks.note,
  probeGatewayReachable: mocks.probeGatewayReachable,
  resolveControlUiLinks: mocks.resolveControlUiLinks,
  summarizeExistingConfig: mocks.summarizeExistingConfig,
  waitForGatewayReachable: mocks.waitForGatewayReachable,
  resolveSearchProviderOptions: mocks.resolveSearchProviderOptions,
  setupSearch: mocks.setupSearch,
};

import { WizardCancelledError } from "../wizard/prompts.js";

const EMPTY_CONFIG_SNAPSHOT = {
  exists: false,
  valid: true,
  config: {},
  issues: [],
};

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function createSearchProviderOption(overrides: Record<string, unknown>) {
  return overrides;
}

function createEnabledWebSearchConfig(provider: string, pluginEntry: Record<string, unknown>) {
  return (cfg: OpenClawConfig) => ({
    ...cfg,
    tools: {
      ...cfg.tools,
      web: {
        ...cfg.tools?.web,
        search: {
          provider,
          enabled: true,
        },
      },
    },
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [provider]: pluginEntry,
      },
    },
  });
}

function setupBaseWizardState(config: OpenClawConfig = {}) {
  mocks.readConfigFileSnapshot.mockResolvedValue({
    ...EMPTY_CONFIG_SNAPSHOT,
    config,
  });
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
  mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
  mocks.summarizeExistingConfig.mockReturnValue("");
  mocks.createClackPrompter.mockReturnValue({
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => "firecrawl"),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  });
}

function queueWizardPrompts(params: { select: string[]; confirm: boolean[]; text?: string }) {
  const selectQueue = [...params.select];
  const confirmQueue = [...params.confirm];
  mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
  mocks.clackConfirm.mockImplementation(async () => confirmQueue.shift());
  mocks.clackText.mockResolvedValue(params.text ?? "");
  mocks.clackIntro.mockResolvedValue(undefined);
  mocks.clackOutro.mockResolvedValue(undefined);
}

function getConfigureDeps(): ConfigureWizardDeps {
  return {
    ...configureDeps,
    intro: mocks.clackIntro,
    outro: mocks.clackOutro,
    select: mocks.clackSelect,
    text: mocks.clackText,
    confirm: mocks.clackConfirm,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    replaceConfigFile: mocks.replaceConfigFile,
    resolveGatewayPort: mocks.resolveGatewayPort,
    ensureControlUiAssetsBuilt: mocks.ensureControlUiAssetsBuilt,
    createClackPrompter: mocks.createClackPrompter,
    note: mocks.note,
    probeGatewayReachable: mocks.probeGatewayReachable,
    resolveControlUiLinks: mocks.resolveControlUiLinks,
    summarizeExistingConfig: mocks.summarizeExistingConfig,
    waitForGatewayReachable: mocks.waitForGatewayReachable,
    resolveSearchProviderOptions: mocks.resolveSearchProviderOptions,
    setupSearch: mocks.setupSearch,
  };
}

async function runWebConfigureWizard() {
  await runConfigureWizard(
    { command: "configure", sections: ["web"] },
    createRuntime(),
    getConfigureDeps(),
  );
}

describe("runConfigureWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.resolveSearchProviderOptions.mockReturnValue([
      {
        id: "firecrawl",
        label: "Firecrawl Search",
        hint: "Structured results with optional result scraping",
        credentialLabel: "Firecrawl API key",
        envVars: ["FIRECRAWL_API_KEY"],
        placeholder: "fc-...",
        signupUrl: "https://www.firecrawl.dev/",
        credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
      },
    ]);
    mocks.setupSearch.mockReset();
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) => cfg);
  });

  it("persists gateway.mode=local when only the run mode is selected", async () => {
    setupBaseWizardState();
    queueWizardPrompts({
      select: ["local", "__continue"],
      confirm: [false],
    });

    await runConfigureWizard({ command: "configure" }, createRuntime(), getConfigureDeps());

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({ mode: "local" }),
      }),
    );
  });

  it("exits with code 1 when configure wizard is cancelled", async () => {
    const runtime = createRuntime();
    setupBaseWizardState();
    mocks.clackSelect.mockRejectedValueOnce(new WizardCancelledError());

    await runConfigureWizard({ command: "configure" }, runtime, getConfigureDeps());

    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("persists provider-owned web search config changes returned by setupSearch", async () => {
    setupBaseWizardState();
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) =>
      createEnabledWebSearchConfig("firecrawl", {
        enabled: true,
        config: { webSearch: { apiKey: "fc-entered-key" } },
      })(cfg),
    );
    queueWizardPrompts({
      select: ["local"],
      confirm: [true, false],
    });

    await runWebConfigureWizard();

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          web: expect.objectContaining({
            search: expect.objectContaining({
              provider: "firecrawl",
              enabled: true,
            }),
          }),
        }),
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            firecrawl: expect.objectContaining({
              enabled: true,
              config: expect.objectContaining({
                webSearch: expect.objectContaining({ apiKey: "fc-entered-key" }),
              }),
            }),
          }),
        }),
      }),
    );
    expect(mocks.setupSearch).toHaveBeenCalledOnce();
  });

  it("delegates provider selection to the shared search setup flow", async () => {
    setupBaseWizardState();
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) =>
      createEnabledWebSearchConfig("firecrawl", {
        enabled: true,
      })(cfg),
    );
    queueWizardPrompts({
      select: ["local"],
      confirm: [true, false],
    });

    await runWebConfigureWizard();

    expect(mocks.setupSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({ mode: "local" }),
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            firecrawl: expect.objectContaining({
              enabled: true,
            }),
          }),
        }),
      }),
    );
  });

  it("does not crash when web search providers are unavailable under plugin policy", async () => {
    setupBaseWizardState();
    mocks.resolveSearchProviderOptions.mockReturnValue([]);
    queueWizardPrompts({
      select: ["local"],
      confirm: [true, false],
    });

    await expect(runWebConfigureWizard()).resolves.toBeUndefined();

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "No web search providers are currently available under this plugin policy.",
      ),
      "Web search",
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          web: expect.objectContaining({
            search: expect.objectContaining({
              enabled: false,
            }),
          }),
        }),
      }),
    );
  });

  it("still supports keyless web search providers through the shared setup flow", async () => {
    setupBaseWizardState();
    mocks.resolveSearchProviderOptions.mockReturnValue([
      createSearchProviderOption({
        id: "duckduckgo",
        label: "DuckDuckGo Search (experimental)",
        hint: "Free fallback",
        requiresCredential: false,
        envVars: [],
        placeholder: "(no key needed)",
        signupUrl: "https://duckduckgo.com/",
        docsUrl: "https://docs.openclaw.ai/tools/web",
        credentialPath: "",
      }),
    ]);
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) =>
      createEnabledWebSearchConfig("duckduckgo", {
        enabled: true,
      })(cfg),
    );
    queueWizardPrompts({
      select: ["local"],
      confirm: [true, false],
    });

    await runWebConfigureWizard();

    expect(mocks.clackText).not.toHaveBeenCalled();
    expect(mocks.setupSearch).toHaveBeenCalledOnce();
  });

  it("preserves disabled native Codex search config", async () => {
    setupBaseWizardState({
      auth: {
        profiles: {
          "openai-codex:default": {
            provider: "openai-codex",
            mode: "oauth",
          },
        },
      },
      tools: {
        web: {
          search: {
            enabled: true,
            openaiCodex: {
              enabled: false,
              mode: "live",
            },
          },
        },
      },
    });
    queueWizardPrompts({
      select: ["firecrawl"],
      confirm: [true, false, true, false],
    });

    await runWebConfigureWizard();

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          web: expect.objectContaining({
            search: expect.objectContaining({
              enabled: true,
              openaiCodex: expect.objectContaining({
                enabled: false,
                mode: "live",
              }),
            }),
          }),
        }),
      }),
    );
    expect(mocks.setupSearch).toHaveBeenCalledOnce();
  });
});

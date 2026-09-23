import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Mock } from "vitest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChannelStatusIssue } from "../channels/plugins/types.js";
import { buildGatewayConnectionDetailsWithResolvers } from "../gateway/connection-details.js";
import type { OsSummary } from "../infra/os-summary.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import { createCompatibilityNotice } from "../plugins/status.test-helpers.js";
import type { RuntimeEnv } from "../runtime.js";
import * as taskMaintenanceModule from "../tasks/task-registry.maintenance.js";
import { captureEnv } from "../test-utils/env.js";
import { pickGatewaySelfPresence } from "./gateway-presence.js";
import type { ChannelRow } from "./status-all/channels.js";
import type { StatusCommandDeps } from "./status.command.js";
import { formatDaemonRuntimeShort } from "./status.format.js";
import { resolveGatewayProbeAuthResolution } from "./status.gateway-probe.js";
import { statusCommand } from "./status.js";
import type { StatusScanResult } from "./status.scan.js";
import { buildTailscaleHttpsUrl, resolveMemoryPluginStatus } from "./status.scan.shared.js";
import { readServiceStatusSummary } from "./status.service-summary.js";
import { getStatusSummary, type StatusSummaryDeps } from "./status.summary.js";

let envSnapshot: ReturnType<typeof captureEnv>;
let stateDir: string;
let stdoutColumnsDescriptor: PropertyDescriptor | undefined;

// `getTerminalTableWidth()` falls back to 120 columns when stdout is piped,
// which wraps the verbose Sessions `Cache` cell between "write" and "1.0k" so
// no single line contains the whole detail. Pin a deterministic width that
// keeps each cache detail on one line.
const TEST_TABLE_WIDTH = 160;

beforeAll(() => {
  envSnapshot = captureEnv(["DENNOU_PROFILE", "DENNOU_STATE_DIR"]);
  process.env.DENNOU_PROFILE = "isolated";
  // Keep every state-dir lookup (config probe, system-event queue, node host
  // config) inside a throwaway directory so the suite never reads the real
  // ~/.dennou-aibou workspace.
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "denno-status-test-"));
  process.env.DENNOU_STATE_DIR = stateDir;
  stdoutColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    writable: true,
    value: TEST_TABLE_WIDTH,
  });
});

afterAll(() => {
  if (stdoutColumnsDescriptor) {
    Object.defineProperty(process.stdout, "columns", stdoutColumnsDescriptor);
  } else {
    Reflect.deleteProperty(process.stdout, "columns");
  }
  envSnapshot.restore();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function createDefaultSessionStoreEntry() {
  return {
    updatedAt: Date.now() - 60_000,
    verboseLevel: "on",
    thinkingLevel: "low",
    inputTokens: 2_000,
    outputTokens: 3_000,
    cacheRead: 2_000,
    cacheWrite: 1_000,
    totalTokens: 5_000,
    contextTokens: 10_000,
    model: "pi:opus",
    sessionId: "abc123",
    systemSent: true,
  };
}

function createUnknownUsageSessionStore() {
  return {
    "+1000": {
      updatedAt: Date.now() - 60_000,
      inputTokens: 2_000,
      outputTokens: 3_000,
      contextTokens: 10_000,
      model: "pi:opus",
    },
  };
}

type TestChannelPlugin = {
  id: string;
  meta: { label: string };
  status: {
    collectStatusIssues?: (accounts: Array<Record<string, unknown>>) => ChannelStatusIssue[];
  };
};

function createChannelIssueCollector(channel: string) {
  return (accounts: Array<Record<string, unknown>>): ChannelStatusIssue[] =>
    accounts
      .filter((account) => typeof account.lastError === "string" && account.lastError)
      .map((account) => ({
        channel,
        accountId: typeof account.accountId === "string" ? account.accountId : "default",
        kind: "runtime" as const,
        message: `Channel error: ${String(account.lastError)}`,
      }));
}

function createErrorChannelPlugin(params: { id: string; label: string }): TestChannelPlugin {
  return {
    id: params.id,
    meta: { label: params.label },
    status: {
      collectStatusIssues: createChannelIssueCollector(params.id),
    },
  };
}

// Stand-in for `listChannelPlugins()` inside the synthesized scan: `status`
// only reads `meta.label` (channels table) and `collectStatusIssues`
// (gateway-reported channel errors).
const channelPlugins: TestChannelPlugin[] = [
  { id: "whatsapp", meta: { label: "WhatsApp" }, status: {} },
  createErrorChannelPlugin({ id: "signal", label: "Signal" }),
  createErrorChannelPlugin({ id: "imessage", label: "iMessage" }),
];

function createChannelRows(): ChannelRow[] {
  return channelPlugins.map((plugin) => ({
    id: plugin.id,
    label: plugin.meta.label,
    enabled: true,
    state: "ok",
    detail: "configured",
  }));
}

function collectTestChannelIssues(payload: ChannelsStatusPayload | null): ChannelStatusIssue[] {
  if (!payload) {
    return [];
  }
  const issues: ChannelStatusIssue[] = [];
  for (const plugin of channelPlugins) {
    const collect = plugin.status.collectStatusIssues;
    const accounts = payload.channelAccounts?.[plugin.id];
    if (!collect || !Array.isArray(accounts)) {
      continue;
    }
    issues.push(...collect(accounts));
  }
  return issues;
}

async function withUnknownUsageStore(run: () => Promise<void>) {
  const originalLoadSessionStore = mocks.loadSessionStore.getMockImplementation();
  mocks.loadSessionStore.mockReturnValue(createUnknownUsageSessionStore());
  try {
    await run();
  } finally {
    if (originalLoadSessionStore) {
      mocks.loadSessionStore.mockImplementation(originalLoadSessionStore);
    }
  }
}

function getRuntimeLogs() {
  return runtimeLogMock.mock.calls.map((call: unknown[]) => String(call[0]));
}

function getJoinedRuntimeLogs() {
  return getRuntimeLogs().join("\n");
}

async function runStatusAndGetLogs(args: Parameters<typeof statusCommand>[0] = {}) {
  runtimeLogMock.mockClear();
  await statusCommand(args, runtime as never, statusCommandDeps);
  return getRuntimeLogs();
}

async function runStatusAndGetJoinedLogs(args: Parameters<typeof statusCommand>[0] = {}) {
  await runStatusAndGetLogs(args);
  return getJoinedRuntimeLogs();
}

type ProbeGatewayResult = {
  ok: boolean;
  url: string;
  connectLatencyMs: number | null;
  error: string | null;
  close: { code: number; reason: string } | null;
  health: unknown;
  status: unknown;
  presence: unknown;
  configSnapshot: unknown;
};

function mockProbeGatewayResult(overrides: Partial<ProbeGatewayResult>) {
  mocks.probeGateway.mockReset();
  mocks.probeGateway.mockResolvedValue({
    ...createDefaultProbeGatewayResult(),
    ...overrides,
  });
}

function createDefaultProbeGatewayResult(): ProbeGatewayResult {
  return {
    ok: false,
    url: "ws://127.0.0.1:18789",
    connectLatencyMs: null,
    error: "timeout",
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  };
}

function createDefaultSecurityAuditResult() {
  return {
    ts: 0,
    summary: { critical: 1, warn: 1, info: 2 },
    findings: [
      {
        checkId: "test.critical",
        severity: "critical",
        title: "Test critical finding",
        detail: "Something is very wrong\nbut on two lines",
        remediation: "Do the thing",
      },
      {
        checkId: "test.warn",
        severity: "warn",
        title: "Test warning finding",
        detail: "Something is maybe wrong",
      },
      {
        checkId: "test.info",
        severity: "info",
        title: "Test info finding",
        detail: "FYI only",
      },
      {
        checkId: "test.info2",
        severity: "info",
        title: "Another info finding",
        detail: "More FYI",
      },
    ],
  };
}

async function withEnvVar<T>(key: string, value: string, run: () => Promise<T>): Promise<T> {
  const prevValue = process.env[key];
  process.env[key] = value;
  try {
    return await run();
  } finally {
    if (prevValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prevValue;
    }
  }
}

// The node-only gateway branch reads `<stateDir>/node.json` through the real
// `resolveNodeOnlyGatewayInfo`, so the fixture is written to disk instead of
// stubbing the module.
async function withNodeHostConfig(
  config: { version: number; nodeId: string; gateway?: { host?: string; port?: number } },
  run: () => Promise<void>,
): Promise<void> {
  const filePath = path.join(stateDir, "node.json");
  fs.writeFileSync(filePath, JSON.stringify(config));
  try {
    await run();
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

type ChannelsStatusPayload = {
  channelAccounts?: Record<string, Array<Record<string, unknown>>>;
};

const mocks = {
  hasPotentialConfiguredChannels: vi.fn(() => true),
  loadConfig: vi.fn().mockReturnValue({ session: {} }),
  loadSessionStore: vi.fn().mockReturnValue({
    "+1000": createDefaultSessionStoreEntry(),
  }),
  resolveMainSessionKey: vi.fn().mockReturnValue("agent:main:main"),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/sessions.json"),
  listGatewayAgentsBasic: vi.fn().mockReturnValue({
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "per-sender",
    agents: [{ id: "main", name: "Main" }],
  }),
  probeGateway: vi.fn().mockResolvedValue({
    ...createDefaultProbeGatewayResult(),
  }),
  runSecurityAudit: vi.fn().mockResolvedValue(createDefaultSecurityAuditResult()),
  buildPluginCompatibilityNotices: vi.fn(
    (_params?: { config?: unknown }): PluginCompatibilityNotice[] => [],
  ),
  getInspectableTaskRegistrySummary: vi.fn().mockReturnValue({
    total: 0,
    active: 0,
    terminal: 0,
    failures: 0,
    byStatus: {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      cancelled: 0,
      lost: 0,
    },
    byRuntime: {
      subagent: 0,
      acp: 0,
      cli: 0,
      cron: 0,
    },
  }),
  getInspectableTaskAuditSummary: vi.fn().mockReturnValue({
    total: 0,
    warnings: 0,
    errors: 0,
    byCode: {
      stale_queued: 0,
      stale_running: 0,
      lost: 0,
      delivery_failed: 0,
      missing_cleanup: 0,
      inconsistent_timestamps: 0,
    },
  }),
  resolveGatewayService: vi.fn().mockReturnValue({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: async () => {},
    install: async () => {},
    uninstall: async () => {},
    stop: async () => {},
    restart: async () => ({ outcome: "completed" as const }),
    isLoaded: async () => true,
    readRuntime: async () => ({ status: "running", pid: 1234 }),
    readCommand: async () => ({
      programArguments: ["node", "dist/entry.js", "gateway"],
      sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.gateway.plist",
    }),
  }),
  resolveNodeService: vi.fn().mockReturnValue({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: async () => {},
    install: async () => {},
    uninstall: async () => {},
    stop: async () => {},
    restart: async () => ({ outcome: "completed" as const }),
    isLoaded: async () => true,
    readRuntime: async () => ({ status: "running", pid: 4321 }),
    readCommand: async () => ({
      programArguments: ["node", "dist/entry.js", "node-host"],
      sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.node.plist",
    }),
  }),
  channelsStatus: null as ChannelsStatusPayload | null,
};

const osSummary: OsSummary = {
  platform: "darwin",
  arch: "arm64",
  release: "23.0.0",
  label: "macos 14.0 (arm64)",
};

function createSummaryDeps(): StatusSummaryDeps {
  return {
    loadConfig: mocks.loadConfig,
    hasPotentialConfiguredChannels: mocks.hasPotentialConfiguredChannels,
    // Channel discovery stays out of this suite: `linkChannel`/`channelSummary`
    // are not part of any assertion below.
    resolveLinkChannelContext: async () => null,
    buildChannelSummary: async () => [],
    listGatewayAgentsBasic: mocks.listGatewayAgentsBasic,
    resolveMainSessionKey: mocks.resolveMainSessionKey,
    readSessionStoreReadOnly: mocks.loadSessionStore,
    resolveStorePath: mocks.resolveStorePath,
    taskMaintenanceModule: {
      ...taskMaintenanceModule,
      getInspectableTaskRegistrySummary: mocks.getInspectableTaskRegistrySummary,
      getInspectableTaskAuditSummary: mocks.getInspectableTaskAuditSummary,
    },
  };
}

// Note: `getAgentLocalStatuses` has no injection seam, and its result feeds no
// assertion in this file (only the "bootstrap files"/"sessions N" cells), so
// the scan fixture reports the deterministic empty shape instead of reaching
// into the real per-agent workspace probes.
const agentStatus: StatusScanResult["agentStatus"] = {
  defaultId: "main",
  agents: [],
  totalSessions: 0,
  bootstrapPendingCount: 0,
};

async function buildScanResult(params: { json: boolean }): Promise<StatusScanResult> {
  const cfg = mocks.loadConfig();
  const sourceConfig = cfg;
  const isRemoteMode = cfg.gateway?.mode === "remote";
  const remoteUrlRaw = typeof cfg.gateway?.remote?.url === "string" ? cfg.gateway.remote.url : "";
  const remoteUrlMissing = isRemoteMode && !remoteUrlRaw.trim();
  const gatewayMode: "local" | "remote" = isRemoteMode ? "remote" : "local";
  const tailscaleMode: string = cfg.gateway?.tailscale?.mode ?? "off";
  const tailscaleDns = null;
  const tailscaleHttpsUrl = buildTailscaleHttpsUrl({
    tailscaleMode,
    tailscaleDns,
    controlUiBasePath: cfg.gateway?.controlUi?.basePath,
  });

  // Real auth resolution (SecretRef + env fallback); only the network probe is
  // supplied by the fixture, mirroring `resolveGatewayProbeSnapshot`.
  const authResolution = await resolveGatewayProbeAuthResolution(cfg);
  let gatewayProbeAuthWarning = authResolution.warning;
  const gatewayProbe = (await mocks.probeGateway()) ?? null;
  if (gatewayProbeAuthWarning && gatewayProbe?.ok === false) {
    gatewayProbe.error = gatewayProbe.error
      ? `${gatewayProbe.error}; ${gatewayProbeAuthWarning}`
      : gatewayProbeAuthWarning;
    gatewayProbeAuthWarning = undefined;
  }
  const gatewayReachable = gatewayProbe?.ok === true;

  const summary = await getStatusSummary({ config: cfg }, createSummaryDeps());

  return {
    cfg,
    sourceConfig,
    // `status --json` never resolves command secrets in this suite (the
    // isolated profile has no config file), matching the pre-DI behaviour.
    secretDiagnostics: [],
    osSummary,
    tailscaleMode,
    tailscaleDns,
    tailscaleHttpsUrl,
    gatewayConnection: buildGatewayConnectionDetailsWithResolvers({ config: cfg }),
    remoteUrlMissing,
    gatewayMode,
    gatewayProbeAuth: authResolution.auth,
    gatewayProbeAuthWarning,
    gatewayProbe,
    gatewayReachable,
    gatewaySelf: gatewayProbe?.presence ? pickGatewaySelfPresence(gatewayProbe.presence) : null,
    channelIssues:
      params.json || !gatewayReachable ? [] : collectTestChannelIssues(mocks.channelsStatus),
    agentStatus,
    channels: params.json ? { rows: [], details: [] } : { rows: createChannelRows(), details: [] },
    summary,
    memory: null,
    memoryPlugin: resolveMemoryPluginStatus(cfg),
    pluginCompatibility: params.json ? [] : mocks.buildPluginCompatibilityNotices({ config: cfg }),
  };
}

async function fakeScanStatus(
  opts: { json?: boolean; timeoutMs?: number; all?: boolean },
  _runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  return await buildScanResult({ json: opts.json === true });
}

async function fakeScanStatusJsonFast(
  opts: { timeoutMs?: number; all?: boolean },
  _runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  return await buildScanResult({ json: true });
}

async function buildDaemonStatusSummary(
  service: Parameters<typeof readServiceStatusSummary>[0],
  fallbackLabel: string,
) {
  const summary = await readServiceStatusSummary(service, fallbackLabel);
  return {
    label: summary.label,
    installed: summary.installed,
    loaded: summary.loaded,
    managedByOpenClaw: summary.managedByOpenClaw,
    externallyManaged: summary.externallyManaged,
    loadedText: summary.loadedText,
    runtimeShort: formatDaemonRuntimeShort(summary.runtime),
  };
}

const statusCommandDeps: StatusCommandDeps = {
  scanStatus: fakeScanStatus,
  scanStatusJsonFast: fakeScanStatusJsonFast,
  runSecurityAudit: mocks.runSecurityAudit,
  getDaemonStatusSummary: async () =>
    await buildDaemonStatusSummary(mocks.resolveGatewayService(), "Daemon"),
  getNodeDaemonStatusSummary: async () =>
    await buildDaemonStatusSummary(mocks.resolveNodeService(), "Node"),
};

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const runtimeLogMock = runtime.log as Mock<(...args: unknown[]) => void>;

describe("statusCommand", () => {
  afterEach(() => {
    mocks.hasPotentialConfiguredChannels.mockReset();
    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue({ session: {} });
    mocks.loadSessionStore.mockReset();
    mocks.loadSessionStore.mockReturnValue({
      "+1000": createDefaultSessionStoreEntry(),
    });
    mocks.resolveMainSessionKey.mockReset();
    mocks.resolveMainSessionKey.mockReturnValue("agent:main:main");
    mocks.resolveStorePath.mockReset();
    mocks.resolveStorePath.mockReturnValue("/tmp/sessions.json");
    mocks.probeGateway.mockReset();
    mocks.probeGateway.mockResolvedValue(createDefaultProbeGatewayResult());
    mocks.listGatewayAgentsBasic.mockReset();
    mocks.listGatewayAgentsBasic.mockReturnValue({
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "per-sender",
      agents: [{ id: "main", name: "Main" }],
    });
    mocks.buildPluginCompatibilityNotices.mockReset();
    mocks.buildPluginCompatibilityNotices.mockReturnValue([]);
    mocks.getInspectableTaskRegistrySummary.mockReset();
    mocks.getInspectableTaskRegistrySummary.mockReturnValue({
      total: 0,
      active: 0,
      terminal: 0,
      failures: 0,
      byStatus: {
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        lost: 0,
      },
      byRuntime: {
        subagent: 0,
        acp: 0,
        cli: 0,
        cron: 0,
      },
    });
    mocks.getInspectableTaskAuditSummary.mockReset();
    mocks.getInspectableTaskAuditSummary.mockReturnValue({
      total: 0,
      warnings: 0,
      errors: 0,
      byCode: {
        stale_queued: 0,
        stale_running: 0,
        lost: 0,
        delivery_failed: 0,
        missing_cleanup: 0,
        inconsistent_timestamps: 0,
      },
    });
    mocks.hasPotentialConfiguredChannels.mockReset();
    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);
    mocks.runSecurityAudit.mockReset();
    mocks.runSecurityAudit.mockResolvedValue(createDefaultSecurityAuditResult());
    mocks.resolveGatewayService.mockReset();
    mocks.resolveGatewayService.mockReturnValue({
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      stage: async () => {},
      install: async () => {},
      uninstall: async () => {},
      stop: async () => {},
      restart: async () => ({ outcome: "completed" as const }),
      isLoaded: async () => true,
      readRuntime: async () => ({ status: "running", pid: 1234 }),
      readCommand: async () => ({
        programArguments: ["node", "dist/entry.js", "gateway"],
        sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.gateway.plist",
      }),
    });
    mocks.resolveNodeService.mockReset();
    mocks.resolveNodeService.mockReturnValue({
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      stage: async () => {},
      install: async () => {},
      uninstall: async () => {},
      stop: async () => {},
      restart: async () => ({ outcome: "completed" as const }),
      isLoaded: async () => true,
      readRuntime: async () => ({ status: "running", pid: 4321 }),
      readCommand: async () => ({
        programArguments: ["node", "dist/entry.js", "node-host"],
        sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.node.plist",
      }),
    });
    mocks.channelsStatus = null;
    runtimeLogMock.mockClear();
    (runtime.error as Mock<(...args: unknown[]) => void>).mockClear();
  });

  it("prints JSON when requested", async () => {
    mocks.hasPotentialConfiguredChannels.mockReturnValue(false);
    mocks.buildPluginCompatibilityNotices.mockReturnValue([
      createCompatibilityNotice({ pluginId: "legacy-plugin", code: "legacy-before-agent-start" }),
    ]);
    await statusCommand({ json: true }, runtime as never, statusCommandDeps);
    const payload = JSON.parse(String(runtimeLogMock.mock.calls[0]?.[0]));
    expect(payload.linkChannel).toBeUndefined();
    expect(payload.memory).toBeNull();
    expect(payload.memoryPlugin.enabled).toBe(true);
    expect(payload.memoryPlugin.slot).toBe("memory-core");
    expect(payload.sessions.count).toBe(1);
    expect(payload.sessions.paths).toContain("/tmp/sessions.json");
    expect(payload.sessions.defaults.model).toBeTruthy();
    expect(payload.sessions.defaults.contextTokens).toBeGreaterThan(0);
    expect(payload.sessions.recent[0].percentUsed).toBe(50);
    expect(payload.sessions.recent[0].cacheRead).toBe(2_000);
    expect(payload.sessions.recent[0].cacheWrite).toBe(1_000);
    expect(payload.sessions.recent[0].totalTokensFresh).toBe(true);
    expect(payload.sessions.recent[0].remainingTokens).toBe(5000);
    expect(payload.sessions.recent[0].flags).toContain("verbose:on");
    expect(payload.securityAudit.summary.critical).toBe(1);
    expect(payload.securityAudit.summary.warn).toBe(1);
    expect(payload.gatewayService.label).toBe("LaunchAgent");
    expect(payload.nodeService.label).toBe("LaunchAgent");
    expect(payload.pluginCompatibility).toEqual({
      count: 0,
      warnings: [],
    });
    expect(payload.tasks).toEqual(
      expect.objectContaining({
        total: 0,
        active: 0,
        byStatus: expect.objectContaining({ queued: 0, running: 0 }),
      }),
    );
    expect(mocks.runSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        includeFilesystem: true,
        includeChannelSecurity: true,
      }),
    );
  });

  it("surfaces unknown usage when totalTokens is missing", async () => {
    await withUnknownUsageStore(async () => {
      runtimeLogMock.mockClear();
      await statusCommand({ json: true }, runtime as never, statusCommandDeps);
      const payload = JSON.parse(String(runtimeLogMock.mock.calls.at(-1)?.[0]));
      expect(payload.sessions.recent[0].totalTokens).toBeNull();
      expect(payload.sessions.recent[0].totalTokensFresh).toBe(false);
      expect(payload.sessions.recent[0].percentUsed).toBeNull();
      expect(payload.sessions.recent[0].remainingTokens).toBeNull();
    });
  });

  it("prints unknown usage in formatted output when totalTokens is missing", async () => {
    await withUnknownUsageStore(async () => {
      const logs = await runStatusAndGetLogs();
      expect(logs.some((line) => line.includes("unknown/") && line.includes("(?%)"))).toBe(true);
    });
  });

  it("prints formatted lines otherwise", async () => {
    mocks.buildPluginCompatibilityNotices.mockReturnValue([
      createCompatibilityNotice({ pluginId: "legacy-plugin", code: "legacy-before-agent-start" }),
    ]);
    const logs = await runStatusAndGetLogs();
    for (const token of [
      "OpenClaw status",
      "Overview",
      "Security audit",
      "Summary:",
      "CRITICAL",
      "Dashboard",
      "macos 14.0 (arm64)",
      "Memory",
      "Plugin compatibility",
      "Channels",
      "WhatsApp",
      "bootstrap files",
      "Tasks",
      "Sessions",
      "+1000",
      "50%",
      "40% cached",
      "LaunchAgent",
      "FAQ:",
      "Troubleshooting:",
      "Next steps:",
    ]) {
      expect(logs.some((line) => line.includes(token))).toBe(true);
    }
    expect(
      logs.some((line) => line.includes("legacy-plugin still uses legacy before_agent_start")),
    ).toBe(true);
    expect(
      logs.some(
        (line) =>
          line.includes("openclaw status --all") ||
          line.includes("openclaw --profile isolated status --all"),
      ),
    ).toBe(true);
  });

  it("shows explicit cache details in verbose session output", async () => {
    const logs = await runStatusAndGetLogs({ verbose: true });
    expect(logs.some((line) => line.includes("Cache"))).toBe(true);
    expect(logs.some((line) => line.includes("40% hit"))).toBe(true);
    expect(logs.some((line) => line.includes("read 2.0k"))).toBe(true);
    expect(logs.some((line) => line.includes("write 1.0k"))).toBe(true);
  });

  it("shows a maintenance hint when task audit errors are present", async () => {
    mocks.getInspectableTaskRegistrySummary.mockReturnValue({
      total: 1,
      active: 1,
      terminal: 0,
      failures: 1,
      byStatus: {
        queued: 0,
        running: 1,
        succeeded: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        lost: 0,
      },
      byRuntime: {
        subagent: 0,
        acp: 1,
        cli: 0,
        cron: 0,
      },
    });
    mocks.getInspectableTaskAuditSummary.mockReturnValue({
      total: 1,
      warnings: 0,
      errors: 1,
      byCode: {
        stale_queued: 0,
        stale_running: 1,
        lost: 0,
        delivery_failed: 0,
        missing_cleanup: 0,
        inconsistent_timestamps: 0,
      },
    });

    const joined = await runStatusAndGetJoinedLogs();

    expect(joined).toContain("tasks maintenance --apply");
  });

  it("caps cached percentage at the prompt-token denominator for legacy session totals", async () => {
    const originalLoadSessionStore = mocks.loadSessionStore.getMockImplementation();
    mocks.loadSessionStore.mockReturnValue({
      "+1000": {
        ...createDefaultSessionStoreEntry(),
        inputTokens: undefined,
        cacheRead: 1_200,
        cacheWrite: 0,
        totalTokens: 1_000,
      },
    });
    try {
      const logs = await runStatusAndGetLogs();
      expect(logs.some((line) => line.includes("100% cached"))).toBe(true);
      expect(logs.some((line) => line.includes("120% cached"))).toBe(false);
    } finally {
      if (originalLoadSessionStore) {
        mocks.loadSessionStore.mockImplementation(originalLoadSessionStore);
      }
    }
  });

  it("uses prompt-side tokens for cached percentage when they differ from totalTokens", async () => {
    const originalLoadSessionStore = mocks.loadSessionStore.getMockImplementation();
    mocks.loadSessionStore.mockReturnValue({
      "+1000": {
        ...createDefaultSessionStoreEntry(),
        inputTokens: 500,
        cacheRead: 2_000,
        cacheWrite: 500,
        totalTokens: 5_000,
      },
    });
    try {
      const logs = await runStatusAndGetLogs();
      expect(logs.some((line) => line.includes("67% cached"))).toBe(true);
      expect(logs.some((line) => line.includes("40% cached"))).toBe(false);
    } finally {
      if (originalLoadSessionStore) {
        mocks.loadSessionStore.mockImplementation(originalLoadSessionStore);
      }
    }
  });

  it("shows node-only gateway info when no local gateway service is installed", async () => {
    mocks.resolveGatewayService.mockReturnValueOnce({
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      stage: async () => {},
      install: async () => {},
      uninstall: async () => {},
      stop: async () => {},
      restart: async () => ({ outcome: "completed" as const }),
      isLoaded: async () => false,
      readRuntime: async () => undefined,
      readCommand: async () => null,
    });

    await withNodeHostConfig(
      {
        version: 1,
        nodeId: "node-1",
        gateway: { host: "gateway.example.com", port: 19000 },
      },
      async () => {
        const joined = await runStatusAndGetJoinedLogs();
        expect(joined).toContain("node → gateway.example.com:19000 · no local gateway");
        expect(joined).not.toContain("Gateway: local · ws://127.0.0.1:18789");
        expect(joined).toContain("openclaw --profile isolated node status");
        expect(joined).not.toContain("Fix reachability first");
      },
    );
  });

  it("shows gateway auth when reachable", async () => {
    mocks.loadConfig.mockReturnValue({
      session: {},
      channels: { whatsapp: { allowFrom: ["*"] } },
    });
    await withEnvVar("DENNOU_GATEWAY_TOKEN", "abcd1234", async () => {
      mockProbeGatewayResult({
        ok: true,
        connectLatencyMs: 123,
        error: null,
        health: {},
        status: {},
        presence: [],
      });
      const logs = await runStatusAndGetLogs();
      expect(logs.some((l: string) => l.includes("auth token"))).toBe(true);
    });
  });

  it("warns instead of crashing when gateway auth SecretRef is unresolved for probe auth", async () => {
    mocks.loadConfig.mockReturnValue({
      session: {},
      channels: { whatsapp: { allowFrom: ["*"] } },
      gateway: {
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });

    await statusCommand({ json: true }, runtime as never, statusCommandDeps);
    const payload = JSON.parse(String(runtimeLogMock.mock.calls.at(-1)?.[0]));
    expect(payload.gateway.error ?? payload.gateway.authWarning ?? null).not.toBeNull();
    if (Array.isArray(payload.secretDiagnostics) && payload.secretDiagnostics.length > 0) {
      expect(
        payload.secretDiagnostics.some((entry: string) => entry.includes("gateway.auth.token")),
      ).toBe(true);
    }
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("surfaces channel runtime errors from the gateway", async () => {
    mocks.loadConfig.mockReturnValue({
      session: {},
      channels: { whatsapp: { allowFrom: ["*"] } },
    });
    mockProbeGatewayResult({
      ok: true,
      connectLatencyMs: 10,
      error: null,
      health: {},
      status: {},
      presence: [],
    });
    mocks.channelsStatus = {
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "signal-cli unreachable",
          },
        ],
        imessage: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "imessage permission denied",
          },
        ],
      },
    };

    const joined = await runStatusAndGetJoinedLogs();
    expect(joined).toMatch(/Signal/i);
    expect(joined).toMatch(/iMessage/i);
    expect(joined).toMatch(/gateway:/i);
    expect(joined).toMatch(/WARN/);
  });

  it.each([
    {
      name: "prints requestId-aware recovery guidance when gateway pairing is required",
      error: "connect failed: pairing required (requestId: req-123)",
      closeReason: "pairing required (requestId: req-123)",
      includes: ["devices approve req-123"],
      excludes: [],
    },
    {
      name: "prints fallback recovery guidance when pairing requestId is unavailable",
      error: "connect failed: pairing required",
      closeReason: "connect failed",
      includes: [],
      excludes: ["devices approve req-"],
    },
    {
      name: "does not render unsafe requestId content into approval command hints",
      error: "connect failed: pairing required (requestId: req-123;rm -rf /)",
      closeReason: "pairing required (requestId: req-123;rm -rf /)",
      includes: [],
      excludes: ["devices approve req-123;rm -rf /"],
    },
  ])("$name", async ({ error, closeReason, includes, excludes }) => {
    mocks.loadConfig.mockReturnValue({
      session: {},
      channels: { whatsapp: { allowFrom: ["*"] } },
    });
    mockProbeGatewayResult({
      error,
      close: { code: 1008, reason: closeReason },
    });
    const joined = await runStatusAndGetJoinedLogs();
    expect(joined).toContain("Gateway pairing approval required.");
    expect(joined).toContain("devices approve --latest");
    expect(joined).toContain("devices list");
    for (const expected of includes) {
      expect(joined).toContain(expected);
    }
    for (const blocked of excludes) {
      expect(joined).not.toContain(blocked);
    }
  });

  it("extracts requestId from close reason when error text omits it", async () => {
    mocks.loadConfig.mockReturnValue({
      session: {},
      channels: { whatsapp: { allowFrom: ["*"] } },
    });
    mockProbeGatewayResult({
      error: "connect failed: pairing required",
      close: { code: 1008, reason: "pairing required (requestId: req-close-456)" },
    });
    const joined = await runStatusAndGetJoinedLogs();
    expect(joined).toContain("devices approve req-close-456");
  });

  it("includes sessions across agents in JSON output", async () => {
    const originalAgents = mocks.listGatewayAgentsBasic.getMockImplementation();
    const originalResolveStorePath = mocks.resolveStorePath.getMockImplementation();
    const originalLoadSessionStore = mocks.loadSessionStore.getMockImplementation();

    mocks.listGatewayAgentsBasic.mockReturnValue({
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "Main" },
        { id: "ops", name: "Ops" },
      ],
    });
    mocks.resolveStorePath.mockImplementation((_store, opts) =>
      opts?.agentId === "ops" ? "/tmp/ops.json" : "/tmp/main.json",
    );
    mocks.loadSessionStore.mockImplementation((storePath) => {
      if (storePath === "/tmp/ops.json") {
        return {
          "agent:ops:main": {
            updatedAt: Date.now() - 120_000,
            inputTokens: 1_000,
            outputTokens: 1_000,
            totalTokens: 2_000,
            contextTokens: 10_000,
            model: "pi:opus",
          },
        };
      }
      return {
        "+1000": createDefaultSessionStoreEntry(),
      };
    });

    await statusCommand({ json: true }, runtime as never, statusCommandDeps);
    const payload = JSON.parse(String(runtimeLogMock.mock.calls.at(-1)?.[0]));
    expect(payload.sessions.count).toBe(2);
    expect(payload.sessions.paths.length).toBe(2);
    expect(
      payload.sessions.recent.some((sess: { key?: string }) => sess.key === "agent:ops:main"),
    ).toBe(true);

    if (originalAgents) {
      mocks.listGatewayAgentsBasic.mockImplementation(originalAgents);
    }
    if (originalResolveStorePath) {
      mocks.resolveStorePath.mockImplementation(originalResolveStorePath);
    }
    if (originalLoadSessionStore) {
      mocks.loadSessionStore.mockImplementation(originalLoadSessionStore);
    }
  });
});

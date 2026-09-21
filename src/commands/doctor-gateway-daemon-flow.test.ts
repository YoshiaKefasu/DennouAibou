import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGatewayPort } from "../config/config.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveNodeLaunchAgentLabel,
} from "../daemon/constants.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import {
  isLaunchAgentListed,
  isLaunchAgentLoaded,
  launchAgentPlistExists,
  repairLaunchAgentBootstrap,
} from "../daemon/launchd.js";
import { resolveGatewayService, type GatewayService } from "../daemon/service.js";
import { renderSystemdUnavailableHints } from "../daemon/systemd-hints.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import { isWSL } from "../infra/wsl.js";
import { note } from "../terminal/note.js";
import { sleep } from "../utils.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "./daemon-install-helpers.js";
import { buildGatewayRuntimeHints, formatGatewayRuntimeSummary } from "./doctor-format.js";
import {
  maybeRepairGatewayDaemon as maybeRepairGatewayDaemonImpl,
  type DoctorGatewayDaemonFlowDeps,
} from "./doctor-gateway-daemon-flow.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";
import { healthCommand } from "./health.js";

// Explicit dependency injection replaces the module-level `vi.mock` calls
// (Bun cannot intercept ESM imports).

const service = {
  label: "LaunchAgent",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  stage: vi.fn<GatewayService["stage"]>(async () => {}),
  install: vi.fn<GatewayService["install"]>(async () => {}),
  uninstall: vi.fn<GatewayService["uninstall"]>(async () => {}),
  stop: vi.fn<GatewayService["stop"]>(async () => {}),
  restart: vi.fn<GatewayService["restart"]>(async () => ({ outcome: "completed" })),
  isLoaded: vi.fn<GatewayService["isLoaded"]>(async () => true),
  readCommand: vi.fn<GatewayService["readCommand"]>(async () => null),
  readRuntime: vi.fn<GatewayService["readRuntime"]>(async () => ({ status: "running" })),
} satisfies GatewayService;
const resolveGatewayPortMock = vi.fn<typeof resolveGatewayPort>(() => 18789);
const readLastGatewayErrorLineMock = vi.fn<typeof readLastGatewayErrorLine>(async () => null);
const noteMock = vi.fn<typeof note>();
const sleepMock = vi.fn<typeof sleep>(async () => {});
const healthCommandMock = vi.fn<typeof healthCommand>();
const inspectPortUsageMock = vi.fn<typeof inspectPortUsage>();
const formatPortDiagnosticsMock = vi.fn<typeof formatPortDiagnostics>(() => []);
const isSystemdUserServiceAvailableMock = vi.fn<typeof isSystemdUserServiceAvailable>(
  async () => true,
);
const isWSLMock = vi.fn<typeof isWSL>(async () => false);
const renderSystemdUnavailableHintsMock = vi.fn<typeof renderSystemdUnavailableHints>(() => []);
const buildGatewayInstallPlanMock = vi.fn<typeof buildGatewayInstallPlan>();
const gatewayInstallErrorHintMock = vi.fn<typeof gatewayInstallErrorHint>(() => "hint");
const resolveGatewayInstallTokenMock = vi.fn<typeof resolveGatewayInstallToken>();
const resolveGatewayLaunchAgentLabelMock = vi.fn<typeof resolveGatewayLaunchAgentLabel>(
  () => "ai.openclaw.gateway",
);
const resolveNodeLaunchAgentLabelMock = vi.fn<typeof resolveNodeLaunchAgentLabel>(
  () => "ai.openclaw.node",
);
const isLaunchAgentListedMock = vi.fn<typeof isLaunchAgentListed>(async () => false);
const isLaunchAgentLoadedMock = vi.fn<typeof isLaunchAgentLoaded>(async () => false);
const launchAgentPlistExistsMock = vi.fn<typeof launchAgentPlistExists>(async () => false);
const repairLaunchAgentBootstrapMock = vi.fn<typeof repairLaunchAgentBootstrap>(async () => ({
  ok: true,
  status: "repaired",
}));
const formatGatewayRuntimeSummaryMock = vi.fn<typeof formatGatewayRuntimeSummary>(() => null);
const buildGatewayRuntimeHintsMock = vi.fn<typeof buildGatewayRuntimeHints>(() => []);

const daemonDeps: DoctorGatewayDaemonFlowDeps = {
  resolveGatewayService: () => service,
  resolveGatewayPort: resolveGatewayPortMock,
  readLastGatewayErrorLine: readLastGatewayErrorLineMock,
  note: noteMock,
  sleep: sleepMock,
  healthCommand: healthCommandMock,
  inspectPortUsage: inspectPortUsageMock,
  formatPortDiagnostics: formatPortDiagnosticsMock,
  isSystemdUserServiceAvailable: isSystemdUserServiceAvailableMock,
  isWSL: isWSLMock,
  renderSystemdUnavailableHints: renderSystemdUnavailableHintsMock,
  buildGatewayInstallPlan: buildGatewayInstallPlanMock,
  gatewayInstallErrorHint: gatewayInstallErrorHintMock,
  resolveGatewayInstallToken: resolveGatewayInstallTokenMock,
  resolveGatewayLaunchAgentLabel: resolveGatewayLaunchAgentLabelMock,
  resolveNodeLaunchAgentLabel: resolveNodeLaunchAgentLabelMock,
  isLaunchAgentListed: isLaunchAgentListedMock,
  isLaunchAgentLoaded: isLaunchAgentLoadedMock,
  launchAgentPlistExists: launchAgentPlistExistsMock,
  repairLaunchAgentBootstrap: repairLaunchAgentBootstrapMock,
  formatGatewayRuntimeSummary: formatGatewayRuntimeSummaryMock,
  buildGatewayRuntimeHints: buildGatewayRuntimeHintsMock,
};

const maybeRepairGatewayDaemon = (params: Parameters<typeof maybeRepairGatewayDaemonImpl>[0]) =>
  maybeRepairGatewayDaemonImpl(params, daemonDeps);

describe("maybeRepairGatewayDaemon", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalUpdateInProgress = process.env.DENNOU_UPDATE_IN_PROGRESS;

  beforeEach(() => {
    vi.clearAllMocks();
    service.isLoaded.mockResolvedValue(true);
    service.readRuntime.mockResolvedValue({ status: "running" });
    service.restart.mockResolvedValue({ outcome: "completed" });
    inspectPortUsageMock.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    if (originalUpdateInProgress === undefined) {
      delete process.env.DENNOU_UPDATE_IN_PROGRESS;
    } else {
      process.env.DENNOU_UPDATE_IN_PROGRESS = originalUpdateInProgress;
    }
  });

  function setPlatform(platform: NodeJS.Platform) {
    if (!originalPlatformDescriptor) {
      return;
    }
    Object.defineProperty(process, "platform", {
      ...originalPlatformDescriptor,
      value: platform,
    });
  }

  function createPrompter(confirmImpl: (message: string) => boolean) {
    return {
      confirm: vi.fn(),
      confirmAutoFix: vi.fn(),
      confirmAggressiveAutoFix: vi.fn(),
      confirmRuntimeRepair: vi.fn(async ({ message }: { message: string }) => confirmImpl(message)),
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
  }

  async function runNonInteractiveUpdateRepair() {
    process.env.DENNOU_UPDATE_IN_PROGRESS = "1";
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime,
      prompter: createDoctorPrompter({
        runtime,
        options: { repair: true, nonInteractive: true },
      }),
      options: { deep: false, repair: true, nonInteractive: true },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });
  }

  it("skips restart verification when a running service restart is only scheduled", async () => {
    setPlatform("linux");
    service.restart.mockResolvedValueOnce({ outcome: "scheduled" });

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createPrompter((message) => message === "Restart gateway service now?"),
      options: { deep: false },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });

    expect(service.restart).toHaveBeenCalledTimes(1);
    expect(noteMock).toHaveBeenCalledWith(
      "restart scheduled, gateway will restart momentarily",
      "Gateway",
    );
    expect(sleepMock).not.toHaveBeenCalled();
    expect(healthCommandMock).not.toHaveBeenCalled();
  });

  it("skips start verification when a stopped service start is only scheduled", async () => {
    setPlatform("linux");
    service.readRuntime.mockResolvedValue({ status: "stopped" });
    service.restart.mockResolvedValueOnce({ outcome: "scheduled" });

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createPrompter((message) => message === "Start gateway service now?"),
      options: { deep: false },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });

    expect(service.restart).toHaveBeenCalledTimes(1);
    expect(noteMock).toHaveBeenCalledWith(
      "restart scheduled, gateway will restart momentarily",
      "Gateway",
    );
    expect(sleepMock).not.toHaveBeenCalled();
    expect(healthCommandMock).not.toHaveBeenCalled();
  });

  it("skips gateway install during non-interactive update repairs", async () => {
    setPlatform("linux");
    service.isLoaded.mockResolvedValue(false);

    await runNonInteractiveUpdateRepair();

    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("skips gateway restart during non-interactive update repairs", async () => {
    setPlatform("linux");

    await runNonInteractiveUpdateRepair();

    expect(service.restart).not.toHaveBeenCalled();
  });
});

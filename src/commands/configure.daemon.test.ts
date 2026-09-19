import { beforeEach, describe, expect, it, vi } from "vitest";
import type { resolveGatewayService } from "../daemon/service.js";
import { maybeInstallDaemon, type MaybeInstallDaemonDeps } from "./configure.daemon.js";

const serviceIsLoaded = vi.fn(async () => false);
const serviceInstall = vi.fn(async () => {});
const serviceUninstall = vi.fn(async () => {});
const serviceRestart = vi.fn<() => Promise<{ outcome: "completed" | "scheduled" }>>(async () => ({
  outcome: "completed",
}));
const progressSetLabel = vi.fn();
const loadConfig = vi.fn();
const resolveGatewayInstallToken = vi.fn();
const buildGatewayInstallPlan = vi.fn();
const note = vi.fn();
const select = vi.fn(async () => "node");
const confirm = vi.fn(async () => true);
const ensureSystemdUserLingerInteractive = vi.fn(async () => {});
const withProgress = vi.fn(
  async (_opts: unknown, run: (progress: { setLabel: typeof progressSetLabel }) => Promise<void>) =>
    run({ setLabel: progressSetLabel }),
);

/**
 * Inject every daemon-install boundary instead of mocking the CLI progress,
 * config, daemon service, terminal, and systemd-linger modules at module level
 * (Bun cannot intercept ESM imports).
 */
function createDeps(): MaybeInstallDaemonDeps {
  return {
    resolveGatewayService: (() => ({
      label: "test-service",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      stage: async () => {},
      install: serviceInstall,
      uninstall: serviceUninstall,
      stop: async () => {},
      restart: serviceRestart,
      isLoaded: serviceIsLoaded,
      readRuntime: async () => ({ status: "stopped", pid: null }),
      readCommand: async () => ({ programArguments: [], sourcePath: "/tmp/test.plist" }),
    })) as unknown as typeof resolveGatewayService,
    loadConfig: loadConfig as unknown as MaybeInstallDaemonDeps["loadConfig"],
    resolveGatewayInstallToken:
      resolveGatewayInstallToken as unknown as MaybeInstallDaemonDeps["resolveGatewayInstallToken"],
    buildGatewayInstallPlan:
      buildGatewayInstallPlan as unknown as MaybeInstallDaemonDeps["buildGatewayInstallPlan"],
    note: note as unknown as MaybeInstallDaemonDeps["note"],
    select: select as unknown as MaybeInstallDaemonDeps["select"],
    confirm: confirm as unknown as MaybeInstallDaemonDeps["confirm"],
    withProgress: withProgress as unknown as MaybeInstallDaemonDeps["withProgress"],
    ensureSystemdUserLingerInteractive:
      ensureSystemdUserLingerInteractive as unknown as MaybeInstallDaemonDeps["ensureSystemdUserLingerInteractive"],
  };
}

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

describe("maybeInstallDaemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    progressSetLabel.mockReset();
    serviceIsLoaded.mockReset();
    serviceIsLoaded.mockResolvedValue(false);
    serviceInstall.mockReset();
    serviceInstall.mockResolvedValue(undefined);
    serviceUninstall.mockReset();
    serviceUninstall.mockResolvedValue(undefined);
    serviceRestart.mockReset();
    serviceRestart.mockResolvedValue({ outcome: "completed" });
    select.mockReset();
    select.mockResolvedValue("node");
    confirm.mockReset();
    confirm.mockResolvedValue(true);
    ensureSystemdUserLingerInteractive.mockReset();
    ensureSystemdUserLingerInteractive.mockResolvedValue(undefined);
    loadConfig.mockReset();
    loadConfig.mockReturnValue({});
    resolveGatewayInstallToken.mockReset();
    resolveGatewayInstallToken.mockResolvedValue({
      token: undefined,
      tokenRefConfigured: true,
      warnings: [],
    });
    buildGatewayInstallPlan.mockReset();
    buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment: {},
    });
    note.mockReset();
  });

  it("does not serialize SecretRef token into service environment", async () => {
    await maybeInstallDaemon({ runtime: createRuntime(), port: 18789 }, createDeps());

    expect(resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan).toHaveBeenCalledTimes(1);
    expect("token" in buildGatewayInstallPlan.mock.calls[0][0]).toBe(false);
    expect(serviceInstall).toHaveBeenCalledTimes(1);
  });

  it("blocks install when token SecretRef is unresolved", async () => {
    resolveGatewayInstallToken.mockResolvedValue({
      token: undefined,
      tokenRefConfigured: true,
      unavailableReason: "gateway.auth.token SecretRef is configured but unresolved (boom).",
      warnings: [],
    });

    await maybeInstallDaemon({ runtime: createRuntime(), port: 18789 }, createDeps());

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway install blocked"),
      "Gateway",
    );
    expect(buildGatewayInstallPlan).not.toHaveBeenCalled();
    expect(serviceInstall).not.toHaveBeenCalled();
  });

  it("continues daemon install flow when service status probe throws", async () => {
    serviceIsLoaded.mockRejectedValueOnce(
      new Error("systemctl is-enabled unavailable: Failed to connect to bus"),
    );

    await expect(
      maybeInstallDaemon({ runtime: createRuntime(), port: 18789 }, createDeps()),
    ).resolves.toBeUndefined();

    expect(serviceInstall).toHaveBeenCalledTimes(1);
  });

  it("rethrows install probe failures that are not the known non-fatal Linux systemd cases", async () => {
    serviceIsLoaded.mockRejectedValueOnce(
      new Error("systemctl is-enabled unavailable: read-only file system"),
    );

    await expect(
      maybeInstallDaemon({ runtime: createRuntime(), port: 18789 }, createDeps()),
    ).rejects.toThrow("systemctl is-enabled unavailable: read-only file system");

    expect(serviceInstall).not.toHaveBeenCalled();
  });

  it("continues the WSL2 daemon install flow when service status probe reports systemd unavailability", async () => {
    serviceIsLoaded.mockRejectedValueOnce(
      new Error("systemctl --user unavailable: Failed to connect to bus: No medium found"),
    );

    await expect(
      maybeInstallDaemon({ runtime: createRuntime(), port: 18789 }, createDeps()),
    ).resolves.toBeUndefined();

    expect(serviceInstall).toHaveBeenCalledTimes(1);
  });

  it("shows restart scheduled when a loaded service defers restart handoff", async () => {
    serviceIsLoaded.mockResolvedValue(true);
    select.mockResolvedValueOnce("restart");
    serviceRestart.mockResolvedValueOnce({ outcome: "scheduled" });

    await maybeInstallDaemon({ runtime: createRuntime(), port: 18789 }, createDeps());

    expect(serviceRestart).toHaveBeenCalledTimes(1);
    expect(serviceInstall).not.toHaveBeenCalled();
    expect(progressSetLabel).toHaveBeenLastCalledWith("Gateway service restart scheduled.");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readBestEffortConfig as realReadBestEffortConfig } from "../config/config.js";
import type { GatewayProbeResult } from "../gateway/probe.js";
import { probeGateway as realProbeGateway } from "../gateway/probe.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import { discoverGatewayBeacons as realDiscoverGatewayBeacons } from "../infra/bonjour-discovery.js";
import * as sshConfigModule from "../infra/ssh-config.js";
import * as sshTunnelModule from "../infra/ssh-tunnel.js";
import { pickPrimaryTailnetIPv4 as realPickPrimaryTailnetIPv4 } from "../infra/tailnet.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import { gatewayStatusCommand, type GatewayStatusDeps } from "./gateway-status.js";

const sshStop = vi.fn(async () => {});

const deps: GatewayStatusDeps = {
  readBestEffortConfig: vi.fn(async () => ({
    gateway: {
      mode: "remote",
      remote: { url: "wss://remote.example:18789", token: "rtok" },
      auth: { token: "ltok" },
    },
  })) as MockFn<typeof realReadBestEffortConfig>,
  resolveGatewayPort: vi.fn((_cfg?: unknown) => 18789) as unknown as MockFn<
    NonNullable<GatewayStatusDeps["resolveGatewayPort"]>
  >,
  discoverGatewayBeaconsFn: vi.fn(
    async (_opts?: unknown): Promise<GatewayBonjourBeacon[]> => [],
  ) as MockFn<typeof realDiscoverGatewayBeacons>,
  pickPrimaryTailnetIPv4: vi.fn(() => "100.64.0.10") as unknown as MockFn<
    NonNullable<GatewayStatusDeps["pickPrimaryTailnetIPv4"]>
  >,
  resolveSshConfigFn: vi.fn(
    async (
      _opts?: unknown,
    ): Promise<{
      user: string;
      host: string;
      port: number;
      identityFiles: string[];
    } | null> => null,
  ) as unknown as MockFn<typeof sshConfigModule.resolveSshConfig>,
  startSshPortForwardFn: vi.fn(async (_opts?: unknown) => ({
    parsedTarget: { user: "me", host: "studio", port: 22 },
    localPort: 18789,
    remotePort: 18789,
    pid: 123,
    stderr: [],
    stop: sshStop,
  })) as unknown as MockFn<typeof sshTunnelModule.startSshPortForward>,
  probeGatewayFn: vi.fn(async (opts: { url: string }): Promise<GatewayProbeResult> => {
    const { url } = opts;
    if (url.includes("127.0.0.1")) {
      return {
        ok: true,
        url,
        connectLatencyMs: 12,
        error: null,
        close: null,
        health: { ok: true },
        status: {
          linkChannel: {
            id: "whatsapp",
            label: "WhatsApp",
            linked: false,
            authAgeMs: null,
          },
          sessions: { count: 0 },
        },
        presence: [
          {
            mode: "gateway",
            reason: "self",
            host: "local",
            ip: "127.0.0.1",
            text: "Gateway: local (127.0.0.1) · app test · mode gateway · reason self",
            ts: Date.now(),
          },
        ],
        configSnapshot: {
          path: "/tmp/cfg.json",
          exists: true,
          valid: true,
          config: {
            gateway: { mode: "local" },
          },
          issues: [],
          legacyIssues: [],
        },
      };
    }
    return {
      ok: true,
      url,
      connectLatencyMs: 34,
      error: null,
      close: null,
      health: { ok: true },
      status: {
        linkChannel: {
          id: "whatsapp",
          label: "WhatsApp",
          linked: true,
          authAgeMs: 5_000,
        },
        sessions: { count: 2 },
      },
      presence: [
        {
          mode: "gateway",
          reason: "self",
          host: "remote",
          ip: "100.64.0.2",
          text: "Gateway: remote (100.64.0.2) · app test · mode gateway · reason self",
          ts: Date.now(),
        },
      ],
      configSnapshot: {
        path: "/tmp/remote.json",
        exists: true,
        valid: true,
        config: { gateway: { mode: "remote" } },
        issues: [],
        legacyIssues: [],
      },
    };
  }) as MockFn<typeof realProbeGateway>,
};

const {
  readBestEffortConfig,
  discoverGatewayBeaconsFn,
  pickPrimaryTailnetIPv4,
  resolveSshConfigFn,
  startSshPortForwardFn,
  probeGatewayFn,
} = deps;

function createRuntimeCapture() {
  const runtimeLogs: string[] = [];
  const runtimeErrors: string[] = [];
  const runtime = {
    log: (msg: string) => runtimeLogs.push(msg),
    error: (msg: string) => runtimeErrors.push(msg),
    exit: (code: number) => {
      throw new Error(`__exit__:${code}`);
    },
  };
  return { runtime, runtimeLogs, runtimeErrors };
}

function asRuntimeEnv(runtime: ReturnType<typeof createRuntimeCapture>["runtime"]): RuntimeEnv {
  return runtime as unknown as RuntimeEnv;
}

function makeRemoteGatewayConfig(url: string, token = "rtok", localToken = "ltok") {
  return {
    gateway: {
      mode: "remote",
      remote: { url, token },
      auth: { token: localToken },
    },
  };
}

function mockLocalTokenEnvRefConfig(envTokenId = "MISSING_GATEWAY_TOKEN") {
  (readBestEffortConfig as MockFn<typeof realReadBestEffortConfig>).mockResolvedValueOnce({
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
    gateway: {
      mode: "local",
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: envTokenId },
      },
    },
  } as never);
}

async function runGatewayStatus(
  runtime: ReturnType<typeof createRuntimeCapture>["runtime"],
  opts: { timeout: string; json?: boolean; ssh?: string; sshAuto?: boolean; sshIdentity?: string },
) {
  await gatewayStatusCommand(opts as never, asRuntimeEnv(runtime), deps);
}

function findUnresolvedSecretRefWarning(runtimeLogs: string[]) {
  const parsed = JSON.parse(runtimeLogs.join("\n")) as {
    warnings?: Array<{ code?: string; message?: string; targetIds?: string[] }>;
  };
  return parsed.warnings?.find(
    (warning) =>
      warning.code === "auth_secretref_unresolved" &&
      warning.message?.includes("gateway.auth.token SecretRef is unresolved"),
  );
}

describe("gateway-status command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (readBestEffortConfig as MockFn<typeof realReadBestEffortConfig>).mockReset();
    (readBestEffortConfig as MockFn<typeof realReadBestEffortConfig>).mockImplementation(
      async () => ({
        gateway: {
          mode: "remote",
          remote: { url: "wss://remote.example:18789", token: "rtok" },
          auth: { token: "ltok" },
        },
      }),
    );
    (discoverGatewayBeaconsFn as MockFn<typeof realDiscoverGatewayBeacons>).mockReset();
    (discoverGatewayBeaconsFn as MockFn<typeof realDiscoverGatewayBeacons>).mockImplementation(
      async (_opts?: unknown): Promise<GatewayBonjourBeacon[]> => [],
    );
    (
      pickPrimaryTailnetIPv4 as NonNullable<GatewayStatusDeps["pickPrimaryTailnetIPv4"]> &
        MockFn<() => string | undefined>
    ).mockReset();
    (
      pickPrimaryTailnetIPv4 as NonNullable<GatewayStatusDeps["pickPrimaryTailnetIPv4"]> &
        MockFn<() => string | undefined>
    ).mockReturnValue("100.64.0.10");
    (resolveSshConfigFn as unknown as MockFn<typeof sshConfigModule.resolveSshConfig>).mockReset();
    (
      resolveSshConfigFn as unknown as MockFn<typeof sshConfigModule.resolveSshConfig>
    ).mockImplementation(async () => null);
    (
      startSshPortForwardFn as unknown as MockFn<typeof sshTunnelModule.startSshPortForward>
    ).mockReset();
    (
      startSshPortForwardFn as unknown as MockFn<typeof sshTunnelModule.startSshPortForward>
    ).mockImplementation(async (_opts?: unknown) => ({
      parsedTarget: { user: "me", host: "studio", port: 22 },
      localPort: 18789,
      remotePort: 18789,
      pid: 123,
      stderr: [],
      stop: sshStop,
    }));
    (probeGatewayFn as MockFn<typeof realProbeGateway>).mockReset();
    (probeGatewayFn as MockFn<typeof realProbeGateway>).mockImplementation(
      async (opts: { url: string }): Promise<GatewayProbeResult> => {
        const { url } = opts;
        if (url.includes("127.0.0.1")) {
          return {
            ok: true,
            url,
            connectLatencyMs: 12,
            error: null,
            close: null,
            health: { ok: true },
            status: {
              linkChannel: {
                id: "whatsapp",
                label: "WhatsApp",
                linked: false,
                authAgeMs: null,
              },
              sessions: { count: 0 },
            },
            presence: [
              {
                mode: "gateway",
                reason: "self",
                host: "local",
                ip: "127.0.0.1",
                text: "Gateway: local (127.0.0.1) · app test · mode gateway · reason self",
                ts: Date.now(),
              },
            ],
            configSnapshot: {
              path: "/tmp/cfg.json",
              exists: true,
              valid: true,
              config: {
                gateway: { mode: "local" },
              },
              issues: [],
              legacyIssues: [],
            },
          };
        }
        return {
          ok: true,
          url,
          connectLatencyMs: 34,
          error: null,
          close: null,
          health: { ok: true },
          status: {
            linkChannel: {
              id: "whatsapp",
              label: "WhatsApp",
              linked: true,
              authAgeMs: 5_000,
            },
            sessions: { count: 2 },
          },
          presence: [
            {
              mode: "gateway",
              reason: "self",
              host: "remote",
              ip: "100.64.0.2",
              text: "Gateway: remote (100.64.0.2) · app test · mode gateway · reason self",
              ts: Date.now(),
            },
          ],
          configSnapshot: {
            path: "/tmp/remote.json",
            exists: true,
            valid: true,
            config: { gateway: { mode: "remote" } },
            issues: [],
            legacyIssues: [],
          },
        };
      },
    );
    sshStop.mockClear();
  });

  it("prints human output by default", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();

    await runGatewayStatus(runtime, { timeout: "1000" });

    expect(runtimeErrors).toHaveLength(0);
    expect(runtimeLogs.join("\n")).toContain("Gateway Status");
    expect(runtimeLogs.join("\n")).toContain("Discovery (this machine)");
    expect(runtimeLogs.join("\n")).toContain("Targets");
  });

  it("prints a structured JSON envelope when --json is set", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();

    await runGatewayStatus(runtime, { timeout: "1000", json: true });

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.targets).toBeTruthy();
    const targets = parsed.targets as Array<Record<string, unknown>>;
    expect(targets.length).toBeGreaterThanOrEqual(2);
    expect(targets[0]?.health).toBeTruthy();
    expect(targets[0]?.summary).toBeTruthy();
  });

  it("omits discovery wsUrl when only TXT hints are present", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    (discoverGatewayBeaconsFn as MockFn<typeof realDiscoverGatewayBeacons>).mockResolvedValueOnce([
      {
        instanceName: "gateway",
        displayName: "Gateway",
        tailnetDns: "attacker.tailnet.ts.net",
        lanHost: "attacker.example.com",
        gatewayPort: 19443,
      },
    ]);

    await runGatewayStatus(runtime, { timeout: "1000", json: true });

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      discovery?: { beacons?: Array<{ wsUrl?: string | null }> };
    };
    expect(parsed.discovery?.beacons?.[0]?.wsUrl).toBeNull();
  });

  it("keeps status output working when tailnet discovery throws", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    (
      pickPrimaryTailnetIPv4 as NonNullable<GatewayStatusDeps["pickPrimaryTailnetIPv4"]> &
        MockFn<() => string | undefined>
    ).mockImplementationOnce(() => {
      throw new Error("uv_interface_addresses failed");
    });

    await runGatewayStatus(runtime, { timeout: "1000", json: true });

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      network?: { tailnetIPv4?: string | null; localTailnetUrl?: string | null };
    };
    expect(parsed.network).toMatchObject({
      tailnetIPv4: null,
      localTailnetUrl: null,
    });
  });

  it("treats missing-scope RPC probe failures as degraded but reachable", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    (readBestEffortConfig as MockFn<typeof realReadBestEffortConfig>).mockResolvedValueOnce({
      gateway: {
        mode: "local",
        auth: { mode: "token", token: "ltok" },
      },
    } as never);
    (probeGatewayFn as MockFn<typeof realProbeGateway>).mockResolvedValueOnce({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 51,
      error: "missing scope: operator.read",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    await runGatewayStatus(runtime, { timeout: "1000", json: true });

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      ok?: boolean;
      degraded?: boolean;
      warnings?: Array<{ code?: string; targetIds?: string[] }>;
      targets?: Array<{
        connect?: {
          ok?: boolean;
          rpcOk?: boolean;
          scopeLimited?: boolean;
        };
      }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.degraded).toBe(true);
    expect(parsed.targets?.[0]?.connect).toMatchObject({
      ok: true,
      rpcOk: false,
      scopeLimited: true,
    });
    const scopeLimitedWarning = parsed.warnings?.find(
      (warning) => warning.code === "probe_scope_limited",
    );
    expect(scopeLimitedWarning?.targetIds).toContain("localLoopback");
  });

  it("suppresses unresolved SecretRef auth warnings when probe is reachable", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync({ MISSING_GATEWAY_TOKEN: undefined }, async () => {
      mockLocalTokenEnvRefConfig();

      await runGatewayStatus(runtime, { timeout: "1000", json: true });
    });

    expect(runtimeErrors).toHaveLength(0);
    const unresolvedWarning = findUnresolvedSecretRefWarning(runtimeLogs);
    expect(unresolvedWarning).toBeUndefined();
  });

  it("surfaces unresolved SecretRef auth diagnostics when probe fails", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync({ MISSING_GATEWAY_TOKEN: undefined }, async () => {
      mockLocalTokenEnvRefConfig();
      (probeGatewayFn as MockFn<typeof realProbeGateway>).mockResolvedValueOnce({
        ok: false,
        url: "ws://127.0.0.1:18789",
        connectLatencyMs: null,
        error: "connection refused",
        close: null,
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      });
      await expect(runGatewayStatus(runtime, { timeout: "1000", json: true })).rejects.toThrow(
        "__exit__:1",
      );
    });

    expect(runtimeErrors).toHaveLength(0);
    const unresolvedWarning = findUnresolvedSecretRefWarning(runtimeLogs);
    expect(unresolvedWarning).toBeTruthy();
    expect(unresolvedWarning?.targetIds).toContain("localLoopback");
    expect(unresolvedWarning?.message).toContain("env:default:MISSING_GATEWAY_TOKEN");
    expect(unresolvedWarning?.message).not.toContain("missing or empty");
  });

  it("does not resolve local token SecretRef when DENNOU_GATEWAY_TOKEN is set", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync(
      {
        DENNOU_GATEWAY_TOKEN: "env-token",
        MISSING_GATEWAY_TOKEN: undefined,
      },
      async () => {
        mockLocalTokenEnvRefConfig();

        await runGatewayStatus(runtime, { timeout: "1000", json: true });
      },
    );

    expect(runtimeErrors).toHaveLength(0);
    expect(probeGatewayFn).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          token: "env-token",
        }),
      }),
    );
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      warnings?: Array<{ code?: string; message?: string }>;
    };
    const unresolvedWarning = parsed.warnings?.find(
      (warning) =>
        warning.code === "auth_secretref_unresolved" &&
        warning.message?.includes("gateway.auth.token SecretRef is unresolved"),
    );
    expect(unresolvedWarning).toBeUndefined();
  });

  it("does not resolve local password SecretRef in token mode", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync(
      {
        DENNOU_GATEWAY_TOKEN: "env-token",
        MISSING_GATEWAY_PASSWORD: undefined,
      },
      async () => {
        (readBestEffortConfig as MockFn<typeof realReadBestEffortConfig>).mockResolvedValueOnce({
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          gateway: {
            mode: "local",
            auth: {
              mode: "token",
              token: "config-token",
              password: { source: "env", provider: "default", id: "MISSING_GATEWAY_PASSWORD" },
            },
          },
        } as never);

        await runGatewayStatus(runtime, { timeout: "1000", json: true });
      },
    );

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      warnings?: Array<{ code?: string; message?: string }>;
    };
    const unresolvedPasswordWarning = parsed.warnings?.find(
      (warning) =>
        warning.code === "auth_secretref_unresolved" &&
        warning.message?.includes("gateway.auth.password SecretRef is unresolved"),
    );
    expect(unresolvedPasswordWarning).toBeUndefined();
  });

  it("resolves env-template gateway.auth.token before probing targets", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync(
      {
        CUSTOM_GATEWAY_TOKEN: "resolved-gateway-token",
        DENNOU_GATEWAY_TOKEN: undefined,
      },
      async () => {
        (readBestEffortConfig as MockFn<typeof realReadBestEffortConfig>).mockResolvedValueOnce({
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          gateway: {
            mode: "local",
            auth: {
              mode: "token",
              token: "${CUSTOM_GATEWAY_TOKEN}",
            },
          },
        } as never);

        await runGatewayStatus(runtime, { timeout: "1000", json: true });
      },
    );

    expect(runtimeErrors).toHaveLength(0);
    expect(probeGatewayFn).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          token: "resolved-gateway-token",
        }),
      }),
    );
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      warnings?: Array<{ code?: string }>;
    };
    const unresolvedWarning = parsed.warnings?.find(
      (warning) => warning.code === "auth_secretref_unresolved",
    );
    expect(unresolvedWarning).toBeUndefined();
  });

  it("emits stable SecretRef auth configuration booleans in --json output", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    const previousProbeImpl = (
      probeGatewayFn as MockFn<typeof realProbeGateway>
    ).getMockImplementation();
    (probeGatewayFn as MockFn<typeof realProbeGateway>).mockImplementation(
      async (opts: { url: string }) => ({
        ok: true,
        url: opts.url,
        connectLatencyMs: 20,
        error: null,
        close: null,
        health: { ok: true },
        status: {
          linkChannel: {
            id: "whatsapp",
            label: "WhatsApp",
            linked: true,
            authAgeMs: 1_000,
          },
          sessions: { count: 1 },
        },
        presence: [
          {
            mode: "gateway",
            reason: "self",
            host: "remote",
            ip: "100.64.0.2",
            text: "Gateway: remote (100.64.0.2) · app test · mode gateway · reason self",
            ts: Date.now(),
          },
        ],
        configSnapshot: {
          path: "/tmp/secretref-config.json",
          exists: true,
          valid: true,
          config: {
            secrets: {
              defaults: {
                env: "default",
              },
            },
            gateway: {
              mode: "remote",
              auth: {
                mode: "token",
                token: { source: "env", provider: "default", id: "DENNOU_GATEWAY_TOKEN" },
                password: { source: "env", provider: "default", id: "DENNOU_GATEWAY_PASSWORD" },
              },
              remote: {
                url: "wss://remote.example:18789",
                token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
                password: { source: "env", provider: "default", id: "REMOTE_GATEWAY_PASSWORD" },
              },
            },
            discovery: {
              wideArea: { enabled: true },
            },
          },
          issues: [],
          legacyIssues: [],
        },
      }),
    );

    try {
      await runGatewayStatus(runtime, { timeout: "1000", json: true });
    } finally {
      if (previousProbeImpl) {
        (probeGatewayFn as MockFn<typeof realProbeGateway>).mockImplementation(previousProbeImpl);
      } else {
        (probeGatewayFn as MockFn<typeof realProbeGateway>).mockReset();
      }
    }

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      targets?: Array<Record<string, unknown>>;
    };
    const configRemoteTarget = parsed.targets?.find((target) => target.kind === "configRemote");
    expect(configRemoteTarget?.config).toMatchInlineSnapshot(`
      {
        "discovery": {
          "wideAreaEnabled": true,
        },
        "exists": true,
        "gateway": {
          "authMode": "token",
          "authPasswordConfigured": true,
          "authTokenConfigured": true,
          "bind": null,
          "controlUiBasePath": null,
          "controlUiEnabled": null,
          "mode": "remote",
          "port": null,
          "remotePasswordConfigured": true,
          "remoteTokenConfigured": true,
          "remoteUrl": "wss://remote.example:18789",
          "tailscaleMode": null,
        },
        "issues": [],
        "legacyIssues": [],
        "path": "/tmp/secretref-config.json",
        "valid": true,
      }
    `);
  });

  it("supports SSH tunnel targets", async () => {
    const { runtime, runtimeLogs } = createRuntimeCapture();

    (
      startSshPortForwardFn as unknown as MockFn<typeof sshTunnelModule.startSshPortForward>
    ).mockClear();
    sshStop.mockClear();
    (probeGatewayFn as MockFn<typeof realProbeGateway>).mockClear();

    await runGatewayStatus(runtime, { timeout: "1000", json: true, ssh: "me@studio" });

    expect(startSshPortForwardFn).toHaveBeenCalledTimes(1);
    expect(probeGatewayFn).toHaveBeenCalled();
    const tunnelCall = (probeGatewayFn as MockFn<typeof realProbeGateway>).mock.calls.find(
      (call) => typeof call?.[0]?.url === "string" && call[0].url.startsWith("ws://127.0.0.1:"),
    )?.[0] as { auth?: { token?: string } } | undefined;
    expect(tunnelCall?.auth?.token).toBe("rtok");
    expect(sshStop).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(runtimeLogs.join("\n")) as Record<string, unknown>;
    const targets = parsed.targets as Array<Record<string, unknown>>;
    expect(targets.some((t) => t.kind === "sshTunnel")).toBe(true);
  });

  it("passes the full caller timeout through to local loopback probes", async () => {
    const { runtime } = createRuntimeCapture();
    (probeGatewayFn as MockFn<typeof realProbeGateway>).mockClear();
    (readBestEffortConfig as MockFn<typeof realReadBestEffortConfig>).mockResolvedValueOnce({
      gateway: {
        mode: "local",
        auth: { mode: "token", token: "ltok" },
      },
    } as never);

    await runGatewayStatus(runtime, { timeout: "15000", json: true });

    expect(probeGatewayFn).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        timeoutMs: 15_000,
      }),
    );
  });

  it("keeps inactive local loopback probes on the short timeout in remote mode", async () => {
    const { runtime } = createRuntimeCapture();
    (probeGatewayFn as MockFn<typeof realProbeGateway>).mockClear();
    (readBestEffortConfig as MockFn<typeof realReadBestEffortConfig>).mockResolvedValueOnce({
      gateway: {
        mode: "remote",
        auth: { mode: "token", token: "ltok" },
        remote: {},
      },
    } as never);

    await runGatewayStatus(runtime, { timeout: "15000", json: true });

    expect(probeGatewayFn).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        timeoutMs: 800,
      }),
    );
  });

  it("does not infer ssh-auto targets from TXT-only discovery metadata", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "steipete" }, async () => {
      (readBestEffortConfig as MockFn<typeof realReadBestEffortConfig>).mockResolvedValueOnce(
        makeRemoteGatewayConfig("", "", "ltok") as never,
      );
      (discoverGatewayBeaconsFn as MockFn<typeof realDiscoverGatewayBeacons>).mockResolvedValueOnce(
        [
          { instanceName: "bad", tailnetDns: "-V" },
          { instanceName: "txt-only", tailnetDns: "goodhost" },
        ],
      );

      (
        startSshPortForwardFn as unknown as MockFn<typeof sshTunnelModule.startSshPortForward>
      ).mockClear();
      await runGatewayStatus(runtime, { timeout: "1000", json: true, sshAuto: true });

      expect(startSshPortForwardFn).not.toHaveBeenCalled();
    });
  });

  it("infers ssh-auto targets from resolved discovery hosts", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "steipete" }, async () => {
      (readBestEffortConfig as MockFn<typeof realReadBestEffortConfig>).mockResolvedValueOnce(
        makeRemoteGatewayConfig("", "", "ltok") as never,
      );
      (discoverGatewayBeaconsFn as MockFn<typeof realDiscoverGatewayBeacons>).mockResolvedValueOnce(
        [
          { instanceName: "bad", tailnetDns: "-V" },
          { host: "goodhost", sshPort: 2222, port: 18789, instanceName: "Gateway" },
        ],
      );

      (
        startSshPortForwardFn as unknown as MockFn<typeof sshTunnelModule.startSshPortForward>
      ).mockClear();
      await runGatewayStatus(runtime, { timeout: "1000", json: true, sshAuto: true });

      expect(startSshPortForwardFn).toHaveBeenCalledTimes(1);
      const call = (
        startSshPortForwardFn as unknown as MockFn<typeof sshTunnelModule.startSshPortForward>
      ).mock.calls[0]?.[0] as { target: string };
      expect(call.target).toBe("steipete@goodhost:2222");
    });
  });

  it("infers SSH target from gateway.remote.url and ssh config", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "steipete" }, async () => {
      (readBestEffortConfig as MockFn<typeof realReadBestEffortConfig>).mockResolvedValueOnce(
        makeRemoteGatewayConfig("ws://peters-mac-studio-1.sheep-coho.ts.net:18789") as never,
      );
      (
        resolveSshConfigFn as unknown as MockFn<typeof sshConfigModule.resolveSshConfig>
      ).mockResolvedValueOnce({
        user: "steipete",
        host: "peters-mac-studio-1.sheep-coho.ts.net",
        port: 2222,
        identityFiles: ["/tmp/id_ed25519"],
      });

      (
        startSshPortForwardFn as unknown as MockFn<typeof sshTunnelModule.startSshPortForward>
      ).mockClear();
      await runGatewayStatus(runtime, { timeout: "1000", json: true });

      expect(startSshPortForwardFn).toHaveBeenCalledTimes(1);
      const call = (
        startSshPortForwardFn as unknown as MockFn<typeof sshTunnelModule.startSshPortForward>
      ).mock.calls[0]?.[0] as {
        target: string;
        identity?: string;
      };
      expect(call.target).toBe("steipete@peters-mac-studio-1.sheep-coho.ts.net:2222");
      expect(call.identity).toBe("/tmp/id_ed25519");
    });
  });

  it("falls back to host-only when USER is missing and ssh config is unavailable", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "" }, async () => {
      (readBestEffortConfig as MockFn<typeof realReadBestEffortConfig>).mockResolvedValueOnce(
        makeRemoteGatewayConfig("wss://studio.example:18789") as never,
      );
      (
        resolveSshConfigFn as unknown as MockFn<typeof sshConfigModule.resolveSshConfig>
      ).mockResolvedValueOnce(null);

      (
        startSshPortForwardFn as unknown as MockFn<typeof sshTunnelModule.startSshPortForward>
      ).mockClear();
      await runGatewayStatus(runtime, { timeout: "1000", json: true });

      const call = (
        startSshPortForwardFn as unknown as MockFn<typeof sshTunnelModule.startSshPortForward>
      ).mock.calls[0]?.[0] as {
        target: string;
      };
      expect(call.target).toBe("studio.example");
    });
  });

  it("keeps explicit SSH identity even when ssh config provides one", async () => {
    const { runtime } = createRuntimeCapture();

    (readBestEffortConfig as MockFn<typeof realReadBestEffortConfig>).mockResolvedValueOnce(
      makeRemoteGatewayConfig("wss://studio.example:18789") as never,
    );
    (
      resolveSshConfigFn as unknown as MockFn<typeof sshConfigModule.resolveSshConfig>
    ).mockResolvedValueOnce({
      user: "me",
      host: "studio.example",
      port: 22,
      identityFiles: ["/tmp/id_from_config"],
    });

    (
      startSshPortForwardFn as unknown as MockFn<typeof sshTunnelModule.startSshPortForward>
    ).mockClear();
    await runGatewayStatus(runtime, {
      timeout: "1000",
      json: true,
      sshIdentity: "/tmp/explicit_id",
    });

    const call = (
      startSshPortForwardFn as unknown as MockFn<typeof sshTunnelModule.startSshPortForward>
    ).mock.calls[0]?.[0] as {
      identity?: string;
    };
    expect(call.identity).toBe("/tmp/explicit_id");
  });
});

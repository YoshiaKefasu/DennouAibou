import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { WEBHOOK_IN_FLIGHT_DEFAULTS } from "openclaw/plugin-sdk/webhook-request-guards";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLineRuntimeState,
  monitorLineProvider,
  resetLineRuntimeStateForTests,
  type MonitorLineProviderDeps,
} from "./monitor.js";

type LineNodeWebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

// Inject the monitor boundaries instead of mocking `./bot.js`, `./webhook-node.js`,
// and `openclaw/plugin-sdk/webhook-ingress` at module level (Bun cannot intercept
// ESM imports).
const createLineBotMock = vi.fn(() => ({
  account: { accountId: "default" },
  handleWebhook: vi.fn(),
}));
let innerLineWebhookHandlerMock: ReturnType<typeof vi.fn<LineNodeWebhookHandler>>;
const createLineNodeWebhookHandlerMock = vi.fn(() => innerLineWebhookHandlerMock);
const registerPluginHttpRouteMock = vi.fn();
const unregisterHttpMock = vi.fn();

const deps: MonitorLineProviderDeps = {
  createLineBot: createLineBotMock as unknown as NonNullable<
    MonitorLineProviderDeps["createLineBot"]
  >,
  createLineNodeWebhookHandler: createLineNodeWebhookHandlerMock as unknown as NonNullable<
    MonitorLineProviderDeps["createLineNodeWebhookHandler"]
  >,
  registerPluginHttpRoute: registerPluginHttpRouteMock as unknown as NonNullable<
    MonitorLineProviderDeps["registerPluginHttpRoute"]
  >,
  logVerbose: (() => {}) as unknown as NonNullable<MonitorLineProviderDeps["logVerbose"]>,
};

describe("monitorLineProvider lifecycle", () => {
  beforeEach(() => {
    resetLineRuntimeStateForTests();
    createLineBotMock.mockReset();
    createLineBotMock.mockReturnValue({
      account: { accountId: "default" },
      handleWebhook: vi.fn(),
    });
    innerLineWebhookHandlerMock = vi.fn<LineNodeWebhookHandler>(async () => {});
    createLineNodeWebhookHandlerMock
      .mockReset()
      .mockImplementation(() => innerLineWebhookHandlerMock);
    unregisterHttpMock.mockReset();
    registerPluginHttpRouteMock.mockReset().mockReturnValue(unregisterHttpMock);
  });

  const createRouteResponse = () => {
    const resObj = {
      statusCode: 0,
      headersSent: false,
      setHeader: vi.fn(),
      end: vi.fn(() => {
        resObj.headersSent = true;
      }),
    };
    return resObj as unknown as ServerResponse & { end: ReturnType<typeof vi.fn> };
  };

  it("waits for abort before resolving", async () => {
    const abort = new AbortController();
    let resolved = false;

    const task = monitorLineProvider(
      {
        channelAccessToken: "token",
        channelSecret: "secret", // pragma: allowlist secret
        config: {} as OpenClawConfig,
        runtime: {} as RuntimeEnv,
        abortSignal: abort.signal,
      },
      deps,
    ).then((monitor) => {
      resolved = true;
      return monitor;
    });

    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(1);
    expect(registerPluginHttpRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({ auth: "plugin" }),
    );
    expect(resolved).toBe(false);

    abort.abort();
    await task;
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("stops immediately when signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();

    await monitorLineProvider(
      {
        channelAccessToken: "token",
        channelSecret: "secret", // pragma: allowlist secret
        config: {} as OpenClawConfig,
        runtime: {} as RuntimeEnv,
        abortSignal: abort.signal,
      },
      deps,
    );

    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("returns immediately without abort signal and stop is idempotent", async () => {
    const monitor = await monitorLineProvider(
      {
        channelAccessToken: "token",
        channelSecret: "secret", // pragma: allowlist secret
        config: {} as OpenClawConfig,
        runtime: {} as RuntimeEnv,
      },
      deps,
    );

    expect(unregisterHttpMock).not.toHaveBeenCalled();
    monitor.stop();
    monitor.stop();
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("records startup state under configured defaultAccount when accountId is omitted", async () => {
    const monitor = await monitorLineProvider(
      {
        channelAccessToken: "token",
        channelSecret: "secret", // pragma: allowlist secret
        config: {
          channels: {
            line: {
              defaultAccount: "work",
              accounts: {
                work: {
                  channelAccessToken: "work-token",
                  channelSecret: "work-secret",
                },
              },
            },
          },
        } as OpenClawConfig,
        runtime: {} as RuntimeEnv,
      },
      deps,
    );

    expect(getLineRuntimeState("work")).toEqual(
      expect.objectContaining({
        running: true,
      }),
    );
    expect(getLineRuntimeState("default")).toBeUndefined();

    monitor.stop();
  });

  it("rejects webhook requests above the shared in-flight limit before body handling", async () => {
    const limit = WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey;
    const releaseRequests: Array<() => void> = [];
    let reachLimit!: () => void;
    const reachedLimit = new Promise<void>((resolve) => {
      reachLimit = resolve;
    });

    innerLineWebhookHandlerMock.mockImplementation(
      async (_req: IncomingMessage, res: ServerResponse) => {
        if (releaseRequests.length === limit - 1) {
          reachLimit();
        }
        await new Promise<void>((resolve) => {
          releaseRequests.push(resolve);
        });
        res.statusCode = 200;
        res.end();
      },
    );

    const monitor = await monitorLineProvider(
      {
        channelAccessToken: "token",
        channelSecret: "secret", // pragma: allowlist secret
        config: {} as OpenClawConfig,
        runtime: {} as RuntimeEnv,
      },
      deps,
    );

    const route = registerPluginHttpRouteMock.mock.calls[0]?.[0] as
      | { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }
      | undefined;
    expect(route).toBeDefined();
    const createPostRequest = () =>
      ({
        method: "POST",
        headers: {},
      }) as IncomingMessage;

    const firstRequests = Array.from({ length: limit }, () =>
      route!.handler(createPostRequest(), createRouteResponse()),
    );
    await reachedLimit;

    const overflowResponse = createRouteResponse();
    await route!.handler(createPostRequest(), overflowResponse);

    expect(innerLineWebhookHandlerMock).toHaveBeenCalledTimes(limit);
    expect(overflowResponse.statusCode).toBe(429);
    expect(overflowResponse.end).toHaveBeenCalledWith("Too Many Requests");

    releaseRequests.splice(0).forEach((release) => release());
    await Promise.all(firstRequests);
    monitor.stop();
  });
});

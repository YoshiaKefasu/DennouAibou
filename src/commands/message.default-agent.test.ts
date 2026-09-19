import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { messageCommand, type MessageCommandOverrides } from "./message.js";

let testConfig: Record<string, unknown> = {};

const resolveCommandSecretRefsViaGateway = vi.fn(async ({ config }: { config: unknown }) => ({
  resolvedConfig: config,
  diagnostics: [] as string[],
}));
const runMessageAction = vi.fn(async () => ({
  kind: "send" as const,
  channel: "telegram" as const,
  action: "send" as const,
  to: "123456",
  handledBy: "core" as const,
  payload: { ok: true },
  dryRun: false,
}));

/**
 * Inject the command-level boundaries instead of mocking `../config/config.js`,
 * `../cli/command-secret-gateway.js`, and the outbound runner at module level.
 */
function createOverrides(): MessageCommandOverrides {
  return {
    loadConfig: () => testConfig as unknown as OpenClawConfig,
    resolveCommandSecretRefsViaGateway:
      resolveCommandSecretRefsViaGateway as unknown as MessageCommandOverrides["resolveCommandSecretRefsViaGateway"],
    runMessageAction: runMessageAction as unknown as MessageCommandOverrides["runMessageAction"],
  };
}

describe("messageCommand agent routing", () => {
  beforeEach(() => {
    testConfig = {};
    resolveCommandSecretRefsViaGateway.mockClear();
    runMessageAction.mockClear();
  });

  it("passes the resolved default agent id to the outbound runner", async () => {
    testConfig = {
      agents: {
        list: [{ id: "alpha" }, { id: "ops", default: true }],
      },
    };

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    await messageCommand(
      {
        action: "send",
        channel: "telegram",
        target: "123456",
        message: "hi",
        json: true,
      },
      {} as CliDeps,
      runtime,
      createOverrides(),
    );

    expect(runMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
      }),
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import { tryHandleRootVersionFastPath, type RootVersionFastPathDeps } from "./entry.js";

function flushAsyncWork(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Inject every boundary the root version fast path touches so the suite does not
 * have to mock `./cli/argv.js`, `./cli/container-target.js`, `./version.js`,
 * `./infra/git-commit.js`, or the entry-point respawn machinery.
 */
function createDeps(overrides: Partial<RootVersionFastPathDeps> = {}): RootVersionFastPathDeps {
  return {
    isRootVersionInvocation: () => true,
    resolveCliContainerTarget: () => null,
    loadVersion: async () => "9.9.9-test",
    loadCommitHash: async () => "abc1234",
    log: () => {},
    exit: () => {},
    ...overrides,
  };
}

describe("entry root version fast path", () => {
  it("prints commit-tagged version output when commit metadata is available", async () => {
    const log = vi.fn();
    const exit = vi.fn();

    const handled = tryHandleRootVersionFastPath(
      ["node", "openclaw", "--version"],
      createDeps({ log, exit }),
    );
    await flushAsyncWork();

    expect(handled).toBe(true);
    expect(log).toHaveBeenCalledWith("OpenClaw 9.9.9-test (abc1234)");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("falls back to plain version output when commit metadata is unavailable", async () => {
    const log = vi.fn();
    const exit = vi.fn();

    tryHandleRootVersionFastPath(
      ["node", "openclaw", "--version"],
      createDeps({ log, exit, loadCommitHash: async () => null }),
    );
    await flushAsyncWork();

    expect(log).toHaveBeenCalledWith("OpenClaw 9.9.9-test");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("skips the host version fast path when a container target is active", async () => {
    const log = vi.fn();
    const exit = vi.fn();

    const handled = tryHandleRootVersionFastPath(
      ["node", "openclaw", "--version"],
      createDeps({ log, exit, resolveCliContainerTarget: () => "demo" }),
    );
    await flushAsyncWork();

    expect(handled).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("still skips the fast path for a container target when gateway override env vars are set", async () => {
    const originalGatewayToken = process.env.DENNOU_GATEWAY_TOKEN;
    process.env.DENNOU_GATEWAY_TOKEN = "demo-token";
    const log = vi.fn();
    const onError = vi.fn();

    try {
      const handled = tryHandleRootVersionFastPath(
        ["node", "openclaw", "--version"],
        createDeps({ log, onError, resolveCliContainerTarget: () => "demo" }),
      );
      await flushAsyncWork();

      expect(handled).toBe(false);
      expect(log).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      if (originalGatewayToken === undefined) {
        delete process.env.DENNOU_GATEWAY_TOKEN;
      } else {
        process.env.DENNOU_GATEWAY_TOKEN = originalGatewayToken;
      }
    }
  });

  it("does not handle invocations that are not the root version flag", async () => {
    const log = vi.fn();

    const handled = tryHandleRootVersionFastPath(
      ["node", "openclaw", "status"],
      createDeps({ log, isRootVersionInvocation: () => false }),
    );
    await flushAsyncWork();

    expect(handled).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("routes version resolution failures through the error handler", async () => {
    const onError = vi.fn();

    tryHandleRootVersionFastPath(
      ["node", "openclaw", "--version"],
      createDeps({
        onError,
        loadCommitHash: async () => {
          throw new Error("boom");
        },
      }),
    );
    await flushAsyncWork();

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

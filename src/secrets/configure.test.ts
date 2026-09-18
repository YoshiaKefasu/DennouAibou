import { describe, expect, it, vi } from "vitest";
import type { createSecretsConfigIO } from "./config-io.js";
import { runSecretsConfigureInteractive, type SecretsConfigureDeps } from "./configure.js";

describe("runSecretsConfigureInteractive", () => {
  it("does not load auth-profiles when running providers-only", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    const readJsonObjectIfExistsMock = vi.fn(() => ({
      error: "boom",
      value: null,
    }));
    const createSecretsConfigIOMock = vi.fn(() => ({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: {
          valid: true,
          config: {},
          resolved: {},
        },
      }),
    }));
    const selectMock = vi.fn(async () => "continue");

    await expect(
      runSecretsConfigureInteractive(
        { providersOnly: true },
        {
          createSecretsConfigIO:
            createSecretsConfigIOMock as unknown as typeof createSecretsConfigIO,
          readJsonObjectIfExists: readJsonObjectIfExistsMock,
          prompts: {
            select: selectMock as unknown as NonNullable<SecretsConfigureDeps["prompts"]>["select"],
          },
        },
      ),
    ).rejects.toThrow("No secrets changes were selected.");
    expect(readJsonObjectIfExistsMock).not.toHaveBeenCalled();
    expect(createSecretsConfigIOMock).toHaveBeenCalledTimes(1);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createMachineDisplayNameResolver } from "./machine-name.js";

describe("getMachineDisplayName", () => {
  it.each([
    {
      name: "uses the hostname fallback in test mode and strips a trimmed .local suffix",
      hostname: "  clawbox.LOCAL  ",
      expected: "clawbox",
      repeatLookup: true,
    },
    {
      name: "falls back to the default product name when hostname is blank",
      hostname: "   ",
      expected: "openclaw",
      repeatLookup: false,
    },
  ])("$name", async ({ hostname, expected, repeatLookup }) => {
    const hostnameMock = vi.fn(() => hostname);
    const runScutil = vi.fn();
    const getMachineDisplayName = createMachineDisplayNameResolver({
      env: { NODE_ENV: "test" },
      hostname: hostnameMock,
      runScutil,
    });

    await expect(getMachineDisplayName()).resolves.toBe(expected);
    if (repeatLookup) {
      await expect(getMachineDisplayName()).resolves.toBe(expected);
    }
    expect(hostnameMock).toHaveBeenCalledTimes(1);
    expect(runScutil).not.toHaveBeenCalled();
  });

  it("uses the macOS computer name before the local host name", async () => {
    const runScutil = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "Computer Name" })
      .mockResolvedValueOnce({ stdout: "Local Host Name" });
    const getMachineDisplayName = createMachineDisplayNameResolver({
      env: {},
      platform: "darwin",
      hostname: () => "fallback",
      runScutil,
    });

    await expect(getMachineDisplayName()).resolves.toBe("Computer Name");
    expect(runScutil).toHaveBeenCalledTimes(1);
    expect(runScutil).toHaveBeenCalledWith("ComputerName");
  });

  it("uses the macOS local host name when the computer name is unavailable", async () => {
    const runScutil = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "   " })
      .mockResolvedValueOnce({ stdout: "Local Host Name" });
    const getMachineDisplayName = createMachineDisplayNameResolver({
      env: {},
      platform: "darwin",
      hostname: () => "fallback",
      runScutil,
    });

    await expect(getMachineDisplayName()).resolves.toBe("Local Host Name");
    expect(runScutil).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from "vitest";
import { resolveOsSummary } from "./os-summary.js";

type OsSummaryCase = {
  name: string;
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  swVersStdout?: string;
  expected: ReturnType<typeof resolveOsSummary>;
};

describe("resolveOsSummary", () => {
  it.each<OsSummaryCase>([
    {
      name: "formats darwin labels from sw_vers output",
      platform: "darwin",
      release: "24.0.0",
      arch: "arm64",
      swVersStdout: " 15.4 \n",
      expected: {
        platform: "darwin",
        arch: "arm64",
        release: "24.0.0",
        label: "macos 15.4 (arm64)",
      },
    },
    {
      name: "falls back to os.release when sw_vers output is blank",
      platform: "darwin",
      release: "24.1.0",
      arch: "x64",
      swVersStdout: "   ",
      expected: {
        platform: "darwin",
        arch: "x64",
        release: "24.1.0",
        label: "macos 24.1.0 (x64)",
      },
    },
    {
      name: "formats windows labels from os metadata",
      platform: "win32",
      release: "10.0.26100",
      arch: "x64",
      expected: {
        platform: "win32",
        arch: "x64",
        release: "10.0.26100",
        label: "windows 10.0.26100 (x64)",
      },
    },
    {
      name: "formats non-darwin labels from os metadata",
      platform: "linux",
      release: "10.0.26100",
      arch: "x64",
      expected: {
        platform: "linux",
        arch: "x64",
        release: "10.0.26100",
        label: "linux 10.0.26100 (x64)",
      },
    },
  ])("$name", ({ platform, release, arch, swVersStdout, expected }) => {
    const spawnSync = vi.fn().mockReturnValue({
      stdout: swVersStdout ?? "",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });

    expect(
      resolveOsSummary({
        platform: () => platform,
        release: () => release,
        arch: () => arch,
        spawnSync,
      }),
    ).toEqual(expected);
    if (platform === "darwin") {
      expect(spawnSync).toHaveBeenCalledWith("sw_vers", ["-productVersion"], {
        encoding: "utf-8",
      });
    } else {
      expect(spawnSync).not.toHaveBeenCalled();
    }
  });
});

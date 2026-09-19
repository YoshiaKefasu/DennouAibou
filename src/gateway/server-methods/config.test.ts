import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configHandlers,
  resolveConfigOpenCommand,
  setConfigOpenFileRunnerForTests,
} from "./config.js";
import { createConfigHandlerHarness } from "./config.test-helpers.js";

describe("resolveConfigOpenCommand", () => {
  it("uses open on macOS", () => {
    expect(resolveConfigOpenCommand("/tmp/dennou-aibou.json", "darwin")).toEqual({
      command: "open",
      args: ["/tmp/dennou-aibou.json"],
    });
  });

  it("uses xdg-open on Linux", () => {
    expect(resolveConfigOpenCommand("/tmp/dennou-aibou.json", "linux")).toEqual({
      command: "xdg-open",
      args: ["/tmp/dennou-aibou.json"],
    });
  });

  it("uses a quoted PowerShell literal on Windows", () => {
    expect(resolveConfigOpenCommand(String.raw`C:\tmp\o'hai & calc.json`, "win32")).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        String.raw`Start-Process -LiteralPath 'C:\tmp\o''hai & calc.json'`,
      ],
    });
  });
});

describe("config.openFile", () => {
  afterEach(() => {
    delete process.env.DENNOU_CONFIG_PATH;
    setConfigOpenFileRunnerForTests(undefined);
    vi.clearAllMocks();
  });

  it("opens the configured file without shell interpolation", async () => {
    const configPath = "/tmp/config $(touch pwned).json";
    process.env.DENNOU_CONFIG_PATH = configPath;
    const openFileRunner = vi.fn(async () => {});
    setConfigOpenFileRunnerForTests(openFileRunner);

    const { options, respond } = createConfigHandlerHarness({ method: "config.openFile" });
    await configHandlers["config.openFile"](options);

    const [okArg, payload] = respond.mock.calls[0] as [boolean, { ok: boolean; path: string }];
    expect(okArg).toBe(true);
    expect(payload.ok).toBe(true);
    // The runner receives the platform-specific opener with the resolved path as a
    // single argument, so shell metacharacters stay data and are never evaluated.
    const expected = resolveConfigOpenCommand(payload.path);
    expect(openFileRunner).toHaveBeenCalledTimes(1);
    expect(openFileRunner).toHaveBeenCalledWith(expected.command, expected.args);
    expect(expected.args.join(" ")).toContain("$(touch pwned)");
  });

  it("returns a generic error and logs details when the opener fails", async () => {
    process.env.DENNOU_CONFIG_PATH = "/tmp/config.json";
    setConfigOpenFileRunnerForTests(async () => {
      throw Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" });
    });

    const { options, respond, logGateway } = createConfigHandlerHarness({
      method: "config.openFile",
    });
    await configHandlers["config.openFile"](options);

    const [okArg, payload] = respond.mock.calls[0] as [
      boolean,
      { ok: boolean; path: string; error?: string },
    ];
    expect(okArg).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.path).toContain("config.json");
    expect(payload.error).toBe("failed to open config file");
    expect(logGateway.warn).toHaveBeenCalledWith(expect.stringContaining("spawn xdg-open ENOENT"));
  });
});

import { describe, expect, it, vi } from "vitest";
import { createWslDetector } from "./wsl.js";

function createLinuxDetector(overrides: Parameters<typeof createWslDetector>[0] = {}) {
  return createWslDetector({ platform: "linux", env: {}, ...overrides });
}

describe("wsl detection", () => {
  it.each([
    ["WSL_DISTRO_NAME", "Ubuntu"],
    ["WSL_INTEROP", "/run/WSL/123_interop"],
    ["WSLENV", "PATH/l"],
  ])("detects WSL from %s", (key, value) => {
    const detector = createLinuxDetector({ env: { [key]: value } });
    expect(detector.isWSLEnv()).toBe(true);
  });

  it("reads /proc/version for sync WSL detection when env vars are absent", () => {
    const readFileSync = vi.fn(() => "Linux version 6.6.0-1-microsoft-standard-WSL2");
    const detector = createLinuxDetector({ readFileSync });

    expect(detector.isWSLSync()).toBe(true);
    expect(readFileSync).toHaveBeenCalledWith("/proc/version", "utf8");
  });

  it("returns false when sync detection cannot read /proc/version", () => {
    const readFileSync = vi.fn(() => {
      throw new Error("ENOENT");
    });
    const detector = createLinuxDetector({ readFileSync });

    expect(detector.isWSLSync()).toBe(false);
  });

  it.each(["Linux version 6.6.0-1-microsoft-standard-WSL2", "Linux version 6.6.0-1-wsl2"])(
    "detects WSL2 sync from kernel version: %s",
    (kernelVersion) => {
      const readFileSync = vi.fn(() => kernelVersion);
      const detector = createLinuxDetector({ readFileSync });

      expect(detector.isWSL2Sync()).toBe(true);
    },
  );

  it("returns false for WSL2 sync when WSL is detected but no WSL2 markers exist", () => {
    const readFileSync = vi.fn(() => "Linux version 4.4.0-19041-Microsoft");
    const detector = createLinuxDetector({ readFileSync });

    expect(detector.isWSL2Sync()).toBe(false);
  });

  it("returns false for sync detection on non-linux platforms", () => {
    const readFileSync = vi.fn();
    const detector = createWslDetector({ platform: "darwin", env: {}, readFileSync });

    expect(detector.isWSLSync()).toBe(false);
    expect(detector.isWSL2Sync()).toBe(false);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("caches async WSL detection until reset", async () => {
    const readFile = vi.fn(async () => "6.6.0-1-microsoft-standard-WSL2");
    const detector = createLinuxDetector({ readFile });

    await expect(detector.isWSL()).resolves.toBe(true);
    await expect(detector.isWSL()).resolves.toBe(true);

    expect(readFile).toHaveBeenCalledTimes(1);

    detector.resetWSLStateForTests();
    await expect(detector.isWSL()).resolves.toBe(true);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("short-circuits async detection from WSL env vars without reading osrelease", async () => {
    const readFile = vi.fn();
    const detector = createLinuxDetector({ env: { WSL_DISTRO_NAME: "Ubuntu" }, readFile });

    await expect(detector.isWSL()).resolves.toBe(true);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("returns false when async WSL detection cannot read osrelease", async () => {
    const readFile = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    const detector = createLinuxDetector({ readFile });

    await expect(detector.isWSL()).resolves.toBe(false);
  });

  it("returns false for async detection on non-linux platforms without reading osrelease", async () => {
    const readFile = vi.fn();
    const detector = createWslDetector({ platform: "win32", env: {}, readFile });

    await expect(detector.isWSL()).resolves.toBe(false);
    expect(readFile).not.toHaveBeenCalled();
  });
});

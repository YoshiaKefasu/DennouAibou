import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLogger,
  getResolvedLoggerSettings,
  resetLogger,
  setLoggerOverride,
} from "../logging.js";

const DEFAULT_MAX_FILE_BYTES = 500 * 1024 * 1024;

describe("log file size cap", () => {
  let logPath = "";
  let logDir = "";

  beforeEach(() => {
    logDir = path.join(os.tmpdir(), `openclaw-log-cap-${crypto.randomUUID()}`);
    logPath = path.join(logDir, "openclaw.log");
    resetLogger();
    setLoggerOverride(null);
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.restoreAllMocks();
    try {
      fs.rmSync(logDir, { force: true, recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("defaults maxFileBytes to 500 MB when unset", () => {
    setLoggerOverride({ level: "info", file: logPath });
    expect(getResolvedLoggerSettings().maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
  });

  it("uses configured maxFileBytes", () => {
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 2048 });
    expect(getResolvedLoggerSettings().maxFileBytes).toBe(2048);
  });

  it("suppresses file writes after cap is reached and warns once", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      () => true as unknown as ReturnType<typeof process.stderr.write>, // preserve stream contract in test spy
    );
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 1024 });
    const logger = getLogger();

    for (let i = 0; i < 200; i++) {
      logger.error(`network-failure-${i}-${"x".repeat(80)}`);
    }
    const sizeAfterCap = fs.statSync(logPath).size;
    for (let i = 0; i < 20; i++) {
      logger.error(`post-cap-${i}-${"y".repeat(80)}`);
    }
    const sizeAfterExtraLogs = fs.statSync(logPath).size;

    expect(sizeAfterExtraLogs).toBe(sizeAfterCap);
    expect(sizeAfterCap).toBeLessThanOrEqual(1024 + 512);
    const capWarnings = stderrSpy.mock.calls
      .map(([firstArg]) => String(firstArg))
      .filter((line) => line.includes("log file size cap reached"));
    expect(capWarnings).toHaveLength(1);
  });

  it("writes rolling logs to the current date after midnight", () => {
    vi.useFakeTimers();
    // Use times deep within each local day to avoid timezone boundary issues:
    // formatLocalDate uses getFullYear/getMonth/getDate (local-time), so UTC
    // timestamps near midnight may shift to a different local date on JST/etc.
    const firstDay = path.join(logDir, "openclaw-2026-04-29.log");
    const secondDay = path.join(logDir, "openclaw-2026-04-30.log");

    vi.setSystemTime(new Date("2026-04-29T12:00:00.000Z"));
    setLoggerOverride({ level: "info", file: firstDay });
    const logger = getLogger();
    logger.info("before-midnight");

    vi.setSystemTime(new Date("2026-04-30T12:00:00.000Z"));
    logger.info("after-midnight");

    expect(fs.readFileSync(firstDay, "utf8")).toContain("before-midnight");
    expect(fs.readFileSync(firstDay, "utf8")).not.toContain("after-midnight");
    expect(fs.readFileSync(secondDay, "utf8")).toContain("after-midnight");
  });
});

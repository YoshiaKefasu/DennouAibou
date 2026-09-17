import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getResolvedLoggerSettings,
  resetLogger,
  setLoggerConfigDepsForTests,
  setLoggerOverride,
} from "../logging.js";

const readLoggingConfigMock = vi.fn(() => undefined);
const shouldSkipMutatingLoggingConfigReadMock = vi.fn(() => false);
const fallbackConfigLoaderMock = vi.fn(() => {
  throw new Error("config fallback should not be used in this test");
});

let originalTestFileLog: string | undefined;
let originalOpenClawLogLevel: string | undefined;

/**
 * Bun does not set `VITEST` in the process env, so the settings resolver is
 * given an explicit env that matches the default Vitest test environment.
 */
function resolveSettings() {
  return getResolvedLoggerSettings({ ...process.env, VITEST: "true" });
}

beforeEach(() => {
  originalTestFileLog = process.env.DENNOU_TEST_FILE_LOG;
  originalOpenClawLogLevel = process.env.DENNOU_LOG_LEVEL;
  delete process.env.DENNOU_TEST_FILE_LOG;
  delete process.env.DENNOU_LOG_LEVEL;
  readLoggingConfigMock.mockClear();
  shouldSkipMutatingLoggingConfigReadMock.mockReset();
  shouldSkipMutatingLoggingConfigReadMock.mockReturnValue(false);
  fallbackConfigLoaderMock.mockClear();
  resetLogger();
  setLoggerOverride(null);
  setLoggerConfigDepsForTests({
    readLoggingConfig: readLoggingConfigMock,
    shouldSkipMutatingLoggingConfigRead: shouldSkipMutatingLoggingConfigReadMock,
    loadConfigFallback: fallbackConfigLoaderMock,
  });
});

afterEach(() => {
  if (originalTestFileLog === undefined) {
    delete process.env.DENNOU_TEST_FILE_LOG;
  } else {
    process.env.DENNOU_TEST_FILE_LOG = originalTestFileLog;
  }
  if (originalOpenClawLogLevel === undefined) {
    delete process.env.DENNOU_LOG_LEVEL;
  } else {
    process.env.DENNOU_LOG_LEVEL = originalOpenClawLogLevel;
  }
  resetLogger();
  setLoggerOverride(null);
  setLoggerConfigDepsForTests();
});

describe("getResolvedLoggerSettings", () => {
  it("uses a silent fast path in default Vitest mode without config reads", () => {
    const settings = resolveSettings();
    expect(settings.level).toBe("silent");
    expect(readLoggingConfigMock).not.toHaveBeenCalled();
    expect(fallbackConfigLoaderMock).not.toHaveBeenCalled();
  });

  it("reads logging config when test file logging is explicitly enabled", () => {
    process.env.DENNOU_TEST_FILE_LOG = "1";
    const settings = resolveSettings();
    expect(settings.level).toBe("info");
  });

  it("skips fallback config loads for config schema", () => {
    process.env.DENNOU_TEST_FILE_LOG = "1";
    shouldSkipMutatingLoggingConfigReadMock.mockReturnValue(true);

    const settings = resolveSettings();

    expect(settings.level).toBe("info");
    expect(fallbackConfigLoaderMock).not.toHaveBeenCalled();
  });
});

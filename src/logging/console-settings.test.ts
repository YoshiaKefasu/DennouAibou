import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logging from "../logging.js";
import * as state from "./state.js";
import { captureConsoleSnapshot, type ConsoleSnapshot } from "./test-helpers/console-snapshot.js";

const shouldSkipMutatingLoggingConfigReadMock = vi.fn(() => false);
const readLoggingConfigMock = vi.fn(() => undefined);
const noopLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};
const noopLoggerMock = vi.fn(() => noopLogger);

let loadConfigCalls = 0;
let originalIsTty: boolean | undefined;
let originalOpenClawTestConsole: string | undefined;
let snapshot: ConsoleSnapshot;

beforeEach(() => {
  loadConfigCalls = 0;
  shouldSkipMutatingLoggingConfigReadMock.mockReset();
  shouldSkipMutatingLoggingConfigReadMock.mockReturnValue(false);
  readLoggingConfigMock.mockClear();
  noopLoggerMock.mockClear();
  logging.setConsoleConfigReadForTests({
    readLoggingConfig: readLoggingConfigMock,
    shouldSkipMutatingLoggingConfigRead: shouldSkipMutatingLoggingConfigReadMock,
  });
  logging.setConsoleLoggerFactoryForTests(
    noopLoggerMock as unknown as () => ReturnType<typeof logging.getLogger>,
  );
  snapshot = captureConsoleSnapshot();
  originalIsTty = process.stdout.isTTY;
  originalOpenClawTestConsole = process.env.DENNOU_TEST_CONSOLE;
  process.env.DENNOU_TEST_CONSOLE = "1";
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
  console.log = snapshot.log;
  console.info = snapshot.info;
  console.warn = snapshot.warn;
  console.error = snapshot.error;
  console.debug = snapshot.debug;
  console.trace = snapshot.trace;
  if (originalOpenClawTestConsole === undefined) {
    delete process.env.DENNOU_TEST_CONSOLE;
  } else {
    process.env.DENNOU_TEST_CONSOLE = originalOpenClawTestConsole;
  }
  Object.defineProperty(process.stdout, "isTTY", { value: originalIsTty, configurable: true });
  logging.setConsoleConfigLoaderForTests();
  logging.setConsoleConfigReadForTests();
  logging.setConsoleLoggerFactoryForTests();
  vi.restoreAllMocks();
});

function loadLogging() {
  state.loggingState.cachedConsoleSettings = null;
  logging.setConsoleConfigLoaderForTests(() => {
    loadConfigCalls += 1;
    if (loadConfigCalls > 5) {
      return {};
    }
    console.error("config load failed");
    return {};
  });
  return { logging, state };
}

describe("getConsoleSettings", () => {
  it("does not recurse when loadConfig logs during resolution", () => {
    const { logging } = loadLogging();
    logging.setConsoleTimestampPrefix(true);
    logging.enableConsoleCapture();
    const { getConsoleSettings } = logging;
    getConsoleSettings();
    expect(loadConfigCalls).toBe(1);
  });

  it("skips config fallback during re-entrant resolution", () => {
    const { logging, state } = loadLogging();
    state.loggingState.resolvingConsoleSettings = true;
    logging.setConsoleTimestampPrefix(true);
    logging.enableConsoleCapture();
    logging.getConsoleSettings();
    expect(loadConfigCalls).toBe(0);
    state.loggingState.resolvingConsoleSettings = false;
  });
});

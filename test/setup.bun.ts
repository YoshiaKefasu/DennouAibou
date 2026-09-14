import { afterEach, setDefaultTimeout } from "bun:test";
import { installTestMockCleanup } from "../src/test-utils/bun-test-mocks.ts";

// Keep Bun's per-test timeout aligned with vitest's `testTimeout` (120s).
//
// This lives here rather than in bunfig.toml because Bun 1.4.0 silently ignores
// the `[test] timeout` key (only the `--timeout` CLI flag is honored), so the
// timeout has to be set programmatically.
setDefaultTimeout(120_000);
installTestMockCleanup(afterEach);

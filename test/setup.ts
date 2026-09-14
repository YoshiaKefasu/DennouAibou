import { afterEach } from "vitest";
import { installTestMockCleanup } from "../src/test-utils/bun-test-mocks.js";
import "./setup.shared.js";

installTestMockCleanup(afterEach);

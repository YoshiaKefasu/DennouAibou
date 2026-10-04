import { defineConfig } from "vitest/config";

// Node-only tests for pure logic (no Playwright/browser dependency).
export default defineConfig({
  test: {
    isolate: true,
    // Note: root Vitest configs were removed (DEBLOAT §35, bun test一本化).
    // `resolveDefaultVitestPool()` always returned "threads".
    pool: "threads",
    testTimeout: 120_000,
    include: ["src/**/*.node.test.ts"],
    environment: "node",
  },
});

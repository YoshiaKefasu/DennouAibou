import { defineConfig, defineProject } from "vitest/config";

// Note: root Vitest configs were removed (DEBLOAT §35, bun test一本化).
// `pool` was `resolveDefaultVitestPool()` which always returned "threads".
const sharedUiTestConfig = {
  isolate: true,
  pool: "threads",
} as const;

export default defineConfig({
  test: {
    ...sharedUiTestConfig,
    projects: [
      defineProject({
        test: {
          ...sharedUiTestConfig,
          deps: {
            optimizer: {
              web: {
                enabled: true,
                include: ["lit", "lit-html", "@lit/reactive-element", "marked"] as string[],
              },
            },
          },
          name: "unit-node",
          include: ["src/**/*.node.test.ts"],
          environment: "jsdom",
          setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
        },
      }),
    ],
  },
});

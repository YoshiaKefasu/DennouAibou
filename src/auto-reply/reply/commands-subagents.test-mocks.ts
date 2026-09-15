import { vi } from "vitest";

vi.mock("../../config/config.js", async () => {
  const actual = await import("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

export function installSubagentsCommandCoreMocks() {}

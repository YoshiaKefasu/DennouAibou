import { vi } from "vitest";

// Avoid dynamic-importing heavy readability deps in unit test suites.
vi.mock("../../../src/agents/tools/web-fetch-utils.js", async () => {
  const actual = await import("../../../src/agents/tools/web-fetch-utils.js");
  return {
    ...actual,
    extractReadableContent: vi.fn().mockResolvedValue({
      title: "HTML Page",
      text: "HTML Page\n\nContent here.",
    }),
  };
});

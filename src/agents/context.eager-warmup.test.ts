import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetContextWindowCacheForTest, runContextEagerWarmup } from "./context.js";

describe("agents/context eager warmup", () => {
  beforeEach(() => {
    resetContextWindowCacheForTest();
  });

  it.each([
    ["models", ["node", "openclaw", "models", "set", "openai/gpt-5.4"]],
    ["agent", ["node", "openclaw", "agent", "--message", "ok"]],
  ])("does not eager-load config for %s commands on import", (_label, argv) => {
    const loadConfig = vi.fn(() => {
      throw new Error("eager warmup must not load config for this command");
    });

    const warmed = runContextEagerWarmup(argv, { loadConfig });

    expect(warmed).toBe(false);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("eager-loads config for CLI commands that need the warm context cache", () => {
    const loadConfig = vi.fn(() => {
      throw new Error("config is unavailable in this unit test");
    });

    const warmed = runContextEagerWarmup(["node", "openclaw", "chat"], { loadConfig });

    expect(warmed).toBe(true);
    expect(loadConfig).toHaveBeenCalledTimes(1);
  });
});

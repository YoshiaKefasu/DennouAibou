import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

import { getDennouConfig } from "./config.js";

describe("getDennouConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns defaults when dennou config is absent", () => {
    mocks.getRuntimeConfig.mockReturnValue({});

    const config = getDennouConfig();

    expect(config.toolsPrune.keepLastAssistants).toBe(3);
    expect(config.sessionToolsPrune.enabled).toBe(false);
    expect(config.activeSessionToolsPrune.enabled).toBe(true);
    expect(config.activeSessionToolsPrune.minPrunableToolChars).toBe(1200);
    expect(config.activeSessionToolsPrune.keepLastAssistants).toBe(3);
    expect(config.activeSessionToolsPrune.dryRun).toBe(true);
  });

  it("applies shared toolsPrune settings to both closed and active prune configs", () => {
    mocks.getRuntimeConfig.mockReturnValue({
      dennou: {
        toolsPrune: {
          minPrunableToolChars: 2400,
          keepLastAssistants: 7,
          dryRun: false,
        },
      },
    });

    const config = getDennouConfig();

    expect(config.sessionToolsPrune.minPrunableToolChars).toBe(2400);
    expect(config.sessionToolsPrune.keepLastAssistants).toBe(7);
    expect(config.sessionToolsPrune.dryRun).toBe(false);
    expect(config.activeSessionToolsPrune.minPrunableToolChars).toBe(2400);
    expect(config.activeSessionToolsPrune.keepLastAssistants).toBe(7);
    expect(config.activeSessionToolsPrune.dryRun).toBe(false);
  });

  it("lets mode-specific settings override shared toolsPrune settings", () => {
    mocks.getRuntimeConfig.mockReturnValue({
      dennou: {
        toolsPrune: {
          keepLastAssistants: 7,
          dryRun: false,
        },
        activeSessionToolsPrune: {
          keepLastAssistants: 12,
          dryRun: true,
        },
      },
    });

    const config = getDennouConfig();

    expect(config.sessionToolsPrune.keepLastAssistants).toBe(7);
    expect(config.sessionToolsPrune.dryRun).toBe(false);
    expect(config.activeSessionToolsPrune.keepLastAssistants).toBe(12);
    expect(config.activeSessionToolsPrune.dryRun).toBe(true);
  });

  it("does not accept resolvedWorkspacePaths from dennou-aibou.json", () => {
    mocks.getRuntimeConfig.mockReturnValue({
      dennou: {
        pruneProtection: {
          protectedContentKeywords: ["AGENTS.md"],
          resolvedWorkspacePaths: ["/tmp/should-not-stick"],
        },
      },
    });

    const config = getDennouConfig();

    expect(config.pruneProtection.protectedContentKeywords).toEqual(["AGENTS.md"]);
    expect(config.pruneProtection.resolvedWorkspacePaths).toEqual([]);
  });
});

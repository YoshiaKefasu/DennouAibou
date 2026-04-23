import { describe, expect, it, vi } from "vitest";
import {
  MIN_PROMPT_BUDGET_RATIO,
  MIN_PROMPT_BUDGET_TOKENS,
} from "./pi-compaction-constants.js";
import {
  applyPiCompactionSettingsFromConfig,
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  resolveCompactionReserveTokensFloor,
} from "./pi-settings.js";

describe("applyPiCompactionSettingsFromConfig", () => {
  it("bumps reserveTokens when below floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({ settingsManager });

    expect(result.didOverride).toBe(true);
    expect(result.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });

  it("can restore reserveTokens after a simulated resource loader reload drops them below floor", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: { reserveTokensFloor: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR },
        },
      },
    } as const;
    let reserve = 16_384;
    const keep = 20_000;
    const settingsManager = {
      getCompactionReserveTokens: () => reserve,
      getCompactionKeepRecentTokens: () => keep,
      applyOverrides: vi.fn((overrides: { compaction: { reserveTokens?: number } }) => {
        if (overrides.compaction.reserveTokens !== undefined) {
          reserve = overrides.compaction.reserveTokens;
        }
      }),
    };

    const first = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg,
      contextTokenBudget: 100_000,
    });
    expect(first.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);

    reserve = 16_384;
    const second = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg,
      contextTokenBudget: 100_000,
    });
    expect(second.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(reserve).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
  });

  it("does not override when already above floor and not in safeguard mode", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 32_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "default" } } } },
    });

    expect(result.didOverride).toBe(false);
    expect(result.compaction.reserveTokens).toBe(32_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("applies explicit reserveTokens but still enforces floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 10_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: { reserveTokens: 12_000, reserveTokensFloor: 20_000 },
          },
        },
      },
    });

    expect(result.compaction.reserveTokens).toBe(20_000);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 20_000 },
    });
  });

  it("applies keepRecentTokens when explicitly configured", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: {
              keepRecentTokens: 15_000,
            },
          },
        },
      },
    });

    expect(result.compaction.keepRecentTokens).toBe(15_000);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { keepRecentTokens: 15_000 },
    });
  });

  it("preserves current keepRecentTokens when safeguard mode leaves it unset", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 25_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "safeguard" } } } },
    });

    expect(result.compaction.keepRecentTokens).toBe(20_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("treats keepRecentTokens=0 as invalid and keeps the current setting", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 25_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "safeguard", keepRecentTokens: 0 } } } },
    });

    expect(result.compaction.keepRecentTokens).toBe(20_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("caps floor to context window ratio for small-context models", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 16_384,
    });

    expect(result.compaction.reserveTokens).toBe(16_384);
    expect(result.compaction.reserveTokens).toBeLessThan(
      DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
    );
    expect(result.didOverride).toBe(false);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("applies capped floor over user-configured reserveTokens when default floor exceeds context window", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: { reserveTokens: 2_048 },
          },
        },
      },
      contextTokenBudget: 16_384,
    });

    expect(result.didOverride).toBe(true);
    expect(result.compaction.reserveTokens).toBe(8_384);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 8_384 },
    });
  });

  it("applies capped floor when current reserve is below it on small-context models", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 4_096,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 16_384,
    });

    const minPromptBudget = Math.min(
      MIN_PROMPT_BUDGET_TOKENS,
      Math.max(1, Math.floor(16_384 * MIN_PROMPT_BUDGET_RATIO)),
    );
    const expectedReserve = Math.max(0, 16_384 - minPromptBudget);
    expect(result.didOverride).toBe(true);
    expect(result.compaction.reserveTokens).toBe(expectedReserve);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: expectedReserve },
    });
  });

  it("respects user-configured reserveTokens below capped floor for small models", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: { reserveTokens: 2_048, reserveTokensFloor: 0 },
          },
        },
      },
      contextTokenBudget: 16_384,
    });

    expect(result.compaction.reserveTokens).toBe(2_048);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 2_048 },
    });
  });

  it("does not cap floor for mid-size models when maxReserve exceeds default floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 32_768,
    });

    expect(result.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });

  it("does not cap floor when context window is large enough", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 200_000,
    });

    expect(result.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });

  it("falls back to uncapped floor when contextTokenBudget is not provided", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({ settingsManager });

    expect(result.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
  });
});

describe("resolveCompactionReserveTokensFloor", () => {
  it("returns the default when config is missing", () => {
    expect(resolveCompactionReserveTokensFloor()).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
  });

  it("accepts configured floors, including zero", () => {
    expect(
      resolveCompactionReserveTokensFloor({
        agents: { defaults: { compaction: { reserveTokensFloor: 24_000 } } },
      }),
    ).toBe(24_000);
    expect(
      resolveCompactionReserveTokensFloor({
        agents: { defaults: { compaction: { reserveTokensFloor: 0 } } },
      }),
    ).toBe(0);
  });
});

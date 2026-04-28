import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema DennouAibou config", () => {
  it("accepts shared and mode-specific prune settings", () => {
    expect(() =>
      OpenClawSchema.parse({
        dennou: {
          toolsPrune: {
            minPrunableToolChars: 1200,
            keepLastTools: 5,
            placeholder: "[tool output pruned]",
            dryRun: true,
          },
          sessionToolsPrune: {
            enabled: false,
          },
          activeSessionToolsPrune: {
            enabled: true,
            idleDelayMinutes: 30,
            keepLastTools: 10,
          },
          pruneProtection: {
            protectedContentKeywords: ["AGENTS.md", "SOUL.md", "DENNOU_RULES"],
          },
        },
      }),
    ).not.toThrow();
  });

  it("allows advanced users to set all per-mode prune keys", () => {
    expect(() =>
      OpenClawSchema.parse({
        dennou: {
          sessionToolsPrune: {
            enabled: true,
            minPrunableToolChars: 1500,
            keepLastTools: 6,
            placeholder: "[closed pruned]",
            dryRun: false,
          },
          activeSessionToolsPrune: {
            enabled: true,
            idleDelayMinutes: 15,
            minPrunableToolChars: 2000,
            keepLastTools: 12,
            placeholder: "[active pruned]",
            dryRun: true,
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects unknown DennouAibou keys", () => {
    expect(() =>
      OpenClawSchema.parse({
        dennou: {
          nope: true,
        },
      }),
    ).toThrow(/nope|unrecognized/i);
  });
});

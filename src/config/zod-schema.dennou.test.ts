import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema DennouAibou config", () => {
  it("accepts shared and mode-specific prune settings", () => {
    expect(() =>
      OpenClawSchema.parse({
        dennou: {
          toolsPrune: {
            minPrunableToolChars: 1200,
            keepLastAssistants: 3,
            placeholder: "[tool output pruned]",
            dryRun: true,
          },
          sessionToolsPrune: {
            enabled: false,
          },
          activeSessionToolsPrune: {
            enabled: true,
            idleDelayMinutes: 30,
            keepLastAssistants: 3,
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
            keepLastAssistants: 2,
            placeholder: "[closed pruned]",
            dryRun: false,
          },
          activeSessionToolsPrune: {
            enabled: true,
            idleDelayMinutes: 15,
            minPrunableToolChars: 2000,
            keepLastAssistants: 4,
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

  it("accepts deprecated keepLastTools for backward compatibility", () => {
    expect(() =>
      OpenClawSchema.parse({
        dennou: {
          toolsPrune: {
            keepLastTools: 5,
          },
        },
      }),
    ).not.toThrow();
  });
});

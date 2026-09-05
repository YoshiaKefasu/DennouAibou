import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema session reset (deprecated, accepted for backward compat)", () => {
  it("accepts session.reset.mode=off", () => {
    expect(() =>
      OpenClawSchema.parse({
        session: {
          reset: {
            mode: "off",
            atHour: 4,
            idleMinutes: 120,
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts session.reset.mode=daily (no runtime effect)", () => {
    expect(() =>
      OpenClawSchema.parse({
        session: {
          reset: { mode: "daily", atHour: 4 },
        },
      }),
    ).not.toThrow();
  });

  it("accepts session.reset.mode=idle (no runtime effect)", () => {
    expect(() =>
      OpenClawSchema.parse({
        session: {
          reset: { mode: "idle", idleMinutes: 60 },
        },
      }),
    ).not.toThrow();
  });

  it("accepts session.resetByType / resetByChannel / resetTriggers / idleMinutes (no runtime effect)", () => {
    expect(() =>
      OpenClawSchema.parse({
        session: {
          idleMinutes: 60,
          resetTriggers: ["/new", "/reset"],
          resetByType: {
            direct: { mode: "daily", atHour: 4 },
            thread: { mode: "idle", idleMinutes: 180 },
          },
          resetByChannel: {
            discord: { mode: "idle", idleMinutes: 10080 },
          },
        },
      }),
    ).not.toThrow();
  });
});

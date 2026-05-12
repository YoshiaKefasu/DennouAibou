import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema session reset", () => {
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
});

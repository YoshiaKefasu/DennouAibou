import { describe, expect, it } from "vitest";
import { resolveAttemptPrependSystemContext } from "./attempt.prompt-helpers.js";

describe("resolveAttemptPrependSystemContext", () => {
  it("passes through the hook system context", () => {
    const result = resolveAttemptPrependSystemContext({
      sessionKey: "agent:main:discord:direct:123",
      trigger: "user",
      hookPrependSystemContext: "Hook system context",
    });

    expect(result).toBe("Hook system context");
  });

  it("returns undefined without hook system context", () => {
    const result = resolveAttemptPrependSystemContext({
      sessionKey: "agent:main:discord:direct:123",
      trigger: "heartbeat",
    });

    expect(result).toBeUndefined();
  });
});

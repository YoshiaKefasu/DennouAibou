import { describe, expect, it, vi } from "vitest";

const info = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({ info })),
}));

import { logSessionCheckin } from "./session-gatekeeper.js";

describe("logSessionCheckin", () => {
  it("writes the structured check-in fields to the gateway log", () => {
    logSessionCheckin({
      actor: "attempt",
      action: "append",
      op: "op-123",
      lines: 2,
      sessionId: "agent:main:main",
      detail: "source=prompt",
    });

    expect(info).toHaveBeenCalledWith(
      "[session:checkin] actor=attempt action=append op=op-123 lines=2 " +
        "sessionId=agent:main:main detail=source=prompt",
    );
  });

  it("does not throw when the gateway logger fails", () => {
    info.mockImplementationOnce(() => {
      throw new Error("logger unavailable");
    });

    expect(
      logSessionCheckin({
        actor: "unknown",
        action: "rewrite",
        op: "op-456",
        lines: 0,
        sessionId: "session-1",
      }),
    ).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const info = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({ info })),
}));

import {
  logSessionCheckin,
  requestSessionWrite,
  resetSessionWriteOpsForTest,
} from "./session-gatekeeper.js";

function validRequest(op = `test-op-${Date.now()}-${Math.random()}`) {
  return {
    actor: "attempt" as const,
    action: "append" as const,
    op,
    sessionId: "agent:main:main",
    targetLines: "1",
    reason: "persist inbound prompt message",
  };
}

beforeEach(() => {
  info.mockClear();
  resetSessionWriteOpsForTest();
});

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

describe("requestSessionWrite", () => {
  it("rejects a request with a missing required field", () => {
    const request = validRequest();
    delete (request as Partial<typeof request>).reason;

    expect(requestSessionWrite(request)).toEqual({
      granted: false,
      reason: "missing-or-ambiguous-field",
    });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("result=rejected"));
  });

  it("rejects an actor outside the allowlist", () => {
    const request = { ...validRequest(), actor: "intruder" } as never;

    expect(requestSessionWrite(request)).toEqual({
      granted: false,
      reason: "unknown-actor",
    });
  });

  it("rejects reuse of an operation id", () => {
    const request = validRequest();

    expect(requestSessionWrite(request)).toEqual({ granted: true, op: request.op });
    expect(requestSessionWrite(request)).toEqual({ granted: false, reason: "op-reused" });
  });

  it("approves a complete allowlisted request and records pre-authorization", () => {
    const request = validRequest();

    expect(requestSessionWrite(request)).toEqual({ granted: true, op: request.op });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(
        `[session:preauth] actor=attempt action=append op=${request.op} ` +
          "targetLines=1 sessionId=agent:main:main result=granted",
      ),
    );
  });

  it("resets consumed operation ids for isolated tests", () => {
    const request = validRequest("resettable-op");

    expect(requestSessionWrite(request)).toEqual({ granted: true, op: request.op });
    resetSessionWriteOpsForTest();
    expect(requestSessionWrite(request)).toEqual({ granted: true, op: request.op });
  });

  it("bounds operation ids and evicts the least recently used entry", () => {
    const first = validRequest("lru-first");
    expect(requestSessionWrite(first)).toEqual({ granted: true, op: first.op });

    for (let index = 0; index < 4_095; index++) {
      expect(requestSessionWrite(validRequest(`lru-fill-${index}`))).toEqual({
        granted: true,
        op: `lru-fill-${index}`,
      });
    }

    expect(requestSessionWrite(first)).toEqual({ granted: false, reason: "op-reused" });
    expect(requestSessionWrite(validRequest("lru-overflow"))).toEqual({
      granted: true,
      op: "lru-overflow",
    });
    expect(requestSessionWrite(validRequest("lru-fill-0"))).toEqual({
      granted: true,
      op: "lru-fill-0",
    });
  });
});

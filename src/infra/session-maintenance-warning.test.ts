import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  deliverSessionMaintenanceWarning,
  type SessionMaintenanceWarningDeps,
} from "./session-maintenance-warning.js";

type Deps = SessionMaintenanceWarningDeps;

const deliveryContextFromSession = vi.fn<NonNullable<Deps["deliveryContextFromSession"]>>();
const normalizeMessageChannel = vi.fn<NonNullable<Deps["normalizeMessageChannel"]>>();
const isDeliverableMessageChannel = vi.fn<NonNullable<Deps["isDeliverableMessageChannel"]>>();
const deliverOutboundPayloads = vi.fn<NonNullable<Deps["deliverOutboundPayloads"]>>();
const enqueueSystemEvent = vi.fn<NonNullable<Deps["enqueueSystemEvent"]>>();

const deps: Deps = {
  deliveryContextFromSession,
  normalizeMessageChannel,
  isDeliverableMessageChannel,
  deliverOutboundPayloads,
  enqueueSystemEvent,
};

function createParams(
  overrides: Partial<Parameters<typeof deliverSessionMaintenanceWarning>[0]> = {},
): Parameters<typeof deliverSessionMaintenanceWarning>[0] {
  const sessionKey = overrides.sessionKey ?? `agent:${randomUUID()}:main`;
  return {
    cfg: {},
    sessionKey,
    entry: {} as never,
    warning: {
      activeSessionKey: sessionKey,
      pruneAfterMs: 1_000,
      maxEntries: 100,
      wouldPrune: true,
      wouldCap: false,
      ...(overrides.warning as object),
    } as never,
    ...overrides,
  };
}

describe("deliverSessionMaintenanceWarning", () => {
  let prevVitest: string | undefined;
  let prevNodeEnv: string | undefined;

  beforeEach(() => {
    prevVitest = process.env.VITEST;
    prevNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    __testing.resetSessionMaintenanceWarningForTests();

    deliveryContextFromSession.mockReset();
    deliveryContextFromSession.mockReturnValue({
      channel: "whatsapp",
      to: "+15550001",
      accountId: "acct-1",
      threadId: "thread-1",
    });
    normalizeMessageChannel.mockReset();
    normalizeMessageChannel.mockImplementation((channel) => channel ?? undefined);
    isDeliverableMessageChannel.mockReset();
    isDeliverableMessageChannel.mockReturnValue(true);
    deliverOutboundPayloads.mockReset();
    deliverOutboundPayloads.mockResolvedValue([]);
    enqueueSystemEvent.mockReset();
  });

  afterEach(() => {
    if (prevVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = prevVitest;
    }
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it("forwards session context to outbound delivery", async () => {
    const params = createParams({ sessionKey: "agent:main:main" });

    await deliverSessionMaintenanceWarning(params, deps);

    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        to: "+15550001",
        session: { key: "agent:main:main", agentId: "main" },
      }),
    );
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("suppresses duplicate warning contexts for the same session", async () => {
    const params = createParams();

    await deliverSessionMaintenanceWarning(params, deps);
    await deliverSessionMaintenanceWarning(params, deps);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("falls back to a system event when the last target is not deliverable", async () => {
    deliveryContextFromSession.mockReturnValueOnce({
      channel: "debug",
      to: "+15550001",
      accountId: "acct-1",
      threadId: "thread-1",
    });
    isDeliverableMessageChannel.mockReturnValueOnce(false);

    await deliverSessionMaintenanceWarning(
      createParams({
        warning: {
          pruneAfterMs: 3_600_000,
          maxEntries: 10,
          wouldPrune: false,
          wouldCap: true,
        } as never,
      }),
      deps,
    );

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("most recent 10 sessions"),
      expect.objectContaining({ sessionKey: expect.stringContaining("agent:") }),
    );
  });

  it("skips warning delivery in test mode", async () => {
    process.env.NODE_ENV = "test";

    await deliverSessionMaintenanceWarning(createParams(), deps);

    expect(deliveryContextFromSession).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("enqueues a system event when outbound delivery fails", async () => {
    deliverOutboundPayloads.mockRejectedValueOnce(new Error("boom"));

    await deliverSessionMaintenanceWarning(createParams(), deps);

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("older than 1 second"),
      expect.objectContaining({ sessionKey: expect.stringContaining("agent:") }),
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  shouldEnqueueCronMainSummary,
  shouldSkipHeartbeatOnlyDelivery,
} from "./heartbeat-policy.js";

describe("shouldSkipHeartbeatOnlyDelivery", () => {
  it("skips empty payloads", () => {
    expect(shouldSkipHeartbeatOnlyDelivery([], 300)).toBe(true);
  });

  it("skips pure HEARTBEAT_OK payload", () => {
    expect(
      shouldSkipHeartbeatOnlyDelivery(
        [
          {
            text: "HEARTBEAT_OK",
          },
        ],
        300,
      ),
    ).toBe(true);
  });

  it("does not skip payload with actual content", () => {
    expect(
      shouldSkipHeartbeatOnlyDelivery(
        [
          {
            text: "Important reminder alert!",
          },
        ],
        300,
      ),
    ).toBe(false);
  });
});

describe("shouldEnqueueCronMainSummary", () => {
  it("enqueues summary when delivery was requested and not delivered", () => {
    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "Reminder fired",
        deliveryRequested: true,
        delivered: false,
        deliveryAttempted: false,
        suppressMainSummary: false,
        isCronSystemEvent: () => true,
      }),
    ).toBe(true);
  });

  it("suppresses when delivered", () => {
    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "Reminder fired",
        deliveryRequested: true,
        delivered: true,
        deliveryAttempted: true,
        suppressMainSummary: false,
        isCronSystemEvent: () => true,
      }),
    ).toBe(false);
  });
});

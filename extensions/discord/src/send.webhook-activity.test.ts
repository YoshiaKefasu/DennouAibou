import { describe, expect, it, vi } from "vitest";
import { sendWebhookMessageDiscord } from "./send.outbound.js";

describe("sendWebhookMessageDiscord activity", () => {
  it("records outbound channel activity for webhook sends", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ id: "msg-1", channel_id: "thread-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const recordActivity = vi.fn();
    const cfg = {
      channels: {
        discord: {
          token: "resolved-token",
        },
      },
    };
    const result = await sendWebhookMessageDiscord("hello world", {
      cfg,
      webhookId: "wh-1",
      webhookToken: "tok-1",
      accountId: "runtime",
      threadId: "thread-1",
      fetchImpl,
      recordActivity,
    });

    expect(result).toEqual({
      messageId: "msg-1",
      channelId: "thread-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(recordActivity).toHaveBeenCalledWith({
      channel: "discord",
      accountId: "runtime",
      direction: "outbound",
    });
  });
});

import { messagingApi } from "@line/bot-sdk";
import { withTimeout } from "openclaw/plugin-sdk/text-runtime";
import type { LineProbeResult } from "./types.js";

type MessagingApiClientInstance = InstanceType<typeof messagingApi.MessagingApiClient>;

/**
 * Optional call-time seams for the LINE bot probe.
 * Unspecified fields fall back to the real implementation at call time.
 */
export type LineProbeDeps = {
  createMessagingClient?: (params: {
    channelAccessToken: string;
  }) => Pick<MessagingApiClientInstance, "getBotInfo">;
};

function createDefaultMessagingClient(params: { channelAccessToken: string }) {
  return new messagingApi.MessagingApiClient(params);
}

export async function probeLineBot(
  channelAccessToken: string,
  timeoutMs = 5000,
  deps?: LineProbeDeps,
): Promise<LineProbeResult> {
  if (!channelAccessToken?.trim()) {
    return { ok: false, error: "Channel access token not configured" };
  }

  const createMessagingClient = deps?.createMessagingClient ?? createDefaultMessagingClient;
  const client = createMessagingClient({
    channelAccessToken: channelAccessToken.trim(),
  });

  try {
    const profile = await withTimeout(client.getBotInfo(), timeoutMs);

    return {
      ok: true,
      bot: {
        displayName: profile.displayName,
        userId: profile.userId,
        basicId: profile.basicId,
        pictureUrl: profile.pictureUrl,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

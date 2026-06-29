import { resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import type { OpenClawConfig } from "../config/config.js";
import { readSessionUpdatedAt, resolveStorePath } from "../config/sessions.js";
import { temporalMarkerPrefix } from "../infra/format-time/temporal-marker.js";

export function resolveInboundSessionEnvelopeContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  timestamp?: number | Date;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: params.sessionKey,
  });

  // Compute the temporal marker prefix from the same timestamps used for
  // elapsed display. The marker is prepended before the envelope text so the
  // model can detect meaningful conversational gaps.
  let marker: string | undefined;
  if (previousTimestamp && params.timestamp) {
    const currentMs =
      params.timestamp instanceof Date ? params.timestamp.getTime() : params.timestamp;
    const previousMs = previousTimestamp;
    const elapsedMs = currentMs - previousMs;
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
      const gapSeconds = elapsedMs / 1000;
      marker = temporalMarkerPrefix(gapSeconds) ?? undefined;
    }
  }

  return {
    storePath,
    envelopeOptions: resolveEnvelopeFormatOptions(params.cfg),
    previousTimestamp,
    temporalMarkerPrefix: marker,
  };
}

/**
 * Temporal marker formatting utilities for DennouAibou.
 *
 * Mirrors the magic-context temporal-awareness marker pattern: prepend a tiny
 * HTML comment before the inbound user message when the gap since the previous
 * message exceeds the threshold. The marker is deterministic from stored
 * timestamps (cache-safe) and only emitted for meaningful pauses.
 *
 * Threshold rules:
 *   < 5 min   → null (no marker)
 *   5m .. 1h  → "+Xm"          (e.g. "+12m")
 *   1h .. 1d  → "+Xh Ym" / "+Xh" when Y == 0
 *   1d .. 1w  → "+Xd Yh" / "+Xd" when Y == 0
 *   >= 1w     → "+Xw Yd" / "+Xw" when Y == 0
 */

/** User message gaps below this threshold get no marker. 5 minutes. */
export const TEMPORAL_MARKER_THRESHOLD_SECONDS = 300;

/** Seconds per unit for gap formatting. */
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * 60;
const SECONDS_PER_DAY = 24 * 60 * 60;
const SECONDS_PER_WEEK = 7 * 24 * 60 * 60;

/**
 * Format a gap in seconds as a compact adaptive string.
 * Returns null for gaps below the threshold (no marker should be injected).
 *
 * Examples:
 *   formatGap(600)   → "+10m"
 *   formatGap(4500)  → "+1h 15m"
 *   formatGap(90000) → "+1d 1h"
 *   formatGap(1296000) → "+2w 1d"
 *   formatGap(120)   → null (below 5 min threshold)
 */
export function formatGap(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < TEMPORAL_MARKER_THRESHOLD_SECONDS) {
    return null;
  }

  if (seconds < SECONDS_PER_HOUR) {
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
    return `+${minutes}m`;
  }

  if (seconds < SECONDS_PER_DAY) {
    const hours = Math.floor(seconds / SECONDS_PER_HOUR);
    const minutes = Math.floor((seconds - hours * SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    return minutes === 0 ? `+${hours}h` : `+${hours}h ${minutes}m`;
  }

  if (seconds < SECONDS_PER_WEEK) {
    const days = Math.floor(seconds / SECONDS_PER_DAY);
    const hours = Math.floor((seconds - days * SECONDS_PER_DAY) / SECONDS_PER_HOUR);
    return hours === 0 ? `+${days}d` : `+${days}d ${hours}h`;
  }

  const weeks = Math.floor(seconds / SECONDS_PER_WEEK);
  const days = Math.floor((seconds - weeks * SECONDS_PER_WEEK) / SECONDS_PER_DAY);
  return days === 0 ? `+${weeks}w` : `+${weeks}w ${days}d`;
}

/**
 * Produce the HTML comment prefix line for a given gap marker, or null if the
 * gap is below threshold.
 *
 * Example: temporalMarkerPrefix(720) → "<!-- +12m -->\n"
 */
export function temporalMarkerPrefix(seconds: number): string | null {
  const marker = formatGap(seconds);
  if (!marker) return null;
  return `<!-- ${marker} -->\n`;
}

import type { Tone } from "./status.memory-types.js";

export { formatCliCommand } from "../cli/command-format.js";
export { resolveGatewayPort } from "../config/config.js";
export { info } from "../globals.js";
export { resolveControlUiLinks } from "../gateway/control-ui-links.js";
export { formatTimeAgo } from "../infra/format-time/format-relative.ts";
export function resolveMemoryVectorState(vector: { enabled: boolean; available?: boolean }): {
  tone: Tone;
  state: "ready" | "unavailable" | "disabled" | "unknown";
} {
  if (!vector.enabled) {
    return { tone: "muted", state: "disabled" };
  }
  if (vector.available === true) {
    return { tone: "ok", state: "ready" };
  }
  if (vector.available === false) {
    return { tone: "warn", state: "unavailable" };
  }
  return { tone: "muted", state: "unknown" };
}

export function resolveMemoryFtsState(fts: { enabled: boolean; available: boolean }): {
  tone: Tone;
  state: "ready" | "unavailable" | "disabled";
} {
  if (!fts.enabled) {
    return { tone: "muted", state: "disabled" };
  }
  return fts.available ? { tone: "ok", state: "ready" } : { tone: "warn", state: "unavailable" };
}

export function resolveMemoryCacheSummary(cache: { enabled: boolean; entries?: number }): {
  tone: Tone;
  text: string;
} {
  if (!cache.enabled) {
    return { tone: "muted", text: "cache off" };
  }
  const suffix = typeof cache.entries === "number" ? ` (${cache.entries})` : "";
  return { tone: "ok", text: `cache on${suffix}` };
}
export {
  formatPluginCompatibilityNotice,
  summarizePluginCompatibility,
} from "../plugins/status.js";
export { getTerminalTableWidth, renderTable } from "../terminal/table.js";
export { theme } from "../terminal/theme.js";
export { formatHealthChannelLines } from "./health.js";
export { groupChannelIssuesByChannel } from "./status-all/channel-issues.js";
export { formatGatewayAuthUsed } from "./status-all/format.js";
export {
  formatDuration,
  formatKTokens,
  formatPromptCacheCompact,
  formatTokensCompact,
  shortenText,
} from "./status.format.js";

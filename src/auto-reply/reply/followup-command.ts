import { normalizeCommandBody, type CommandNormalizeOptions } from "../commands-registry.js";

const FOLLOWUP_COMMAND_RE = /^\/followup(?::|\s|$)/i;

export function isFollowupRequestText(text?: string, options?: CommandNormalizeOptions): boolean {
  if (!text) {
    return false;
  }
  const normalized = normalizeCommandBody(text, options).trim();
  return FOLLOWUP_COMMAND_RE.test(normalized);
}

export function extractFollowupMessage(
  text?: string,
  options?: CommandNormalizeOptions,
): string | null {
  if (!text) {
    return null;
  }
  const normalized = normalizeCommandBody(text, options).trim();
  const match = normalized.match(/^\/followup(?::|\s+|$)([\s\S]*)$/i);
  if (!match) {
    return null;
  }
  return (match[1] ?? "").trim();
}

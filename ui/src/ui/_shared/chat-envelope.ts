/**
 * UI-local mirror of `src/shared/chat-envelope.ts`.
 *
 * Pure string parser — no Node-only dependencies. Kept here so the UI does
 * not need to import from `src/`, which would pull the entire Node layer
 * (and its transitive `process.env` / `node:os` references) into the
 * browser bundle.
 *
 * Source of truth: `src/shared/chat-envelope.ts` (HEAD).
 */
const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;

const ENVELOPE_CHANNELS = [
  "WebChat",
  "WhatsApp",
  "Telegram",
  "Signal",
  "Slack",
  "Discord",
  "Google Chat",
  "iMessage",
  "Teams",
  "Matrix",
  "Zalo",
  "Zalo Personal",
  "BlueBubbles",
];

const MESSAGE_ID_LINE = /^\s*\[message_id:\s*[^\]]+\]\s*$/i;

function looksLikeEnvelopeHeader(header: string): boolean {
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(header)) {
    return true;
  }
  if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(header)) {
    return true;
  }
  return ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `));
}

export function stripEnvelope(text: string): string {
  const match = text.match(ENVELOPE_PREFIX);
  if (!match) {
    return text;
  }
  const header = match[1] ?? "";
  if (!looksLikeEnvelopeHeader(header)) {
    return text;
  }
  return text.slice(match[0].length);
}

export function stripMessageIdLine(text: string): string {
  return text
    .split("\n")
    .filter((line) => !MESSAGE_ID_LINE.test(line))
    .join("\n");
}

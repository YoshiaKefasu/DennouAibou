export { buildTelegramModelsProviderChannelData } from "../../../extensions/telegram/contract-api.js";

/** Normalize a WhatsApp target (phone or group JID) to a canonical lowercase form. */
export function normalizeWhatsAppTarget(raw: string): string | null {
  const trimmed = raw.trim().replace(/^whatsapp:/i, "").trim();
  if (!trimmed) {
    return null;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.endsWith("@g.us")) {
    const normalized = lowered.replace(/\s+/gu, "");
    return /^\d+@g\.us$/u.test(normalized) ? normalized : null;
  }
  const digits = trimmed.replace(/\D/gu, "");
  const normalized = digits ? `+${digits}` : "";
  return /^\+\d{7,15}$/u.test(normalized) ? normalized : null;
}

/** Check if a normalized WhatsApp target is a group JID. */
export function isWhatsAppGroupJid(target: string): boolean {
  return target.toLowerCase().endsWith("@g.us");
}

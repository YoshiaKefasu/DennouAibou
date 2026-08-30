/**
 * UI-local mirror of `src/gateway/device-metadata-normalization.ts`.
 *
 * Source of truth: `src/gateway/device-metadata-normalization.ts` (HEAD).
 */
function normalizeTrimmedMetadata(value?: string | null): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : "";
}

function toLowerAscii(input: string): string {
  return input.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

export function normalizeDeviceMetadataForAuth(value?: string | null): string {
  const trimmed = normalizeTrimmedMetadata(value);
  if (!trimmed) {
    return "";
  }
  return toLowerAscii(trimmed);
}

export function normalizeDeviceMetadataForPolicy(value?: string | null): string {
  const trimmed = normalizeTrimmedMetadata(value);
  if (!trimmed) {
    return "";
  }
  return trimmed.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

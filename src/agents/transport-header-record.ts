import type { ProviderHeaders } from "@earendil-works/pi-ai";

/**
 * Normalize SDK ProviderHeaders (Record<string, string | null>) to
 * Record<string, string>. Null entries are dropped. Undefined passes through.
 */
export function toHeaderRecord(
  headers: ProviderHeaders | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== null) {
      out[key] = value;
    }
  }
  return out;
}

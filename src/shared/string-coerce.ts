// このファイルは OpenClaw v2026.4.8 (commit 01dc9792fc 他12件のrefactor dedupe) から抽出。
// 上流の refactor dedupe コミット群を除外した cherry-pick の依存関係として
// コミット 4bf5d84b13 (heartbeat-system-prompt.ts) が要求する normalizeOptionalString 等を提供する。
// 将来ベースを上げる際は上流の src/shared/string-coerce.ts で置き換えること。

export function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  return normalizeNullableString(value) ?? undefined;
}

export function normalizeStringifiedOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOptionalString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return normalizeOptionalString(String(value));
  }
  return undefined;
}

export function normalizeOptionalLowercaseString(value: unknown): string | undefined {
  return normalizeOptionalString(value)?.toLowerCase();
}

export function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

export function lowercasePreservingWhitespace(value: string): string {
  return value.toLowerCase();
}

export function localeLowercasePreservingWhitespace(value: string): string {
  return value.toLocaleLowerCase();
}

export function resolvePrimaryStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOptionalString(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return normalizeOptionalString((value as { primary?: unknown }).primary);
}

export function normalizeOptionalThreadValue(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : undefined;
  }
  return normalizeOptionalString(value);
}

export function normalizeOptionalStringifiedId(value: unknown): string | undefined {
  const normalized = normalizeOptionalThreadValue(value);
  return normalized == null ? undefined : String(normalized);
}

export function hasNonEmptyString(value: unknown): value is string {
  return normalizeOptionalString(value) !== undefined;
}

/**
 * UI-local mirror of `src/shared/assistant-identity-values.ts`.
 *
 * The function is pure (no Node-only globals) but the upstream file lives
 * in `src/shared/`, and importing it pulls the entire `src/` layer into
 * the control UI bundle — together with its transitive `process.env` /
 * `node:os` references. That re-introduces the `process is not defined`
 * crash this commit series is fixing.
 *
 * Kept semantically identical to upstream. Edit both files together if
 * upstream semantics change.
 *
 * Source of truth: `src/shared/assistant-identity-values.ts` (HEAD).
 */
export function coerceIdentityValue(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength);
}

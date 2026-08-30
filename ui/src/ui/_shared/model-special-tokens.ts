/**
 * UI-local mirror of `src/shared/text/model-special-tokens.ts`.
 *
 * Source of truth: `src/shared/text/model-special-tokens.ts` (HEAD).
 */
import { findCodeRegions, isInsideCode } from "./code-regions.ts";

// Match both ASCII pipe <|...|> and full-width pipe <｜...｜> (U+FF5C) variants.
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;

function overlapsCodeRegion(
  start: number,
  end: number,
  codeRegions: { start: number; end: number }[],
): boolean {
  return codeRegions.some((region) => start < region.end && end > region.start);
}

export function stripModelSpecialTokens(text: string): string {
  if (!text) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  if (!MODEL_SPECIAL_TOKEN_RE.test(text)) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;

  const codeRegions = findCodeRegions(text);
  return text.replace(MODEL_SPECIAL_TOKEN_RE, (match, offset) => {
    const start = offset;
    const end = start + match.length;
    return isInsideCode(start, codeRegions) || overlapsCodeRegion(start, end, codeRegions)
      ? match
      : " ";
  });
}

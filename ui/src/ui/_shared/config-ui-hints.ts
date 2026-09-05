/**
 * UI-local mirror of `src/shared/config-ui-hints-types.ts`.
 *
 * Source of truth: `src/shared/config-ui-hints-types.ts` (HEAD).
 */
export type ConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  group?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  itemTemplate?: unknown;
};

export type ConfigUiHints = Record<string, ConfigUiHint>;

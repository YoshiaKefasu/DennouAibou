/**
 * UI-local mirror of `src/auto-reply/commands-registry.types.ts`.
 *
 * Source of truth: `src/auto-reply/commands-registry.types.ts` (HEAD).
 *
 * Only the types the UI references are mirrored. The UI does not need the
 * full server-side registry validation pipeline — it just renders the
 * command list for the slash-command palette.
 */
export type CommandScope = "text" | "native" | "both";

export type CommandCategory =
  | "session"
  | "options"
  | "status"
  | "management"
  | "media"
  | "tools"
  | "docks";

export type CommandArgType = "string" | "number" | "boolean";

export type CommandArgChoice = string | { value: string; label: string };

export type CommandArgDefinition = {
  name: string;
  description: string;
  type: CommandArgType;
  required?: boolean;
  choices?: CommandArgChoice[];
  preferAutocomplete?: boolean;
  captureRemaining?: boolean;
};

export type ChatCommandDefinition = {
  key: string;
  nativeName?: string;
  description: string;
  textAliases: string[];
  acceptsArgs?: boolean;
  args?: CommandArgDefinition[];
  scope: CommandScope;
  category?: CommandCategory;
};

// Narrow plugin-sdk surface for the bundled llm-task plugin.
// Keep this list additive and scoped to the bundled LLM task surface.
// Note: `supportsXHighThinking` was removed in the thinkingLevelMap migration
// (the map is the single source of truth). Callers should derive support
// from the model's `compat.reasoningEffortMap` instead.

export { definePluginEntry } from "./plugin-entry.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export { formatThinkingLevels, normalizeThinkLevel } from "../auto-reply/thinking.js";
export type { AnyAgentTool, OpenClawPluginApi } from "../plugins/types.js";

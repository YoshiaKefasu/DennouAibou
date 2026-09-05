/**
 * UI-local mirror of `src/agents/tool-policy-shared.ts`.
 *
 * Source of truth: `src/agents/tool-policy-shared.ts` (HEAD).
 *
 * Note: the upstream file imports `CORE_TOOL_GROUPS` and
 * `resolveCoreToolProfilePolicy` from `./tool-catalog.js`. The UI does not
 * exercise the profile policy path (`expandToolGroups` /
 * `resolveToolProfilePolicy`) — `agents-utils.ts` and
 * `agents-panels-tools-skills.ts` only call `normalizeToolName` /
 * `normalizeToolList`. To keep the UI bundle free of any `src/`
 * transitive pull-in, we provide only the symbols the UI uses plus a
 * minimal `TOOL_GROUPS` literal matching the upstream `CORE_TOOL_GROUPS`
 * shape that `expandToolGroups` consumes.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
};

// Minimal mirror of `CORE_TOOL_GROUPS` from `src/agents/tool-catalog.ts`.
// The UI only ever passes known tool ids to `expandToolGroups`, so this
// object intentionally mirrors the upstream shape without the full set of
// definitions. Edit together with upstream.
export const TOOL_GROUPS: Record<string, string[]> = {
  fs: ["read", "write", "edit", "apply_patch"],
  runtime: ["exec", "process", "code_execution"],
  web: ["web_search", "web_fetch"],
  memory: ["memory_search", "memory_get"],
  sessions: [
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "session_status",
  ],
  ui: [],
  messaging: [],
  automation: ["cron"],
  nodes: ["nodes"],
  agents: ["subagents"],
  media: ["media_understand"],
};

export function normalizeToolName(name: string) {
  const normalized = name.trim().toLowerCase();
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
}

export function normalizeToolList(list?: string[]) {
  if (!list) {
    return [];
  }
  return list.map(normalizeToolName).filter(Boolean);
}

export function expandToolGroups(list?: string[]) {
  const normalized = normalizeToolList(list);
  const expanded: string[] = [];
  for (const value of normalized) {
    const group = TOOL_GROUPS[value];
    if (group) {
      expanded.push(...group);
      continue;
    }
    expanded.push(value);
  }
  return Array.from(new Set(expanded));
}

export type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

/**
 * UI-local placeholder for `resolveToolProfilePolicy`.
 *
 * The upstream implementation resolves a profile id to a policy by reading
 * `CORE_TOOL_GROUPS` and `resolveCoreToolProfilePolicy` from
 * `src/agents/tool-catalog.ts`. The UI only uses this to fall back when no
 * policy is configured; we mirror the upstream shape and return `undefined`
 * so the UI's existing fall-through behaviour is preserved without
 * pulling in the rest of the catalog.
 */
export function resolveToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  if (!profile) {
    return undefined;
  }
  // No profile data available; consumers (agents-utils.ts) treat this as
  // "no policy configured" and skip filtering.
  return undefined;
}

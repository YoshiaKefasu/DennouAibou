import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

/** Allow/deny tool policy shared by profile, provider, group, and subagent policies. */
export type ToolPolicy = {
  allow?: string[];
  deny?: string[];
};

function makeToolPolicyMatcher(policy: ToolPolicy) {
  const deny = compileGlobPatterns({
    raw: expandToolGroups(policy.deny ?? []),
    normalize: normalizeToolName,
  });
  const allow = compileGlobPatterns({
    raw: expandToolGroups(policy.allow ?? []),
    normalize: normalizeToolName,
  });
  return (name: string) => {
    const normalized = normalizeToolName(name);
    if (matchesAnyGlobPattern(normalized, deny)) {
      return false;
    }
    if (normalized === "apply_patch" && matchesAnyGlobPattern("write", deny)) {
      return false;
    }
    if (allow.length === 0) {
      return true;
    }
    if (matchesAnyGlobPattern(normalized, allow)) {
      return true;
    }
    if (normalized === "apply_patch" && matchesAnyGlobPattern("write", allow)) {
      return true;
    }
    return false;
  };
}

export function isToolAllowedByPolicyName(name: string, policy?: ToolPolicy): boolean {
  if (!policy) {
    return true;
  }
  return makeToolPolicyMatcher(policy)(name);
}

export function isToolAllowedByPolicies(name: string, policies: Array<ToolPolicy | undefined>) {
  return policies.every((policy) => isToolAllowedByPolicyName(name, policy));
}

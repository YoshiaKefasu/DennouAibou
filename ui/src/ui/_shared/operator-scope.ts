/**
 * UI-local mirror of `src/shared/operator-scope-compat.ts`.
 *
 * The control UI uses these scope predicates to evaluate gateway role /
 * scope combinations when deciding which buttons / actions to enable. The
 * upstream implementation is a pure function (no Node-only globals), but
 * importing it pulls the entire `src/` Node layer into the UI bundle and
 * its transitive `process.env` / `node:os` references re-introduce the
 * `ReferenceError: process is not defined` crash fixed by 0cbd5ad29 and
 * its follow-ups.
 *
 * Kept deliberately identical (semantics, return shape) to the upstream
 * implementation so the UI behaviour matches the gateway exactly. Edit both
 * files together if upstream semantics change.
 *
 * Source of truth: `src/shared/operator-scope-compat.ts` (HEAD).
 */
const OPERATOR_ROLE = "operator";
const OPERATOR_ADMIN_SCOPE = "operator.admin";
const OPERATOR_READ_SCOPE = "operator.read";
const OPERATOR_WRITE_SCOPE = "operator.write";
const OPERATOR_SCOPE_PREFIX = "operator.";

function normalizeScopeList(scopes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed) {
      out.add(trimmed);
    }
  }
  return [...out];
}

function operatorScopeSatisfied(requestedScope: string, granted: Set<string>): boolean {
  if (!requestedScope.startsWith(OPERATOR_SCOPE_PREFIX)) {
    return false;
  }
  if (granted.has(OPERATOR_ADMIN_SCOPE)) {
    return true;
  }
  if (requestedScope === OPERATOR_READ_SCOPE) {
    return granted.has(OPERATOR_READ_SCOPE) || granted.has(OPERATOR_WRITE_SCOPE);
  }
  if (requestedScope === OPERATOR_WRITE_SCOPE) {
    return granted.has(OPERATOR_WRITE_SCOPE);
  }
  return granted.has(requestedScope);
}

export function roleScopesAllow(params: {
  role: string;
  requestedScopes: readonly string[];
  allowedScopes: readonly string[];
}): boolean {
  const requested = normalizeScopeList(params.requestedScopes);
  if (requested.length === 0) {
    return true;
  }
  const allowed = normalizeScopeList(params.allowedScopes);
  if (allowed.length === 0) {
    return false;
  }
  const allowedSet = new Set(allowed);
  if (params.role.trim() !== OPERATOR_ROLE) {
    const prefix = `${params.role.trim()}.`;
    return requested.every((scope) => scope.startsWith(prefix) && allowedSet.has(scope));
  }
  return requested.every((scope) => operatorScopeSatisfied(scope, allowedSet));
}

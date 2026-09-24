import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../agents/internal-runtime-context.js";
import { sanitizeUserFacingText } from "../../agents/pi-embedded-helpers/errors.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import { truncateUtf16Safe } from "../../utils.js";

function truncateTaskStatusText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${truncateUtf16Safe(trimmed, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function stripInlineLeakedInternalContext(value: string): string {
  const beginIndex = value.indexOf(INTERNAL_RUNTIME_CONTEXT_BEGIN);
  if (
    beginIndex !== -1 &&
    (value.includes(INTERNAL_RUNTIME_CONTEXT_END) ||
      value.includes("OpenClaw runtime context (internal):") ||
      value.includes("[Internal task completion event]"))
  ) {
    return value.slice(0, beginIndex);
  }
  const legacyHeaderIndex = value.indexOf("OpenClaw runtime context (internal):");
  if (
    legacyHeaderIndex !== -1 &&
    (value.includes("Keep internal details private.") ||
      value.includes("[Internal task completion event]"))
  ) {
    return value.slice(0, legacyHeaderIndex);
  }
  return value;
}

function sanitizeTaskStatusValue(value: unknown, errorContext: boolean): unknown {
  if (typeof value === "string") {
    const sanitized = sanitizeUserFacingText(stripInlineLeakedInternalContext(value), {
      errorContext,
    })
      .replace(/\s+/g, " ")
      .trim();
    return sanitized || undefined;
  }
  if (Array.isArray(value)) {
    const next = value
      .map((entry) => sanitizeTaskStatusValue(entry, errorContext))
      .filter((entry) => entry !== undefined);
    return next.length > 0 ? next : undefined;
  }
  if (value && typeof value === "object") {
    const nextEntries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, sanitizeTaskStatusValue(entry, errorContext)] as const)
      .filter(([, entry]) => entry !== undefined);
    if (nextEntries.length === 0) {
      return undefined;
    }
    return Object.fromEntries(nextEntries);
  }
  return value;
}

/**
 * Sanitize subagent-facing status text (labels, outcome errors) so leaked
 * internal runtime context never reaches chat output.
 */
export function sanitizeTaskStatusText(
  value: unknown,
  opts?: { errorContext?: boolean; maxChars?: number },
): string {
  const errorContext = opts?.errorContext ?? false;
  const sanitizedValue = sanitizeTaskStatusValue(value, errorContext);
  const raw =
    typeof sanitizedValue === "string"
      ? sanitizedValue
      : sanitizedValue == null
        ? ""
        : (JSON.stringify(sanitizedValue) ?? "");
  const sanitized = raw.replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return "";
  }
  if (typeof opts?.maxChars === "number") {
    return truncateTaskStatusText(sanitized, opts.maxChars);
  }
  return sanitized;
}

export function resolveSubagentLabel(entry: SubagentRunRecord, fallback = "subagent") {
  const raw = entry.label?.trim() || entry.task?.trim() || "";
  return raw || fallback;
}

export function formatRunLabel(entry: SubagentRunRecord, options?: { maxLength?: number }) {
  const raw = sanitizeTaskStatusText(resolveSubagentLabel(entry)) || "subagent";
  const maxLength = options?.maxLength ?? 72;
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return raw;
  }
  return raw.length > maxLength ? `${truncateUtf16Safe(raw, maxLength).trimEnd()}…` : raw;
}

export function formatRunStatus(entry: SubagentRunRecord) {
  if (!entry.endedAt) {
    return "running";
  }
  const status = entry.outcome?.status ?? "done";
  return status === "ok" ? "done" : status;
}

export function sortSubagentRuns(runs: SubagentRunRecord[]) {
  return [...runs].toSorted((a, b) => {
    const aTime = a.startedAt ?? a.createdAt ?? 0;
    const bTime = b.startedAt ?? b.createdAt ?? 0;
    return bTime - aTime;
  });
}

export type SubagentTargetResolution = {
  entry?: SubagentRunRecord;
  error?: string;
};

export function resolveSubagentTargetFromRuns(params: {
  runs: SubagentRunRecord[];
  token: string | undefined;
  recentWindowMinutes: number;
  label: (entry: SubagentRunRecord) => string;
  isActive?: (entry: SubagentRunRecord) => boolean;
  errors: {
    missingTarget: string;
    invalidIndex: (value: string) => string;
    unknownSession: (value: string) => string;
    ambiguousLabel: (value: string) => string;
    ambiguousLabelPrefix: (value: string) => string;
    ambiguousRunIdPrefix: (value: string) => string;
    unknownTarget: (value: string) => string;
  };
}): SubagentTargetResolution {
  const trimmed = params.token?.trim();
  if (!trimmed) {
    return { error: params.errors.missingTarget };
  }
  const sorted = sortSubagentRuns(params.runs);
  const deduped: SubagentRunRecord[] = [];
  const seenChildSessionKeys = new Set<string>();
  for (const entry of sorted) {
    if (seenChildSessionKeys.has(entry.childSessionKey)) {
      continue;
    }
    seenChildSessionKeys.add(entry.childSessionKey);
    deduped.push(entry);
  }
  if (trimmed === "last") {
    return { entry: deduped[0] };
  }
  const isActive = params.isActive ?? ((entry: SubagentRunRecord) => !entry.endedAt);
  const recentCutoff = Date.now() - params.recentWindowMinutes * 60_000;
  const numericOrder = [
    ...deduped.filter((entry) => isActive(entry)),
    ...deduped.filter(
      (entry) => !isActive(entry) && !!entry.endedAt && (entry.endedAt ?? 0) >= recentCutoff,
    ),
  ];
  if (/^\d+$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(idx) || idx <= 0 || idx > numericOrder.length) {
      return { error: params.errors.invalidIndex(trimmed) };
    }
    return { entry: numericOrder[idx - 1] };
  }
  if (trimmed.includes(":")) {
    const bySessionKey = deduped.find((entry) => entry.childSessionKey === trimmed);
    return bySessionKey
      ? { entry: bySessionKey }
      : { error: params.errors.unknownSession(trimmed) };
  }
  const lowered = trimmed.toLowerCase();
  const byExactLabel = deduped.filter((entry) => params.label(entry).toLowerCase() === lowered);
  if (byExactLabel.length === 1) {
    return { entry: byExactLabel[0] };
  }
  if (byExactLabel.length > 1) {
    return { error: params.errors.ambiguousLabel(trimmed) };
  }
  const byLabelPrefix = deduped.filter((entry) =>
    params.label(entry).toLowerCase().startsWith(lowered),
  );
  if (byLabelPrefix.length === 1) {
    return { entry: byLabelPrefix[0] };
  }
  if (byLabelPrefix.length > 1) {
    return { error: params.errors.ambiguousLabelPrefix(trimmed) };
  }
  const byRunIdPrefix = deduped.filter((entry) => entry.runId.startsWith(trimmed));
  if (byRunIdPrefix.length === 1) {
    return { entry: byRunIdPrefix[0] };
  }
  if (byRunIdPrefix.length > 1) {
    return { error: params.errors.ambiguousRunIdPrefix(trimmed) };
  }
  return { error: params.errors.unknownTarget(trimmed) };
}

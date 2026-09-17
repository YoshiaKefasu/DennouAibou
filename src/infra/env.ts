import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";

let log: SubsystemLogger | null = null;
const loggedEnv = new Set<string>();

function getLog(): SubsystemLogger {
  if (!log) {
    log = createSubsystemLogger("env");
  }
  return log;
}

/**
 * Injectable seams for tests.
 *
 * `env` replaces `process.env` and `log` replaces the lazily created subsystem
 * logger so callers can assert behaviour without module mocking.
 */
export type EnvDeps = {
  env?: NodeJS.ProcessEnv;
  log?: Pick<SubsystemLogger, "info">;
};

type AcceptedEnvOption = {
  key: string;
  description: string;
  value?: string;
  redact?: boolean;
};

function formatEnvValue(value: string, redact?: boolean): string {
  if (redact) {
    return "<redacted>";
  }
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 160) {
    return singleLine;
  }
  return `${singleLine.slice(0, 160)}…`;
}

export function logAcceptedEnvOption(option: AcceptedEnvOption, deps: EnvDeps = {}): void {
  const env = deps.env ?? process.env;
  if (env.VITEST || env.NODE_ENV === "test") {
    return;
  }
  if (loggedEnv.has(option.key)) {
    return;
  }
  const rawValue = option.value ?? env[option.key];
  if (!rawValue || !rawValue.trim()) {
    return;
  }
  loggedEnv.add(option.key);
  (deps.log ?? getLog()).info(
    `env: ${option.key}=${formatEnvValue(rawValue, option.redact)} (${option.description})`,
  );
}

export function normalizeZaiEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.ZAI_API_KEY?.trim() && env.Z_AI_API_KEY?.trim()) {
    env.ZAI_API_KEY = env.Z_AI_API_KEY;
  }
}

export function isTruthyEnvValue(value?: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  switch (value.trim().toLowerCase()) {
    case "1":
    case "on":
    case "true":
    case "yes":
      return true;
    default:
      return false;
  }
}

export function normalizeEnv(env: NodeJS.ProcessEnv = process.env): void {
  normalizeZaiEnv(env);
}

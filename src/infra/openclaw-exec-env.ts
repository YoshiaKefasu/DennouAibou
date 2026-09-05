export const DENNOU_CLI_ENV_VAR = "DENNOU_CLI";
export const DENNOU_CLI_ENV_VALUE = "1";

export function markOpenClawExecEnv<T extends Record<string, string | undefined>>(env: T): T {
  return {
    ...env,
    [DENNOU_CLI_ENV_VAR]: DENNOU_CLI_ENV_VALUE,
  };
}

export function ensureOpenClawExecMarkerOnProcess(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[DENNOU_CLI_ENV_VAR] = DENNOU_CLI_ENV_VALUE;
  return env;
}

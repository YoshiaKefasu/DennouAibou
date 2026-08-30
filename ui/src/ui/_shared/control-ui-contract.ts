/**
 * UI-local mirror of `src/gateway/control-ui-contract.ts`.
 *
 * Source of truth: `src/gateway/control-ui-contract.ts` (HEAD).
 */
export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/__dennou/control-ui-config.json";

export type ControlUiBootstrapConfig = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string;
};

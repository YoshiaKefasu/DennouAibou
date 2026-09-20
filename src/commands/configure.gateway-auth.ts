import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import type { OpenClawConfig, GatewayAuthConfig } from "../config/config.js";
import { isSecretRef, type SecretInput } from "../config/types.secrets.js";
import { resolveProviderPluginChoice } from "../plugins/provider-wizard.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import { applyAuthChoice, resolvePreferredProviderForAuthChoice } from "./auth-choice.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  applyPrimaryModel,
  promptDefaultModel,
  promptModelAllowlist,
} from "./model-picker.js";
import { promptCustomApiConfig } from "./onboard-custom.js";
import { randomToken } from "./onboard-helpers.js";

type GatewayAuthChoice = "token" | "password" | "trusted-proxy";

/** Reject undefined, empty, and common JS string-coercion artifacts for token auth. */
function sanitizeTokenValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}

function resolveProviderChoiceModelAllowlist(params: {
  authChoice: string;
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  resolvePluginProviders?: typeof resolvePluginProviders;
  resolveProviderPluginChoice?: typeof resolveProviderPluginChoice;
}):
  | {
      allowedKeys?: string[];
      initialSelections?: string[];
      message?: string;
    }
  | undefined {
  const resolvePluginProvidersFn = params.resolvePluginProviders ?? resolvePluginProviders;
  const resolveProviderPluginChoiceFn =
    params.resolveProviderPluginChoice ?? resolveProviderPluginChoice;
  const providers = resolvePluginProvidersFn({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    mode: "setup",
  });
  return resolveProviderPluginChoiceFn({
    providers,
    choice: params.authChoice,
  })?.wizard?.modelAllowlist;
}

export function buildGatewayAuthConfig(params: {
  existing?: GatewayAuthConfig;
  mode: GatewayAuthChoice;
  token?: SecretInput;
  password?: string;
  trustedProxy?: {
    userHeader: string;
    requiredHeaders?: string[];
    allowUsers?: string[];
  };
}): GatewayAuthConfig | undefined {
  const allowTailscale = params.existing?.allowTailscale;
  const base: GatewayAuthConfig = {};
  if (typeof allowTailscale === "boolean") {
    base.allowTailscale = allowTailscale;
  }

  if (params.mode === "token") {
    if (isSecretRef(params.token)) {
      return { ...base, mode: "token", token: params.token };
    }
    // Keep token mode always valid: treat empty/undefined/"undefined"/"null" as missing and generate a token.
    const token = sanitizeTokenValue(params.token) ?? randomToken();
    return { ...base, mode: "token", token };
  }
  if (params.mode === "password") {
    const password = params.password?.trim();
    return { ...base, mode: "password", ...(password && { password }) };
  }
  if (params.mode === "trusted-proxy") {
    if (!params.trustedProxy) {
      throw new Error("trustedProxy config is required when mode is trusted-proxy");
    }
    return { ...base, mode: "trusted-proxy", trustedProxy: params.trustedProxy };
  }
  return base;
}

export type PromptAuthConfigDeps = {
  ensureAuthProfileStore?: typeof ensureAuthProfileStore;
  resolveDefaultAgentWorkspaceDir?: typeof resolveDefaultAgentWorkspaceDir;
  resolveProviderPluginChoice?: typeof resolveProviderPluginChoice;
  resolvePluginProviders?: typeof resolvePluginProviders;
  promptAuthChoiceGrouped?: typeof promptAuthChoiceGrouped;
  applyAuthChoice?: typeof applyAuthChoice;
  resolvePreferredProviderForAuthChoice?: typeof resolvePreferredProviderForAuthChoice;
  promptDefaultModel?: typeof promptDefaultModel;
  promptModelAllowlist?: typeof promptModelAllowlist;
  promptCustomApiConfig?: typeof promptCustomApiConfig;
};

export async function promptAuthConfig(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  deps: PromptAuthConfigDeps = {},
): Promise<OpenClawConfig> {
  const ensureAuthProfileStoreImpl = deps.ensureAuthProfileStore ?? ensureAuthProfileStore;
  const resolveDefaultAgentWorkspaceDirImpl =
    deps.resolveDefaultAgentWorkspaceDir ?? resolveDefaultAgentWorkspaceDir;
  const resolveProviderPluginChoiceImpl =
    deps.resolveProviderPluginChoice ?? resolveProviderPluginChoice;
  const resolvePluginProvidersImpl = deps.resolvePluginProviders ?? resolvePluginProviders;
  const promptAuthChoiceGroupedImpl = deps.promptAuthChoiceGrouped ?? promptAuthChoiceGrouped;
  const applyAuthChoiceImpl = deps.applyAuthChoice ?? applyAuthChoice;
  const resolvePreferredProviderForAuthChoiceImpl =
    deps.resolvePreferredProviderForAuthChoice ?? resolvePreferredProviderForAuthChoice;
  const promptDefaultModelImpl = deps.promptDefaultModel ?? promptDefaultModel;
  const promptModelAllowlistImpl = deps.promptModelAllowlist ?? promptModelAllowlist;
  const promptCustomApiConfigImpl = deps.promptCustomApiConfig ?? promptCustomApiConfig;
  const authChoice = await promptAuthChoiceGroupedImpl({
    prompter,
    store: ensureAuthProfileStoreImpl(undefined, {
      allowKeychainPrompt: false,
    }),
    includeSkip: true,
    config: cfg,
  });

  let next = cfg;
  const preferredProvider =
    authChoice === "skip"
      ? undefined
      : await resolvePreferredProviderForAuthChoiceImpl({
          choice: authChoice,
          config: cfg,
        });
  if (authChoice === "custom-api-key") {
    const customResult = await promptCustomApiConfigImpl({ prompter, runtime, config: next });
    next = customResult.config;
  } else if (authChoice !== "skip") {
    const applied = await applyAuthChoiceImpl({
      authChoice,
      config: next,
      prompter,
      runtime,
      setDefaultModel: true,
    });
    next = applied.config;
  } else {
    const modelSelection = await promptDefaultModelImpl({
      config: next,
      prompter,
      allowKeep: true,
      ignoreAllowlist: true,
      includeProviderPluginSetups: true,
      preferredProvider,
      workspaceDir: resolveDefaultAgentWorkspaceDirImpl(),
      runtime,
    });
    if (modelSelection.config) {
      next = modelSelection.config;
    }
    if (modelSelection.model) {
      next = applyPrimaryModel(next, modelSelection.model);
    }
  }

  if (authChoice !== "custom-api-key") {
    const modelAllowlist = resolveProviderChoiceModelAllowlist({
      authChoice,
      config: next,
      workspaceDir: resolveDefaultAgentWorkspaceDirImpl(),
      env: process.env,
      resolvePluginProviders: resolvePluginProvidersImpl,
      resolveProviderPluginChoice: resolveProviderPluginChoiceImpl,
    });
    const allowlistSelection = await promptModelAllowlistImpl({
      config: next,
      prompter,
      allowedKeys: modelAllowlist?.allowedKeys,
      initialSelections: modelAllowlist?.initialSelections,
      message: modelAllowlist?.message,
      preferredProvider,
    });
    if (allowlistSelection.models) {
      next = applyModelAllowlist(next, allowlistSelection.models);
      next = applyModelFallbacksFromSelection(next, allowlistSelection.models);
    }
  }

  return next;
}

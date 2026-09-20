import {
  cancel,
  confirm as clackConfirm,
  isCancel,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  clearAuthProfileCooldown,
  listProfilesForProvider,
  loadAuthProfileStoreForRuntime,
  upsertAuthProfile,
} from "../../agents/auth-profiles.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import type { OpenClawConfig } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { applyAuthProfileConfig } from "../../plugins/provider-auth-helpers.js";
import { resolvePluginProviders } from "../../plugins/providers.runtime.js";
import type {
  ProviderAuthMethod,
  ProviderAuthResult,
  ProviderPlugin,
} from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { stylePromptHint, stylePromptMessage } from "../../terminal/prompt-style.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { validateAnthropicSetupToken } from "../auth-token.js";
import { isRemoteEnvironment } from "../oauth-env.js";
import { createVpsAwareOAuthHandlers } from "../oauth-flow.js";
import { openUrl } from "../onboard-helpers.js";
import {
  applyProviderAuthConfigPatch,
  applyDefaultModel,
  pickAuthMethod,
  resolveProviderMatch,
} from "../provider-auth-helpers.js";
import { loadValidConfigOrThrow, updateConfig } from "./shared.js";

function guardCancel<T>(value: T | symbol): T {
  if (typeof value === "symbol" || isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value;
}

const confirm = async (params: Parameters<typeof clackConfirm>[0]) =>
  guardCancel(
    await clackConfirm({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );
const text = async (params: Parameters<typeof clackText>[0]) =>
  guardCancel(
    await clackText({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );
const select = async <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  guardCancel(
    await clackSelect({
      ...params,
      message: stylePromptMessage(params.message),
      options: params.options.map((opt) =>
        opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
      ),
    }),
  );

function resolveDefaultTokenProfileId(provider: string): string {
  return `${normalizeProviderId(provider)}:manual`;
}

type ModelsAuthDeps = {
  loadConfig?: typeof loadValidConfigOrThrow;
  updateConfig?: typeof updateConfig;
  resolveAgentId?: typeof resolveDefaultAgentId;
  resolveAgentDir?: typeof resolveAgentDir;
  resolveAgentWorkspaceDir?: typeof resolveAgentWorkspaceDir;
  resolveDefaultWorkspaceDir?: typeof resolveDefaultAgentWorkspaceDir;
  resolvePluginProviders?: typeof resolvePluginProviders;
  upsertAuthProfile?: typeof upsertAuthProfile;
  loadAuthProfileStore?: typeof loadAuthProfileStoreForRuntime;
  listProfilesForProvider?: typeof listProfilesForProvider;
  clearAuthProfileCooldown?: typeof clearAuthProfileCooldown;
  logConfigUpdated?: typeof logConfigUpdated;
  createPrompter?: typeof createClackPrompter;
  checkInteractiveStdin?: () => boolean;
  promptText?: typeof text;
  promptSelect?: typeof select;
  promptConfirm?: typeof confirm;
  openUrl?: typeof openUrl;
};

type ResolvedModelsAuthContext = {
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  providers: ProviderPlugin[];
};

function resolveModelsAuthDeps(deps?: ModelsAuthDeps): Required<ModelsAuthDeps> {
  return {
    loadConfig: deps?.loadConfig ?? loadValidConfigOrThrow,
    updateConfig: deps?.updateConfig ?? updateConfig,
    resolveAgentId: deps?.resolveAgentId ?? resolveDefaultAgentId,
    resolveAgentDir: deps?.resolveAgentDir ?? resolveAgentDir,
    resolveAgentWorkspaceDir: deps?.resolveAgentWorkspaceDir ?? resolveAgentWorkspaceDir,
    resolveDefaultWorkspaceDir: deps?.resolveDefaultWorkspaceDir ?? resolveDefaultAgentWorkspaceDir,
    resolvePluginProviders: deps?.resolvePluginProviders ?? resolvePluginProviders,
    upsertAuthProfile: deps?.upsertAuthProfile ?? upsertAuthProfile,
    loadAuthProfileStore: deps?.loadAuthProfileStore ?? loadAuthProfileStoreForRuntime,
    listProfilesForProvider: deps?.listProfilesForProvider ?? listProfilesForProvider,
    clearAuthProfileCooldown: deps?.clearAuthProfileCooldown ?? clearAuthProfileCooldown,
    logConfigUpdated: deps?.logConfigUpdated ?? logConfigUpdated,
    createPrompter: deps?.createPrompter ?? createClackPrompter,
    checkInteractiveStdin: deps?.checkInteractiveStdin ?? (() => Boolean(process.stdin.isTTY)),
    promptText: deps?.promptText ?? text,
    promptSelect: deps?.promptSelect ?? select,
    promptConfirm: deps?.promptConfirm ?? confirm,
    openUrl: deps?.openUrl ?? openUrl,
  };
}

function listProvidersWithAuthMethods(providers: ProviderPlugin[]): ProviderPlugin[] {
  return providers.filter((provider) => provider.auth.length > 0);
}

function listTokenAuthMethods(provider: ProviderPlugin): ProviderAuthMethod[] {
  return provider.auth.filter((method) => method.kind === "token");
}

function listProvidersWithTokenMethods(providers: ProviderPlugin[]): ProviderPlugin[] {
  return providers.filter((provider) => listTokenAuthMethods(provider).length > 0);
}

async function resolveModelsAuthContext(
  params?: { requestedProvider?: string },
  deps?: ModelsAuthDeps,
): Promise<ResolvedModelsAuthContext> {
  const resolved = resolveModelsAuthDeps(deps);
  const config = await resolved.loadConfig();
  const defaultAgentId = resolved.resolveAgentId(config);
  const agentDir = resolved.resolveAgentDir(config, defaultAgentId);
  const workspaceDir =
    resolved.resolveAgentWorkspaceDir(config, defaultAgentId) ??
    resolved.resolveDefaultWorkspaceDir();
  const providers = resolved.resolvePluginProviders({
    config,
    workspaceDir,
    mode: "setup",
    bundledProviderAllowlistCompat: true,
    bundledProviderVitestCompat: true,
    ...(params?.requestedProvider?.trim()
      ? { providerRefs: [params.requestedProvider], activate: true }
      : {}),
  });
  return {
    config,
    agentDir,
    workspaceDir,
    providers,
  };
}

function resolveRequestedProviderOrThrow(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  const requested = rawProvider?.trim();
  if (!requested) {
    return null;
  }
  const matched = resolveProviderMatch(providers, requested);
  if (matched) {
    return matched;
  }
  const available = providers
    .map((provider) => provider.id)
    .filter(Boolean)
    .toSorted((a, b) => a.localeCompare(b));
  const availableText = available.length > 0 ? available.join(", ") : "(none)";
  throw new Error(
    `Unknown provider "${requested}". Loaded providers: ${availableText}. Verify plugins via \`${formatCliCommand("openclaw plugins list --json")}\`.`,
  );
}

function resolveTokenMethodOrThrow(
  provider: ProviderPlugin,
  rawMethod?: string,
): ProviderAuthMethod | null {
  const tokenMethods = listTokenAuthMethods(provider);
  if (rawMethod?.trim()) {
    const matched = pickAuthMethod(provider, rawMethod);
    if (matched && matched.kind === "token") {
      return matched;
    }
    const available = tokenMethods.map((method) => method.id).join(", ") || "(none)";
    throw new Error(
      `Unknown token auth method "${rawMethod}" for provider "${provider.id}". Available token methods: ${available}.`,
    );
  }
  return null;
}

async function pickProviderAuthMethod(params: {
  provider: ProviderPlugin;
  requestedMethod?: string;
  prompter: ReturnType<typeof createClackPrompter>;
}) {
  const requestedMethod = pickAuthMethod(params.provider, params.requestedMethod);
  if (requestedMethod) {
    return requestedMethod;
  }
  if (params.provider.auth.length === 1) {
    return params.provider.auth[0] ?? null;
  }
  return await params.prompter
    .select({
      message: `Auth method for ${params.provider.label}`,
      options: params.provider.auth.map((method) => ({
        value: method.id,
        label: method.label,
        hint: method.hint,
      })),
    })
    .then((id) => params.provider.auth.find((method) => method.id === String(id)) ?? null);
}

async function pickProviderTokenMethod(params: {
  provider: ProviderPlugin;
  requestedMethod?: string;
  prompter: ReturnType<typeof createClackPrompter>;
}) {
  const explicitTokenMethod = resolveTokenMethodOrThrow(params.provider, params.requestedMethod);
  if (explicitTokenMethod) {
    return explicitTokenMethod;
  }
  const tokenMethods = listTokenAuthMethods(params.provider);
  if (tokenMethods.length === 0) {
    return null;
  }
  const setupTokenMethod = tokenMethods.find((method) => method.id === "setup-token");
  if (setupTokenMethod) {
    return setupTokenMethod;
  }
  if (tokenMethods.length === 1) {
    return tokenMethods[0] ?? null;
  }
  return await params.prompter
    .select({
      message: `Token method for ${params.provider.label}`,
      options: tokenMethods.map((method) => ({
        value: method.id,
        label: method.label,
        hint: method.hint,
      })),
    })
    .then((id) => tokenMethods.find((method) => method.id === String(id)) ?? null);
}

async function persistProviderAuthResult(params: {
  result: ProviderAuthResult;
  agentDir: string;
  runtime: RuntimeEnv;
  prompter: ReturnType<typeof createClackPrompter>;
  setDefault?: boolean;
  deps?: ModelsAuthDeps;
}) {
  const resolved = resolveModelsAuthDeps(params.deps);
  for (const profile of params.result.profiles) {
    resolved.upsertAuthProfile({
      profileId: profile.profileId,
      credential: profile.credential,
      agentDir: params.agentDir,
    });
  }

  await resolved.updateConfig((cfg) => {
    let next = cfg;
    if (params.result.configPatch) {
      next = applyProviderAuthConfigPatch(next, params.result.configPatch);
    }
    for (const profile of params.result.profiles) {
      next = applyAuthProfileConfig(next, {
        profileId: profile.profileId,
        provider: profile.credential.provider,
        mode: credentialMode(profile.credential),
      });
    }
    if (params.setDefault && params.result.defaultModel) {
      next = applyDefaultModel(next, params.result.defaultModel);
    }
    return next;
  });

  resolved.logConfigUpdated(params.runtime);
  for (const profile of params.result.profiles) {
    params.runtime.log(
      `Auth profile: ${profile.profileId} (${profile.credential.provider}/${credentialMode(profile.credential)})`,
    );
  }
  if (params.result.defaultModel) {
    params.runtime.log(
      params.setDefault
        ? `Default model set to ${params.result.defaultModel}`
        : `Default model available: ${params.result.defaultModel} (use --set-default to apply)`,
    );
  }
  if (params.result.notes && params.result.notes.length > 0) {
    await params.prompter.note(params.result.notes.join("\n"), "Provider notes");
  }
}

async function runProviderAuthMethod(params: {
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  provider: ProviderPlugin;
  method: ProviderAuthMethod;
  runtime: RuntimeEnv;
  prompter: ReturnType<typeof createClackPrompter>;
  setDefault?: boolean;
  deps?: ModelsAuthDeps;
}) {
  const resolved = resolveModelsAuthDeps(params.deps);
  await clearStaleProfileLockouts(params.provider.id, params.agentDir, params.deps);

  const result = await params.method.run({
    config: params.config,
    env: process.env,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    prompter: params.prompter,
    runtime: params.runtime,
    allowSecretRefPrompt: false,
    isRemote: isRemoteEnvironment(),
    openUrl: async (url) => {
      await resolved.openUrl(url);
    },
    oauth: {
      createVpsAwareHandlers: (runtimeParams) => createVpsAwareOAuthHandlers(runtimeParams),
    },
  });

  await persistProviderAuthResult({
    result,
    agentDir: params.agentDir,
    runtime: params.runtime,
    prompter: params.prompter,
    setDefault: params.setDefault,
    deps: params.deps,
  });
}

export async function modelsAuthSetupTokenCommand(
  opts: { provider?: string; yes?: boolean },
  runtime: RuntimeEnv,
  deps?: ModelsAuthDeps,
) {
  const resolved = resolveModelsAuthDeps(deps);
  if (!resolved.checkInteractiveStdin()) {
    throw new Error("setup-token requires an interactive TTY.");
  }

  const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext(
    {
      requestedProvider: opts.provider,
    },
    deps,
  );
  const tokenProviders = listProvidersWithTokenMethods(providers);
  if (tokenProviders.length === 0) {
    throw new Error(
      `No provider token-auth plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`,
    );
  }

  const provider =
    resolveRequestedProviderOrThrow(tokenProviders, opts.provider) ?? tokenProviders[0] ?? null;
  if (!provider) {
    throw new Error("No token-capable provider is available.");
  }

  if (!opts.yes) {
    const proceed = await resolved.promptConfirm({
      message: `Continue with ${provider.label} token auth?`,
      initialValue: true,
    });
    if (!proceed) {
      return;
    }
  }

  const prompter = resolved.createPrompter();
  const method = await pickProviderTokenMethod({ provider, prompter });
  if (!method) {
    throw new Error(`Provider "${provider.id}" does not expose a token auth method.`);
  }

  await runProviderAuthMethod({
    config,
    agentDir,
    workspaceDir,
    provider,
    method,
    runtime,
    prompter,
    deps,
  });
}

export async function modelsAuthPasteTokenCommand(
  opts: {
    provider?: string;
    profileId?: string;
    expiresIn?: string;
  },
  runtime: RuntimeEnv,
  deps?: ModelsAuthDeps,
) {
  const resolved = resolveModelsAuthDeps(deps);
  const { agentDir } = await resolveModelsAuthContext(undefined, deps);
  const rawProvider = opts.provider?.trim();
  if (!rawProvider) {
    throw new Error("Missing --provider.");
  }
  const provider = normalizeProviderId(rawProvider);
  const profileId = opts.profileId?.trim() || resolveDefaultTokenProfileId(provider);

  const tokenInput = await resolved.promptText({
    message: `Paste token for ${provider}`,
    validate: (value) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        return "Required";
      }
      if (provider === "anthropic") {
        return validateAnthropicSetupToken(trimmed.replaceAll(/\s+/g, ""));
      }
      return undefined;
    },
  });
  const token =
    provider === "anthropic"
      ? String(tokenInput ?? "")
          .replaceAll(/\s+/g, "")
          .trim()
      : String(tokenInput ?? "").trim();

  const expires =
    opts.expiresIn?.trim() && opts.expiresIn.trim().length > 0
      ? Date.now() + parseDurationMs(String(opts.expiresIn ?? "").trim(), { defaultUnit: "d" })
      : undefined;

  resolved.upsertAuthProfile({
    profileId,
    credential: {
      type: "token",
      provider,
      token,
      ...(expires ? { expires } : {}),
    },
    agentDir,
  });

  await resolved.updateConfig((cfg) =>
    applyAuthProfileConfig(cfg, { profileId, provider, mode: "token" }),
  );

  resolved.logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (${provider}/token)`);
  if (provider === "anthropic") {
    runtime.log("Anthropic setup-token auth is a legacy/manual path in OpenClaw.");
    runtime.log(
      "Anthropic told OpenClaw users this path requires Extra Usage on the Claude account.",
    );
  }
}

export async function modelsAuthAddCommand(
  _opts: Record<string, never>,
  runtime: RuntimeEnv,
  deps?: ModelsAuthDeps,
) {
  const resolved = resolveModelsAuthDeps(deps);
  const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext(
    undefined,
    deps,
  );
  const tokenProviders = listProvidersWithTokenMethods(providers);

  const provider = await resolved.promptSelect({
    message: "Token provider",
    options: [
      ...tokenProviders.map((providerPlugin) => ({
        value: providerPlugin.id,
        label: providerPlugin.id,
        hint: providerPlugin.docsPath ? `Docs: ${providerPlugin.docsPath}` : undefined,
      })),
      { value: "custom", label: "custom (type provider id)" },
    ],
  });

  const providerId =
    provider === "custom"
      ? normalizeProviderId(
          String(
            await resolved.promptText({
              message: "Provider id",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
          ),
        )
      : provider;

  const providerPlugin =
    provider === "custom" ? null : resolveRequestedProviderOrThrow(tokenProviders, providerId);
  if (providerPlugin) {
    const tokenMethods = listTokenAuthMethods(providerPlugin);
    const methodId =
      tokenMethods.length > 0
        ? await resolved.promptSelect({
            message: "Token method",
            options: [
              ...tokenMethods.map((method) => ({
                value: method.id,
                label: method.label,
                hint: method.hint,
              })),
              { value: "paste", label: "paste token" },
            ],
          })
        : "paste";
    if (methodId !== "paste") {
      const prompter = resolved.createPrompter();
      const method = tokenMethods.find((candidate) => candidate.id === methodId);
      if (!method) {
        throw new Error(`Unknown token auth method "${String(methodId)}".`);
      }
      await runProviderAuthMethod({
        config,
        agentDir,
        workspaceDir,
        provider: providerPlugin,
        method,
        runtime,
        prompter,
        deps,
      });
      return;
    }
  }

  const profileIdDefault = resolveDefaultTokenProfileId(providerId);
  const profileId = String(
    await resolved.promptText({
      message: "Profile id",
      initialValue: profileIdDefault,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();

  const wantsExpiry = await resolved.promptConfirm({
    message: "Does this token expire?",
    initialValue: false,
  });
  const expiresIn = wantsExpiry
    ? String(
        await resolved.promptText({
          message: "Expires in (duration)",
          initialValue: "365d",
          validate: (value) => {
            try {
              parseDurationMs(String(value ?? ""), { defaultUnit: "d" });
              return undefined;
            } catch {
              return "Invalid duration (e.g. 365d, 12h, 30m)";
            }
          },
        }),
      ).trim()
    : undefined;

  await modelsAuthPasteTokenCommand({ provider: providerId, profileId, expiresIn }, runtime, deps);
}

type LoginOptions = {
  provider?: string;
  method?: string;
  setDefault?: boolean;
  yes?: boolean;
};

/**
 * Clear stale cooldown/disabled state for all profiles matching a provider.
 * When a user explicitly runs `models auth login`, they intend to fix auth —
 * stale `auth_permanent` / `billing` lockouts should not persist across
 * a deliberate re-authentication attempt.
 */
async function clearStaleProfileLockouts(
  provider: string,
  agentDir: string,
  deps?: ModelsAuthDeps,
): Promise<void> {
  const resolved = resolveModelsAuthDeps(deps);
  try {
    const store = resolved.loadAuthProfileStore(agentDir);
    const profileIds = resolved.listProfilesForProvider(store, provider);
    for (const profileId of profileIds) {
      await resolved.clearAuthProfileCooldown({ store, profileId, agentDir });
    }
  } catch {
    // Best-effort housekeeping — never block re-authentication.
  }
}

export function resolveRequestedLoginProviderOrThrow(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  return resolveRequestedProviderOrThrow(providers, rawProvider);
}

function credentialMode(credential: AuthProfileCredential): "api_key" | "oauth" | "token" {
  if (credential.type === "api_key") {
    return "api_key";
  }
  if (credential.type === "token") {
    return "token";
  }
  return "oauth";
}

function maybeLogOpenAICodexNativeSearchTip(runtime: RuntimeEnv, providerId: string) {
  if (providerId !== "openai-codex") {
    return;
  }
  runtime.log(
    "Tip: Codex-capable models can use native Codex web search. Enable it with openclaw configure --section web (recommended mode: cached). Docs: https://docs.openclaw.ai/tools/web",
  );
}
export async function modelsAuthLoginCommand(
  opts: LoginOptions,
  runtime: RuntimeEnv,
  deps?: ModelsAuthDeps,
) {
  const resolved = resolveModelsAuthDeps(deps);
  if (!resolved.checkInteractiveStdin()) {
    throw new Error("models auth login requires an interactive TTY.");
  }

  const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext(
    {
      requestedProvider: opts.provider,
    },
    deps,
  );
  const prompter = resolved.createPrompter();
  const authProviders = listProvidersWithAuthMethods(providers);
  if (authProviders.length === 0) {
    throw new Error(
      `No provider plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`,
    );
  }

  const requestedProvider = resolveRequestedLoginProviderOrThrow(authProviders, opts.provider);
  const selectedProvider =
    requestedProvider ??
    (await prompter
      .select({
        message: "Select a provider",
        options: authProviders.map((provider) => ({
          value: provider.id,
          label: provider.label,
          hint: provider.docsPath ? `Docs: ${provider.docsPath}` : undefined,
        })),
      })
      .then((id) => resolveProviderMatch(authProviders, String(id))));

  if (!selectedProvider) {
    throw new Error("Unknown provider. Use --provider <id> to pick a provider plugin.");
  }
  const chosenMethod = await pickProviderAuthMethod({
    provider: selectedProvider,
    requestedMethod: opts.method,
    prompter,
  });

  if (!chosenMethod) {
    throw new Error("Unknown auth method. Use --method <id> to select one.");
  }

  await runProviderAuthMethod({
    config,
    agentDir,
    workspaceDir,
    provider: selectedProvider,
    method: chosenMethod,
    runtime,
    prompter,
    setDefault: opts.setDefault,
    deps,
  });
  maybeLogOpenAICodexNativeSearchTip(runtime, selectedProvider.id);
}

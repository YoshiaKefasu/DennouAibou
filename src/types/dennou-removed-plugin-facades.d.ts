// DennouAibou hard-fork debloat compatibility.
//
// Some public plugin-sdk facade files remain for upstream compatibility, but the
// bundled plugins they pointed to were intentionally removed. The runtime facades
// still fail if called; these declarations only keep SDK d.ts generation from
// depending on deleted workspace packages.

type RemovedPluginFunction = (...args: unknown[]) => unknown;
type RemovedPluginAsyncFunction = (...args: unknown[]) => Promise<unknown>;
type RemovedPluginObject = Record<string, unknown>;

declare module "@openclaw/bluebubbles/api.js" {
  export const isAllowedBlueBubblesSender: RemovedPluginFunction;
  export const resolveBlueBubblesGroupRequireMention: RemovedPluginFunction;
  export const resolveBlueBubblesGroupToolPolicy: RemovedPluginFunction;
}

declare module "@openclaw/feishu/api.js" {
  export const buildFeishuConversationId: RemovedPluginFunction;
  export const createFeishuThreadBindingManager: RemovedPluginFunction;
  export const feishuSessionBindingAdapterChannels: readonly unknown[];
  export const feishuThreadBindingTesting: RemovedPluginObject;
  export const feishuSetupAdapter: RemovedPluginObject;
  export const feishuSetupWizard: RemovedPluginObject;
  export const parseFeishuDirectConversationId: RemovedPluginFunction;
  export const parseFeishuConversationId: RemovedPluginFunction;
  export const parseFeishuTargetId: RemovedPluginFunction;
}

declare module "@openclaw/github-copilot/api.js" {
  export const githubCopilotLoginCommand: RemovedPluginFunction;
}

declare module "@openclaw/irc/api.js" {
  export const ircSetupAdapter: RemovedPluginObject;
  export const ircSetupWizard: RemovedPluginObject;
  export const listIrcAccountIds: RemovedPluginFunction;
  export const resolveDefaultIrcAccountId: RemovedPluginFunction;
  export const resolveIrcAccount: RemovedPluginFunction;
}

declare module "@openclaw/matrix/api.js" {
  export const createMatrixThreadBindingManager: RemovedPluginFunction;
  export const findMatrixAccountEntry: RemovedPluginFunction;
  export const getMatrixScopedEnvVarNames: RemovedPluginFunction;
  export const matrixSessionBindingAdapterChannels: readonly unknown[];
  export const requiresExplicitMatrixDefaultAccount: RemovedPluginFunction;
  export const resetMatrixThreadBindingsForTests: RemovedPluginFunction;
  export const resolveConfiguredMatrixAccountIds: RemovedPluginFunction;
  export const resolveMatrixAccountStorageRoot: RemovedPluginFunction;
  export const resolveMatrixChannelConfig: RemovedPluginFunction;
  export const resolveMatrixCredentialsDir: RemovedPluginFunction;
  export const resolveMatrixCredentialsPath: RemovedPluginFunction;
  export const resolveMatrixDefaultOrOnlyAccountId: RemovedPluginFunction;
  export const resolveMatrixLegacyFlatStoragePaths: RemovedPluginFunction;
  export const setMatrixThreadBindingIdleTimeoutBySessionKey: RemovedPluginFunction;
  export const setMatrixThreadBindingMaxAgeBySessionKey: RemovedPluginFunction;
}

declare module "@openclaw/matrix/runtime-api.js" {
  export const ensureMatrixSdkInstalled: RemovedPluginAsyncFunction;
  export const isMatrixSdkAvailable: RemovedPluginFunction;
  export const resolveMatrixAccountStringValues: RemovedPluginFunction;
  export const setMatrixRuntime: RemovedPluginFunction;
}

declare module "@openclaw/ollama/api.js" {
  export const resolveOllamaApiBase: RemovedPluginFunction;
}

declare module "@openclaw/ollama/runtime-api.js" {
  export type OllamaEmbeddingClient = Record<string, unknown>;
  export const buildAssistantMessage: RemovedPluginFunction;
  export const buildOllamaChatRequest: RemovedPluginFunction;
  export const convertToOllamaMessages: RemovedPluginFunction;
  export const createConfiguredOllamaCompatNumCtxWrapper: RemovedPluginFunction;
  export const createConfiguredOllamaCompatStreamWrapper: RemovedPluginFunction;
  export const createConfiguredOllamaStreamFn: RemovedPluginFunction;
  export const createOllamaStreamFn: RemovedPluginFunction;
  export const createOllamaEmbeddingProvider: RemovedPluginFunction;
  export const isOllamaCompatProvider: RemovedPluginFunction;
  export const parseNdjsonStream: RemovedPluginFunction;
  export const resolveOllamaBaseUrlForRun: RemovedPluginFunction;
  export const resolveOllamaCompatNumCtxEnabled: RemovedPluginFunction;
  export const shouldInjectOllamaCompatNumCtx: RemovedPluginFunction;
  export const wrapOllamaCompatNumCtx: RemovedPluginFunction;
}

declare module "@openclaw/zalo/setup-api.js" {
  export const evaluateZaloGroupAccess: RemovedPluginFunction;
  export const resolveZaloRuntimeGroupPolicy: RemovedPluginFunction;
  export const zaloSetupAdapter: RemovedPluginObject;
  export const zaloSetupWizard: RemovedPluginObject;
}

declare module "@openclaw/litellm/api.js" {
  export const applyLitellmConfig: RemovedPluginFunction;
  export const applyLitellmProviderConfig: RemovedPluginFunction;
  export const buildLitellmModelDefinition: RemovedPluginFunction;
  export const LITELLM_BASE_URL: RemovedPluginObject;
  export const LITELLM_DEFAULT_MODEL_ID: RemovedPluginObject;
  export const LITELLM_DEFAULT_MODEL_REF: RemovedPluginObject;
}

declare module "@openclaw/openrouter/api.js" {
  export const applyOpenrouterConfig: RemovedPluginFunction;
  export const applyOpenrouterProviderConfig: RemovedPluginFunction;
  export const buildOpenrouterProvider: RemovedPluginFunction;
  export const OPENROUTER_DEFAULT_MODEL_REF: RemovedPluginObject;
}

declare module "@openclaw/vercel-ai-gateway/api.js" {
  export const buildVercelAiGatewayProvider: RemovedPluginFunction;
  export const discoverVercelAiGatewayModels: RemovedPluginFunction;
  export const getStaticVercelAiGatewayModelCatalog: RemovedPluginFunction;
  export const VERCEL_AI_GATEWAY_BASE_URL: RemovedPluginObject;
  export const VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW: RemovedPluginObject;
  export const VERCEL_AI_GATEWAY_DEFAULT_COST: RemovedPluginObject;
  export const VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS: RemovedPluginObject;
  export const VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID: RemovedPluginObject;
  export const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF: RemovedPluginObject;
  export const VERCEL_AI_GATEWAY_PROVIDER_ID: RemovedPluginObject;
}

declare module "@openclaw/xiaomi/api.js" {
  export const applyXiaomiConfig: RemovedPluginFunction;
  export const applyXiaomiProviderConfig: RemovedPluginFunction;
  export const buildXiaomiProvider: RemovedPluginFunction;
  export const XIAOMI_DEFAULT_MODEL_ID: RemovedPluginObject;
  export const XIAOMI_DEFAULT_MODEL_REF: RemovedPluginObject;
}

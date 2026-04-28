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

declare module "@openclaw/zalo/setup-api.js" {
  export const evaluateZaloGroupAccess: RemovedPluginFunction;
  export const resolveZaloRuntimeGroupPolicy: RemovedPluginFunction;
  export const zaloSetupAdapter: RemovedPluginObject;
  export const zaloSetupWizard: RemovedPluginObject;
}

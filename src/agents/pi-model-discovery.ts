import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Provider as PiProvider } from "@earendil-works/pi-ai";
import type { ModelRegistry as PiModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  ModelRegistry as PiModelRegistryImpl,
  ModelRuntime as PiModelRuntimeImpl,
} from "@earendil-works/pi-coding-agent";
import {
  type AuthStorage as PiAuthStorage,
  AuthStorage as PiAuthStorageImpl,
  InMemoryAuthStorageBackend,
  // TODO(pi-sdk): deep path import — switch to a public pi-coding-agent export when available.
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import {
  // TODO(pi-sdk): deep path import — switch to a public pi-coding-agent export when available.
  ModelConfig as PiModelConfigImpl,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js";
import {
  // TODO(pi-sdk): deep path import — switch to a public pi-coding-agent export when available.
  FileModelsStore as PiFileModelsStoreImpl,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js";
import {
  // TODO(pi-sdk): deep path import — switch to a public pi-coding-agent export when available.
  RuntimeCredentials as PiRuntimeCredentialsImpl,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/runtime-credentials.js";
import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import {
  applyProviderResolvedModelCompatWithPlugins,
  applyProviderResolvedTransportWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
} from "../plugins/provider-runtime.js";
import type { ProviderRuntimeModel } from "../plugins/types.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import { resolveProviderEnvApiKeyCandidates } from "./model-auth-env-vars.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import { detectOpenAICompletionsCompat } from "./openai-completions-compat.js";
import { resolvePiCredentialMapFromStore, type PiCredentialMap } from "./pi-auth-credentials.js";

const PiAuthStorageClass = PiAuthStorageImpl;
const PiModelRegistryClass = PiModelRegistryImpl;

/**
 * DennouAibou-side master model configuration file name.
 *
 * Unlike the PI SDK's `models.json`, this file MAY carry extended modalities
 * such as `"audio"` in a model's `input`. When present, it is the source of
 * truth: a PI-SDK-safe `models.json` is projected from it (with unsupported
 * modalities stripped) so the SDK's TypeBox validation always sees
 * `text`/`image` only.
 */
export const DENNOU_MODELS_FILE_NAME = "dennou.models.json";

const PI_SDK_ALLOWED_MODEL_INPUT_MODALITIES = new Set(["text", "image"]);
const SUPPORTED_MODEL_INPUT_MODALITIES = new Set(["text", "image", "audio", "document"]);

// `ModelRuntime.create()` always loads the SDK's `builtinProviderCatalog`
// (30+ providers like openrouter/openai/anthropic) and seeds the runtime
// with them. DennouAibou is a single-provider deployment: `~/.openclaw/agents/
// main/agent/models.json` is the sole source of truth, and the
// `/model` picker must not surface SDK builtins. `discoverModels` below
// bypasses `create()` and invokes the (TS-private) constructor directly
// with an empty `providers` array so only `models.json`-derived providers
// end up in the snapshot.

export { PiAuthStorageClass as AuthStorage, PiModelRegistryClass as ModelRegistry };

type InMemoryAuthStorageBackendLike = {
  withLock<T>(
    update: (current: string) => {
      result: T;
      next?: string;
    },
  ): T;
};

function createInMemoryAuthStorageBackend(
  initialData: PiCredentialMap,
): InMemoryAuthStorageBackendLike {
  let snapshot = JSON.stringify(initialData, null, 2);
  return {
    withLock<T>(
      update: (current: string) => {
        result: T;
        next?: string;
      },
    ): T {
      const { result, next } = update(snapshot);
      if (typeof next === "string") {
        snapshot = next;
      }
      return result;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip modalities the PI SDK's `models.json` schema rejects (e.g. `"audio"`)
 * from every model entry's `input`. Everything else is preserved verbatim.
 */
export function sanitizeModelsInputForPiSdk(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.providers)) {
    return value;
  }
  const providers: Record<string, unknown> = {};
  for (const [providerId, providerValue] of Object.entries(value.providers)) {
    if (!isRecord(providerValue) || !Array.isArray(providerValue.models)) {
      providers[providerId] = providerValue;
      continue;
    }
    const models = providerValue.models.map((model) => {
      if (!isRecord(model) || !Array.isArray(model.input)) {
        return model;
      }
      const input = model.input.filter(
        (item): item is string =>
          typeof item === "string" && PI_SDK_ALLOWED_MODEL_INPUT_MODALITIES.has(item),
      );
      return input.length === model.input.length ? model : { ...model, input };
    });
    providers[providerId] = { ...providerValue, models };
  }
  return { ...value, providers };
}

function readDennouModelsConfig(agentDir: string): Record<string, unknown> | undefined {
  try {
    const pathname = path.join(agentDir, DENNOU_MODELS_FILE_NAME);
    if (!fs.existsSync(pathname)) {
      return undefined;
    }
    const parsed = parseJsonWithJson5Fallback(fs.readFileSync(pathname, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Project `dennou.models.json` onto `models.json` with PI-SDK-unsupported
 * modalities stripped. Writes only when the projected content differs, so the
 * agent dir stays untouched on already-synchronized runs.
 */
function syncPiSdkModelsJsonFromDennou(params: {
  parsed: Record<string, unknown>;
  modelsJsonPath: string;
}): void {
  const sanitized = sanitizeModelsInputForPiSdk(params.parsed);
  const contents = `${JSON.stringify(sanitized, null, 2)}\n`;
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(params.modelsJsonPath, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing === contents) {
    return;
  }
  fs.writeFileSync(params.modelsJsonPath, contents, "utf8");
  fs.chmodSync(params.modelsJsonPath, 0o600);
}

function inputsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Look up the extended `input` (incl. `"audio"`) declared for a model in
 * `dennou.models.json`. The SDK-typed registry entry only ever carries the
 * sanitized `text`/`image` list, so the master file restores the modality in
 * memory without ever feeding it to the SDK's schema validation.
 */
function resolveDennouModelInput(params: {
  model: Pick<Model<Api>, "id" | "provider">;
  dennouConfig?: Record<string, unknown>;
}): Array<"text" | "image" | "audio"> | undefined {
  const config = params.dennouConfig;
  if (!config || !isRecord(config.providers)) {
    return undefined;
  }
  const modelId = params.model.id.toLowerCase();
  const provider = params.model.provider.toLowerCase();
  for (const [providerId, providerValue] of Object.entries(config.providers)) {
    if (providerId.toLowerCase() !== provider || !isRecord(providerValue)) {
      continue;
    }
    const models = providerValue.models;
    if (!Array.isArray(models)) {
      continue;
    }
    for (const model of models) {
      if (!isRecord(model) || typeof model.id !== "string") {
        continue;
      }
      if (model.id.toLowerCase() !== modelId) {
        continue;
      }
      const input = Array.isArray(model.input)
        ? model.input.filter(
            (item): item is "text" | "image" | "audio" | "document" =>
              typeof item === "string" && SUPPORTED_MODEL_INPUT_MODALITIES.has(item),
          )
        : [];
      if (input.length > 0) {
        return input as Array<"text" | "image" | "audio">;
      }
    }
  }
  return undefined;
}

function normalizeRegistryModel<T>(
  value: T,
  agentDir: string,
  dennouConfig?: Record<string, unknown>,
): T {
  if (!isRecord(value)) {
    return value;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.api !== "string"
  ) {
    return value;
  }
  const model = value as unknown as ProviderRuntimeModel;
  const pluginNormalized =
    normalizeProviderResolvedModelWithPlugin({
      provider: model.provider,
      context: {
        provider: model.provider,
        modelId: model.id,
        model,
        agentDir,
      },
    }) ?? model;
  const compatNormalized =
    applyProviderResolvedModelCompatWithPlugins({
      provider: model.provider,
      context: {
        provider: model.provider,
        modelId: model.id,
        model: pluginNormalized,
        agentDir,
      },
    }) ?? pluginNormalized;
  const transportNormalized =
    applyProviderResolvedTransportWithPlugin({
      provider: model.provider,
      context: {
        provider: model.provider,
        modelId: model.id,
        model: compatNormalized,
        agentDir,
      },
    }) ?? compatNormalized;
  // Detect openai-completions compat defaults BEFORE plugin transforms using
  // pre-transform identity fields (provider, baseUrl, id). Note: this only
  // applies when the model's api is still "openai-completions" after plugin
  // normalization — models whose api gets promoted to "openai-responses" by a
  // plugin do NOT receive these completions-specific defaults.
  const compatDefaultsBeforePlugins =
    model.api === "openai-completions"
      ? detectOpenAICompletionsCompat(
          model as Pick<Model<"openai-completions">, "provider" | "baseUrl" | "id" | "compat">,
        ).defaults
      : undefined;
  const mergedModel = normalizeModelCompat(transportNormalized as Model<Api>) as Model<Api>;
  if (compatDefaultsBeforePlugins && mergedModel.api === "openai-completions") {
    const existing = (mergedModel.compat ?? {}) as Record<string, unknown>;
    mergedModel.compat = {
      ...compatDefaultsBeforePlugins,
      ...existing,
    } as typeof mergedModel.compat;
  }
  // `dennou.models.json` is the source of truth for extended modalities such
  // as `"audio"` that the PI SDK's models.json schema cannot carry. Restore
  // the master file's `input` in memory only — the on-disk `models.json` stays
  // sanitized to `text`/`image`.
  const dennouInput = resolveDennouModelInput({ model: mergedModel, dennouConfig });
  if (dennouInput && !inputsEqual(dennouInput, mergedModel.input)) {
    return {
      ...mergedModel,
      input: dennouInput,
    } as T;
  }
  return mergedModel as T;
}

function wrapRegistryWithNormalization(
  registry: PiModelRegistry,
  agentDir: string,
  dennouConfig?: Record<string, unknown>,
): PiModelRegistry {
  const getAll = registry.getAll.bind(registry);
  const getAvailable = registry.getAvailable.bind(registry);
  const find = registry.find.bind(registry);

  registry.getAll = () =>
    getAll().map((entry: Model<Api>) => normalizeRegistryModel(entry, agentDir, dennouConfig));
  registry.getAvailable = () =>
    getAvailable().map((entry: Model<Api>) =>
      normalizeRegistryModel(entry, agentDir, dennouConfig),
    );
  registry.find = (provider: string, modelId: string) =>
    normalizeRegistryModel(find(provider, modelId), agentDir, dennouConfig);

  return registry;
}

function scrubLegacyStaticAuthJsonEntries(pathname: string): void {
  if (process.env.DENNOU_AUTH_STORE_READONLY === "1") {
    return;
  }
  if (!fs.existsSync(pathname)) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(pathname, "utf8")) as unknown;
  } catch {
    return;
  }
  if (!isRecord(parsed)) {
    return;
  }

  let changed = false;
  for (const [provider, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      continue;
    }
    if (value.type !== "api_key") {
      continue;
    }
    delete parsed[provider];
    changed = true;
  }

  if (!changed) {
    return;
  }

  if (Object.keys(parsed).length === 0) {
    fs.rmSync(pathname, { force: true });
    return;
  }

  fs.writeFileSync(pathname, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}

function createAuthStorage(AuthStorageLike: unknown, path: string, creds: PiCredentialMap) {
  const withInMemory = AuthStorageLike as { inMemory?: (data?: unknown) => unknown };
  if (typeof withInMemory.inMemory === "function") {
    return withInMemory.inMemory(creds) as PiAuthStorage;
  }

  const withFromStorage = AuthStorageLike as {
    fromStorage?: (storage: unknown) => unknown;
  };
  if (typeof withFromStorage.fromStorage === "function") {
    const backendCtor = InMemoryAuthStorageBackend;
    const backend =
      typeof backendCtor === "function"
        ? new backendCtor()
        : createInMemoryAuthStorageBackend(creds);
    backend.withLock(() => ({
      result: undefined,
      next: JSON.stringify(creds, null, 2),
    }));
    return withFromStorage.fromStorage(backend) as PiAuthStorage;
  }

  const withFactory = AuthStorageLike as { create?: (path: string) => unknown };
  const withRuntimeOverride = (
    typeof withFactory.create === "function"
      ? withFactory.create(path)
      : new (AuthStorageLike as { new (path: string): unknown })(path)
  ) as PiAuthStorage & {
    setRuntimeApiKey?: (provider: string, apiKey: string) => void; // pragma: allowlist secret
  };
  const hasRuntimeApiKeyOverride = typeof withRuntimeOverride.setRuntimeApiKey === "function"; // pragma: allowlist secret
  if (hasRuntimeApiKeyOverride) {
    const setKey = withRuntimeOverride.setRuntimeApiKey!;
    for (const [provider, credential] of Object.entries(creds)) {
      if (credential.type === "api_key") {
        setKey(provider, credential.key);
        continue;
      }
      setKey(provider, credential.access);
    }
  }
  return withRuntimeOverride;
}

function resolvePiCredentials(agentDir: string): PiCredentialMap {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const credentials = resolvePiCredentialMapFromStore(store);
  // pi-coding-agent hides providers from its registry when auth storage lacks
  // a matching credential entry. Mirror env-backed provider auth here so
  // live/model discovery sees the same providers runtime auth can use.
  for (const provider of Object.keys(resolveProviderEnvApiKeyCandidates())) {
    if (credentials[provider]) {
      continue;
    }
    const resolved = resolveEnvApiKey(provider);
    if (!resolved?.apiKey) {
      continue;
    }
    credentials[provider] = {
      type: "api_key",
      key: resolved.apiKey,
    };
  }
  return credentials;
}

// Compatibility helpers for pi-coding-agent 0.50+ (discover* helpers removed).
export function discoverAuthStorage(agentDir: string): PiAuthStorage {
  const credentials = resolvePiCredentials(agentDir);
  const authPath = path.join(agentDir, "auth.json");
  scrubLegacyStaticAuthJsonEntries(authPath);
  return createAuthStorage(PiAuthStorageClass, authPath, credentials);
}

function modelConfigContainsAudioInput(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const providers = value.providers;
  if (!isRecord(providers)) {
    return false;
  }
  return Object.values(providers).some((provider) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) {
      return false;
    }
    return provider.models.some(
      (model) => isRecord(model) && Array.isArray(model.input) && model.input.includes("audio"),
    );
  });
}

function createAudioAwareModelConfig(parsed: unknown): {
  getProvider(providerId: string): unknown;
  getProviderIds(): string[];
  getError(): undefined;
} {
  const providers = isRecord(parsed) && isRecord(parsed.providers) ? parsed.providers : {};
  return {
    getProvider(providerId) {
      return providers[providerId];
    },
    getProviderIds() {
      return Object.keys(providers);
    },
    getError() {
      return undefined;
    },
  };
}

export async function discoverModels(
  authStorage: PiAuthStorage,
  agentDir: string,
): Promise<PiModelRegistry> {
  const modelsJsonPath = path.join(agentDir, "models.json");
  // Note: always pass the path — the SDK handles ENOENT gracefully, and an
  // undefined modelsPath would silently fall back to the global
  // ~/.pi/agent/models.json which is not what we want.
  //
  // Build a `ModelRuntime` with an empty builtin-provider list. Passing `[]`
  // for the `providers` constructor argument keeps `defaultBuiltins` /
  // `builtins` empty, so `rebuildProviders()` only sees providers that come
  // from `models.json` via `ModelConfig`. `ModelRuntime.create()` would
  // inject the SDK's 30+ builtin providers here, which we don't want.
  let config: Awaited<ReturnType<typeof PiModelConfigImpl.load>>;
  // `dennou.models.json` is the master model config for DennouAibou: it may
  // declare extended modalities (e.g. `"audio"`) that the PI SDK's models.json
  // schema rejects. When present, project a sanitized `models.json` from it so
  // the SDK's TypeBox validation always sees `text`/`image` only, then load the
  // SDK from that clean file. The master file's modalities are restored in
  // memory by `normalizeRegistryModel`.
  const dennouConfig = readDennouModelsConfig(agentDir);
  if (dennouConfig) {
    syncPiSdkModelsJsonFromDennou({ parsed: dennouConfig, modelsJsonPath });
    config = await PiModelConfigImpl.load(modelsJsonPath);
  } else {
    try {
      const parsed = parseJsonWithJson5Fallback(fs.readFileSync(modelsJsonPath, "utf8"));
      config = modelConfigContainsAudioInput(parsed)
        ? (createAudioAwareModelConfig(parsed) as unknown as Awaited<
            ReturnType<typeof PiModelConfigImpl.load>
          >)
        : await PiModelConfigImpl.load(modelsJsonPath);
    } catch {
      config = await PiModelConfigImpl.load(modelsJsonPath);
    }
  }
  const modelsStore = new PiFileModelsStoreImpl(
    path.join(path.dirname(modelsJsonPath), "models-store.json"),
  );
  // `RuntimeCredentials` (deep-imported from `runtime-credentials.js`) wraps
  // a `CredentialStore`. `AuthStorage` implements `CredentialStore`, but the
  // two types live behind different import paths in this project, so we
  // bridge them through `unknown` to avoid pulling the public SDK surface
  // for an internal-only relationship.
  const credentials = new PiRuntimeCredentialsImpl(
    authStorage as unknown as ConstructorParameters<typeof PiRuntimeCredentialsImpl>[0],
  );
  // The TypeScript declaration marks the constructor `private`, but the
  // runtime accepts this signature (see the `create()` factory, which itself
  // invokes the same constructor with identical positional args). The
  // `@ts-expect-error` absorbs the TS-only access restriction; the JS call
  // is real and behaves as documented.
  const emptyProviders: readonly PiProvider[] = [];
  // @ts-expect-error: ModelRuntime#constructor is TS-private; bypass to skip builtin provider catalog.
  const runtime = new PiModelRuntimeImpl(
    credentials,
    config,
    modelsJsonPath,
    modelsStore,
    emptyProviders,
    false,
  );
  // `create()` triggers a `refresh()` to populate `snapshot.configuredProviders`
  // and `snapshot.available`. Constructor-only builds skip that pass, so the
  // snapshot stays empty and `getAvailable()` / `getAll()` return `[]`. Mirror
  // `create()`'s post-construct refresh with `allowNetwork: false` to keep the
  // contract callers (registry, plugin transforms, `loadModelCatalog`) depend on.
  await runtime.refresh({ allowNetwork: false });
  const registry = new PiModelRegistryClass(runtime);
  return wrapRegistryWithNormalization(registry, agentDir, dennouConfig);
}

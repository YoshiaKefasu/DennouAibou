// Manual facade. Keep loader boundary explicit.
// NOTE: speech-core extension was removed in debloat. Types defined locally
// based on actual usage in tts-tool.ts, commands-tts.ts, compact.ts, attempt.ts.
import type { OpenClawConfig } from "../config/config.js";
import {
  createLazyFacadeObjectValue,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

type SpeechProviderConfig = Record<string, unknown>;

type TtsAttempt = {
  reasonCode: string;
  latencyMs: number;
  provider: string;
  outcome: string;
};

type TextToSpeechResult = {
  success: boolean;
  audioPath?: string;
  provider?: string;
  voiceCompatible?: boolean;
  error?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsAttempt[];
  latencyMs?: number;
};

type LastTtsAttempt = {
  timestamp: number;
  success?: boolean;
  textLength?: number;
  summarized?: boolean;
  provider?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsAttempt[];
  latencyMs?: number;
  error?: string;
};

type ResolvedTtsConfig = {
  timeoutMs: number;
  summaryModel?: string;
  [key: string]: unknown;
};

type TtsAppliedPayload = {
  mediaUrl?: string;
  audioAsVoice?: boolean;
  [key: string]: unknown;
};

// FacadeModule mirrors the public surface of @openclaw/speech-core/runtime-api.js
// which was removed during debloat. Types derived from actual call-site usage.
type FacadeModule = {
  _test: Record<string, unknown>;
  buildTtsSystemPromptHint: (cfg: OpenClawConfig) => string | undefined;
  getLastTtsAttempt: () => LastTtsAttempt | undefined;
  getResolvedSpeechProviderConfig: (
    config: ResolvedTtsConfig,
    providerId: string,
    cfg: OpenClawConfig,
  ) => SpeechProviderConfig;
  getTtsMaxLength: (prefsPath: string) => number;
  getTtsProvider: (config: ResolvedTtsConfig, prefsPath: string) => string;
  isSummarizationEnabled: (prefsPath: string) => boolean;
  isTtsEnabled: (config: ResolvedTtsConfig, prefsPath: string) => boolean;
  isTtsProviderConfigured: (
    config: ResolvedTtsConfig,
    providerId: string,
    cfg: OpenClawConfig,
  ) => boolean;
  listSpeechVoices: (...args: unknown[]) => Promise<unknown[]>;
  maybeApplyTtsToPayload: (params: Record<string, unknown>) => Promise<TtsAppliedPayload>;
  resolveTtsAutoMode: (...args: unknown[]) => unknown;
  resolveTtsConfig: (cfg: OpenClawConfig) => ResolvedTtsConfig;
  resolveTtsPrefsPath: (config: ResolvedTtsConfig) => string;
  resolveTtsProviderOrder: (...args: unknown[]) => unknown;
  setLastTtsAttempt: (attempt: LastTtsAttempt) => void;
  setSummarizationEnabled: (prefsPath: string, enabled: boolean) => void;
  setTtsAutoMode: (...args: unknown[]) => void;
  setTtsEnabled: (prefsPath: string, enabled: boolean) => void;
  setTtsMaxLength: (prefsPath: string, max: number) => void;
  setTtsProvider: (prefsPath: string, provider: string) => void;
  synthesizeSpeech: (...args: unknown[]) => unknown;
  textToSpeech: (params: {
    text: string;
    cfg: OpenClawConfig;
    channel?: string;
    prefsPath?: string;
  }) => Promise<TextToSpeechResult>;
  textToSpeechTelephony: (...args: unknown[]) => unknown;
};

function loadFacadeModule(): FacadeModule {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "speech-core",
    artifactBasename: "runtime-api.js",
  });
}

export const _test: FacadeModule["_test"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()._test,
);
export const buildTtsSystemPromptHint: FacadeModule["buildTtsSystemPromptHint"] =
  createLazyFacadeValue("buildTtsSystemPromptHint");
export const getLastTtsAttempt: FacadeModule["getLastTtsAttempt"] =
  createLazyFacadeValue("getLastTtsAttempt");
export const getResolvedSpeechProviderConfig: FacadeModule["getResolvedSpeechProviderConfig"] =
  createLazyFacadeValue("getResolvedSpeechProviderConfig");
export const getTtsMaxLength: FacadeModule["getTtsMaxLength"] =
  createLazyFacadeValue("getTtsMaxLength");
export const getTtsProvider: FacadeModule["getTtsProvider"] =
  createLazyFacadeValue("getTtsProvider");
export const isSummarizationEnabled: FacadeModule["isSummarizationEnabled"] =
  createLazyFacadeValue("isSummarizationEnabled");
export const isTtsEnabled: FacadeModule["isTtsEnabled"] = createLazyFacadeValue("isTtsEnabled");
export const isTtsProviderConfigured: FacadeModule["isTtsProviderConfigured"] =
  createLazyFacadeValue("isTtsProviderConfigured");
export const listSpeechVoices: FacadeModule["listSpeechVoices"] =
  createLazyFacadeValue("listSpeechVoices");
export const maybeApplyTtsToPayload: FacadeModule["maybeApplyTtsToPayload"] =
  createLazyFacadeValue("maybeApplyTtsToPayload");
export const resolveTtsAutoMode: FacadeModule["resolveTtsAutoMode"] =
  createLazyFacadeValue("resolveTtsAutoMode");
export const resolveTtsConfig: FacadeModule["resolveTtsConfig"] =
  createLazyFacadeValue("resolveTtsConfig");
export const resolveTtsPrefsPath: FacadeModule["resolveTtsPrefsPath"] =
  createLazyFacadeValue("resolveTtsPrefsPath");
export const resolveTtsProviderOrder: FacadeModule["resolveTtsProviderOrder"] =
  createLazyFacadeValue("resolveTtsProviderOrder");
export const setLastTtsAttempt: FacadeModule["setLastTtsAttempt"] =
  createLazyFacadeValue("setLastTtsAttempt");
export const setSummarizationEnabled: FacadeModule["setSummarizationEnabled"] =
  createLazyFacadeValue("setSummarizationEnabled");
export const setTtsAutoMode: FacadeModule["setTtsAutoMode"] =
  createLazyFacadeValue("setTtsAutoMode");
export const setTtsEnabled: FacadeModule["setTtsEnabled"] = createLazyFacadeValue("setTtsEnabled");
export const setTtsMaxLength: FacadeModule["setTtsMaxLength"] =
  createLazyFacadeValue("setTtsMaxLength");
export const setTtsProvider: FacadeModule["setTtsProvider"] =
  createLazyFacadeValue("setTtsProvider");
export const synthesizeSpeech: FacadeModule["synthesizeSpeech"] =
  createLazyFacadeValue("synthesizeSpeech");
export const textToSpeech: FacadeModule["textToSpeech"] = createLazyFacadeValue("textToSpeech");
export const textToSpeechTelephony: FacadeModule["textToSpeechTelephony"] =
  createLazyFacadeValue("textToSpeechTelephony");

function createLazyFacadeValue<K extends keyof FacadeModule>(key: K): FacadeModule[K] {
  return ((...args: unknown[]) => {
    const value = loadFacadeModule()[key];
    if (typeof value !== "function") {
      return value;
    }
    return (value as (...innerArgs: unknown[]) => unknown)(...args);
  }) as FacadeModule[K];
}

export {
  _test,
  buildTtsSystemPromptHint,
  getLastTtsAttempt,
  getResolvedSpeechProviderConfig,
  getTtsMaxLength,
  getTtsProvider,
  isSummarizationEnabled,
  isTtsEnabled,
  isTtsProviderConfigured,
  listSpeechVoices,
  maybeApplyTtsToPayload,
  resolveTtsAutoMode,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsProviderOrder,
  setLastTtsAttempt,
  setSummarizationEnabled,
  setTtsAutoMode,
  setTtsEnabled,
  setTtsMaxLength,
  setTtsProvider,
  synthesizeSpeech,
  textToSpeech,
  textToSpeechTelephony,
} from "../plugin-sdk/tts-runtime.js";

// NOTE: Type exports moved to provider-types.ts (speech-core was removed in debloat).
export type { ResolvedTtsConfig } from "./provider-types.js";

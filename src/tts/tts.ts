export {
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
export type { ResolvedTtsConfig, TtsDirectiveOverrides } from "./provider-types.js";

// _test: internal functions exposed for contract tests. Since speech-core was removed
// in debloat, these are re-exported from their canonical locations in the TTS module.
import { redactSensitiveText } from "../logging/redact.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";
import { parseTtsDirectives as _parseTtsDirectives } from "./directives.js";
import { summarizeText as _summarizeText } from "./tts-core.js";
import { getResolvedSpeechProviderConfig as _getResolvedSpeechProviderConfig } from "../plugin-sdk/tts-runtime.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedTtsConfig } from "./provider-types.js";

function _resolveModelOverridePolicy(
  partial?: Partial<SpeechModelOverridePolicy>,
): SpeechModelOverridePolicy {
  if (partial?.enabled === false) {
    return {
      enabled: false,
      allowText: false,
      allowProvider: false,
      allowVoice: false,
      allowModelId: false,
      allowVoiceSettings: false,
      allowNormalization: false,
      allowSeed: false,
    };
  }
  return {
    enabled: partial?.enabled ?? true,
    allowText: partial?.allowText ?? true,
    allowProvider: partial?.allowProvider ?? false,
    allowVoice: partial?.allowVoice ?? true,
    allowModelId: partial?.allowModelId ?? true,
    allowVoiceSettings: partial?.allowVoiceSettings ?? true,
    allowNormalization: partial?.allowNormalization ?? true,
    allowSeed: partial?.allowSeed ?? false,
  };
}

function _formatTtsProviderError(provider: string, error: Error): string {
  if (error.name === "AbortError") {
    return `${provider}: request timed out`;
  }
  const redacted = redactSensitiveText(error.message);
  return `${provider}: ${redacted}`;
}

function _sanitizeTtsErrorForLog(error: Error): string {
  let msg = error.message;
  msg = msg.replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]");
  msg = msg.replace(/[\n\r\t]/g, (ch) => {
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    return "\\t";
  });
  return msg;
}

export const _test = {
  parseTtsDirectives: _parseTtsDirectives,
  resolveModelOverridePolicy: _resolveModelOverridePolicy,
  summarizeText: _summarizeText,
  getResolvedSpeechProviderConfig: _getResolvedSpeechProviderConfig,
  formatTtsProviderError: _formatTtsProviderError,
  sanitizeTtsErrorForLog: _sanitizeTtsErrorForLog,
};

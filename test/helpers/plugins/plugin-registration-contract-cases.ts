import { describePluginRegistrationContract } from "./plugin-registration-contract.js";

type PluginRegistrationContractParams = Parameters<typeof describePluginRegistrationContract>[0];

export const pluginRegistrationContractCases = {
  brave: {
    pluginId: "brave",
    webSearchProviderIds: ["brave"],
  },
  deepgram: {
    pluginId: "deepgram",
    mediaUnderstandingProviderIds: ["deepgram"],
  },
  duckduckgo: {
    pluginId: "duckduckgo",
    webSearchProviderIds: ["duckduckgo"],
  },
  exa: {
    pluginId: "exa",
    webSearchProviderIds: ["exa"],
  },
  firecrawl: {
    pluginId: "firecrawl",
    webFetchProviderIds: ["firecrawl"],
    webSearchProviderIds: ["firecrawl"],
    toolNames: ["firecrawl_search", "firecrawl_scrape"],
  },
  google: {
    pluginId: "google",
    providerIds: ["google", "google-gemini-cli"],
    webSearchProviderIds: ["gemini"],
    mediaUnderstandingProviderIds: ["google"],
    imageGenerationProviderIds: ["google"],
    requireDescribeImages: true,
    requireGenerateImage: true,
  },
  openai: {
    pluginId: "openai",
    providerIds: ["openai", "openai-codex"],
    speechProviderIds: ["openai"],
    realtimeTranscriptionProviderIds: ["openai"],
    realtimeVoiceProviderIds: ["openai"],
    mediaUnderstandingProviderIds: ["openai", "openai-codex"],
    imageGenerationProviderIds: ["openai"],
    requireSpeechVoices: true,
    requireDescribeImages: true,
    requireGenerateImage: true,
  },
  tavily: {
    pluginId: "tavily",
    webSearchProviderIds: ["tavily"],
    toolNames: ["tavily_search", "tavily_extract"],
  },
  zai: {
    pluginId: "zai",
    mediaUnderstandingProviderIds: ["zai"],
    requireDescribeImages: true,
  },
} satisfies Record<string, PluginRegistrationContractParams>;

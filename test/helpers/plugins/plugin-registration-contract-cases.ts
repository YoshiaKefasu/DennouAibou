import { describePluginRegistrationContract } from "./plugin-registration-contract.js";

type PluginRegistrationContractParams = Parameters<typeof describePluginRegistrationContract>[0];

export const pluginRegistrationContractCases = {
  "dennou-websearch": {
    pluginId: "dennou-websearch",
    webSearchProviderIds: ["exa", "brave"],
  },
  deepgram: {
    pluginId: "deepgram",
    mediaUnderstandingProviderIds: ["deepgram"],
  },
  duckduckgo: {
    pluginId: "duckduckgo",
    webSearchProviderIds: ["duckduckgo"],
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
    requireDescribeImages: true,
  },
  openai: {
    pluginId: "openai",
    providerIds: ["openai"],
    mediaUnderstandingProviderIds: ["openai"],
    requireDescribeImages: true,
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

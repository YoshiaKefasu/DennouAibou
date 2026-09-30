import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { openaiMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import {
  resolveOpenAIPromptOverlayMode,
  resolveOpenAISystemPromptContribution,
} from "./prompt-overlay.js";

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Provider",
  description: "Bundled OpenAI provider plugins",
  register(api) {
    const promptOverlayMode = resolveOpenAIPromptOverlayMode(api.pluginConfig);
    const buildProviderWithPromptContribution = <T extends ReturnType<typeof buildOpenAIProvider>>(
      provider: T,
    ): T => ({
      ...provider,
      resolveSystemPromptContribution: (ctx) =>
        resolveOpenAISystemPromptContribution({
          mode: promptOverlayMode,
          modelProviderId: provider.id,
          modelId: ctx.modelId,
        }),
    });
    api.registerProvider(buildProviderWithPromptContribution(buildOpenAIProvider()));
    api.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);
  },
});

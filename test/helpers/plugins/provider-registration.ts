import type {
  MediaUnderstandingProviderPlugin,
  ProviderPlugin,
} from "../../../src/plugins/types.js";
import { createTestPluginApi } from "./plugin-api.js";

type RegisteredProviderCollections = {
  providers: ProviderPlugin[];
  mediaProviders: MediaUnderstandingProviderPlugin[];
};

type ProviderPluginModule = {
  register(api: ReturnType<typeof createTestPluginApi>): void | Promise<void>;
};

export async function registerProviderPlugin(params: {
  plugin: ProviderPluginModule;
  id: string;
  name: string;
}): Promise<RegisteredProviderCollections> {
  const providers: ProviderPlugin[] = [];
  const mediaProviders: MediaUnderstandingProviderPlugin[] = [];

  await params.plugin.register(
    createTestPluginApi({
      id: params.id,
      name: params.name,
      source: "test",
      config: {},
      runtime: {} as never,
      registerProvider: (provider) => {
        providers.push(provider);
      },
      registerMediaUnderstandingProvider: (provider) => {
        mediaProviders.push(provider);
      },
    }),
  );

  return {
    providers,
    mediaProviders,
  };
}

export function requireRegisteredProvider<T extends { id: string }>(
  entries: T[],
  id: string,
  label = "provider",
): T {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`${label} ${id} was not registered`);
  }
  return entry;
}

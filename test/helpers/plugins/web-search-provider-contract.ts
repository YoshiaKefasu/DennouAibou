import { describe, expect, it } from "vitest";
import {
  pluginRegistrationContractRegistry,
  resolveWebSearchProviderContractEntriesForPluginId,
} from "../../../src/plugins/contracts/registry.js";
import { installWebSearchProviderContractSuite } from "./provider-contract-suites.js";

export function describeWebSearchProviderContracts(pluginId: string, providerId?: string) {
  const registeredProviderIds =
    pluginRegistrationContractRegistry.find((entry) => entry.pluginId === pluginId)
      ?.webSearchProviderIds ?? [];
  const providerIds = providerId
    ? registeredProviderIds.filter((candidate) => candidate === providerId)
    : registeredProviderIds;

  const resolveProviders = () => resolveWebSearchProviderContractEntriesForPluginId(pluginId);

  describe(`${pluginId} web search provider contract registry load`, () => {
    it("loads bundled web search providers", () => {
      expect(resolveProviders().length).toBeGreaterThan(0);
    });
  });

  for (const providerId of providerIds) {
    describe(`${pluginId}:${providerId} web search contract`, () => {
      installWebSearchProviderContractSuite({
        provider: () => {
          const entry = resolveProviders().find((provider) => provider.provider.id === providerId);
          if (!entry) {
            throw new Error(
              `web search provider contract entry missing for ${pluginId}:${providerId}`,
            );
          }
          return entry.provider;
        },
        credentialValue: () => {
          const entry = resolveProviders().find((provider) => provider.provider.id === providerId);
          if (!entry) {
            throw new Error(
              `web search provider contract entry missing for ${pluginId}:${providerId}`,
            );
          }
          return entry.credentialValue;
        },
      });
    });
  }
}

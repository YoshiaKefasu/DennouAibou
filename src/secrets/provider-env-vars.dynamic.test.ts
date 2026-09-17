import { describe, expect, it, vi } from "vitest";
import {
  getProviderEnvVars,
  listKnownProviderAuthEnvVarNames,
  listKnownSecretEnvVarNames,
} from "./provider-env-vars.js";

const externalFireworksPlugin = {
  id: "external-fireworks",
  origin: "global",
  providerAuthEnvVars: {
    fireworks: ["FIREWORKS_ALT_API_KEY"],
  },
};

describe("provider env vars dynamic manifest metadata", () => {
  it("includes later-installed plugin env vars without a bundled generated map", () => {
    const loadPluginManifestRegistry = vi.fn(() => ({
      plugins: [externalFireworksPlugin],
      diagnostics: [],
    }));
    const deps = { loadPluginManifestRegistry };

    expect(getProviderEnvVars("fireworks", undefined, deps)).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(listKnownProviderAuthEnvVarNames(undefined, deps)).toContain("FIREWORKS_ALT_API_KEY");
    expect(listKnownSecretEnvVarNames(undefined, deps)).toContain("FIREWORKS_ALT_API_KEY");
  });

  it("returns no env vars when the manifest registry is empty", () => {
    const loadPluginManifestRegistry = vi.fn(() => ({ plugins: [], diagnostics: [] }));

    expect(getProviderEnvVars("fireworks", undefined, { loadPluginManifestRegistry })).toEqual([]);
  });
});

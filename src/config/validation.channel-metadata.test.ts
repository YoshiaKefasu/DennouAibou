import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

const mockLoadPluginManifestRegistry = vi.fn(
  (): PluginManifestRegistry => ({ diagnostics: [], plugins: [] }),
);
const mockListPluginDoctorLegacyConfigRules = vi.fn(() => []);
const previousDisableBundledPlugins = process.env.DENNOU_DISABLE_BUNDLED_PLUGINS;

beforeAll(() => {
  process.env.DENNOU_DISABLE_BUNDLED_PLUGINS = "1";
});

afterAll(() => {
  if (previousDisableBundledPlugins === undefined) {
    delete process.env.DENNOU_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.DENNOU_DISABLE_BUNDLED_PLUGINS = previousDisableBundledPlugins;
  }
});

function setupTelegramSchemaWithDefault() {
  mockLoadPluginManifestRegistry.mockReturnValue({
    diagnostics: [],
    plugins: [
      {
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
        providers: [],
        skills: [],
        hooks: [],
        rootDir: "/virtual/plugins/telegram",
        source: "/virtual/plugins/telegram/openclaw.plugin.json",
        manifestPath: "/virtual/plugins/telegram/openclaw.plugin.json",
        channelCatalogMeta: {
          id: "telegram",
          label: "Telegram",
          blurb: "Telegram channel",
        },
        channelConfigs: {
          telegram: {
            schema: {
              type: "object",
              properties: {
                dmPolicy: {
                  type: "string",
                  enum: ["pairing", "allowlist"],
                  default: "pairing",
                },
              },
              // validateConfigObjectWithPlugins starts from the core validated
              // config, which can already include bundled runtime defaults for
              // the channel. Keep this mock schema focused on the plugin-owned
              // default under test instead of rejecting unrelated core fields.
              additionalProperties: true,
            },
            uiHints: {},
          },
        },
      },
    ],
  });
}

describe("validateConfigObjectWithPlugins channel metadata (applyDefaults: true)", () => {
  it("applies bundled channel defaults from plugin-owned schema metadata", async () => {
    setupTelegramSchemaWithDefault();

    const result = validateConfigObjectWithPlugins(
      {
        channels: {
          telegram: {},
        },
      },
      {
        deps: {
          loadPluginManifestRegistry: mockLoadPluginManifestRegistry,
          listPluginDoctorLegacyConfigRules: mockListPluginDoctorLegacyConfigRules,
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.channels?.telegram).toEqual(
        expect.objectContaining({ dmPolicy: "pairing" }),
      );
    }
  });
});

describe("validateConfigObjectRawWithPlugins channel metadata", () => {
  it("still injects channel AJV defaults even in raw mode — persistence safety is handled by io.ts", async () => {
    // Channel and plugin AJV validation always runs with applyDefaults: true
    // (hardcoded) to avoid breaking schemas that mark defaulted fields as
    // required (e.g., BlueBubbles enrichGroupParticipantsFromContacts).
    //
    // The actual protection against leaking these defaults to disk lives in
    // writeConfigFile (io.ts), which uses persistCandidate (the pre-validation
    // merge-patched value) instead of validated.config.
    setupTelegramSchemaWithDefault();

    const result = validateConfigObjectRawWithPlugins(
      {
        channels: {
          telegram: {},
        },
      },
      {
        deps: {
          loadPluginManifestRegistry: mockLoadPluginManifestRegistry,
          listPluginDoctorLegacyConfigRules: mockListPluginDoctorLegacyConfigRules,
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // AJV defaults ARE injected into validated.config even in raw mode.
      // This is intentional — see comment above.
      expect(result.config.channels?.telegram).toEqual(
        expect.objectContaining({ dmPolicy: "pairing" }),
      );
    }
  });
});

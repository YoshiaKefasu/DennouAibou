import { afterEach, describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import {
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";

afterEach(() => {
  resetPluginAutoEnableTestState();
});

describe("applyPluginAutoEnable providers", () => {
  it("auto-enables provider auth plugins when profiles exist", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "google-gemini-cli:default": {
              provider: "google-gemini-cli",
              mode: "oauth",
            },
          },
        },
      },
      env: makeIsolatedEnv(),
    });

    expect(result.config.plugins?.entries?.google?.enabled).toBe(true);
  });

  it("auto-enables minimax when minimax-portal profiles exist", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "minimax-portal:default": {
              provider: "minimax-portal",
              mode: "oauth",
            },
          },
        },
      },
      env: makeIsolatedEnv(),
    });

    expect(result.config.plugins?.entries?.minimax?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.["minimax-portal-auth"]).toBeUndefined();
  });

  it("auto-enables minimax when minimax API key auth is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "minimax:default": {
              provider: "minimax",
              mode: "api_key",
            },
          },
        },
      },
      env: makeIsolatedEnv(),
    });

    expect(result.config.plugins?.entries?.minimax?.enabled).toBe(true);
  });

  it("does not auto-enable unrelated provider plugins just because auth profiles exist", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "openai:default": {
              provider: "openai",
              mode: "api_key",
            },
          },
        },
      },
      env: makeIsolatedEnv(),
    });

    expect(result.config.plugins?.entries?.openai).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("uses manifest-owned provider auto-enable metadata for third-party plugins", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "acme-oauth:default": {
              provider: "acme-oauth",
              mode: "oauth",
            },
          },
        },
      },
      env: makeIsolatedEnv(),
      manifestRegistry: makeRegistry([
        {
          id: "acme",
          channels: [],
          autoEnableWhenConfiguredProviders: ["acme-oauth"],
        },
      ]),
    });

    expect(result.config.plugins?.entries?.acme?.enabled).toBe(true);
  });

  it("auto-enables third-party provider plugins when manifest-owned web search config exists", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          entries: {
            acme: {
              config: {
                webSearch: {
                  apiKey: "acme-search-key",
                },
              },
            },
          },
        },
      },
      env: makeIsolatedEnv(),
      manifestRegistry: makeRegistry([
        {
          id: "acme",
          channels: [],
          providers: ["acme-ai"],
          contracts: {
            webSearchProviders: ["acme-search"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.acme?.enabled).toBe(true);
    expect(result.changes).toContain("acme web search configured, enabled automatically.");
  });
});

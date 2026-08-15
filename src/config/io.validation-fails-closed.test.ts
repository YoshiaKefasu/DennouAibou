import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot, loadConfig } from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("config validation fail-closed behavior", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("throws INVALID_CONFIG instead of returning an empty config", async () => {
    await withTempHomeConfig(
      {
        agents: { list: [{ id: "main" }] },
        nope: true,
        channels: {
          whatsapp: {
            dmPolicy: "allowlist",
            allowFrom: ["+1234567890"],
          },
        },
      },
      async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        let thrown: unknown;
        try {
          loadConfig();
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as { code?: string } | undefined)?.code).toBe("INVALID_CONFIG");
        expect(spy).toHaveBeenCalled();
      },
    );
  });

  it("still loads valid security settings unchanged", async () => {
    await withTempHomeConfig(
      {
        agents: { list: [{ id: "main" }] },
        channels: {
          whatsapp: {
            dmPolicy: "allowlist",
            allowFrom: ["+1234567890"],
          },
        },
      },
      async () => {
        const cfg = loadConfig();
        expect(cfg.channels?.whatsapp?.dmPolicy).toBe("allowlist");
        expect(cfg.channels?.whatsapp?.allowFrom).toEqual(["+1234567890"]);
      },
    );
  });

  it("warns about removed compat.thinkingFormat values before rejecting", async () => {
    await withTempHomeConfig(
      {
        agents: { list: [{ id: "main" }] },
        models: {
          providers: {
            legacy: {
              baseUrl: "http://127.0.0.1:8000/v1",
              models: [
                {
                  id: "legacy-model",
                  name: "Legacy Model",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8_192,
                  compat: { thinkingFormat: "openrouter" },
                },
              ],
            },
          },
        },
      },
      async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        let thrown: unknown;
        try {
          loadConfig();
        } catch (err) {
          thrown = err;
        }

        expect((thrown as { code?: string } | undefined)?.code).toBe("INVALID_CONFIG");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('compat.thinkingFormat "openrouter"'),
        );
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      },
    );
  });
});

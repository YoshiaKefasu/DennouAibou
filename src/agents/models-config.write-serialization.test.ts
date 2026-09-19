import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  withModelsTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson, type ModelsConfigDeps } from "./models-config.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";

const planOpenClawModelsJsonMock = vi.fn<ModelsConfigDeps["planOpenClawModelsJson"]>();

installModelsConfigTestHooks();

beforeEach(() => {
  planOpenClawModelsJsonMock.mockImplementation(
    async (params: { cfg?: typeof CUSTOM_PROXY_MODELS_CONFIG }) => ({
      action: "write",
      contents: `${JSON.stringify({ providers: params.cfg?.models?.providers ?? {} }, null, 2)}\n`,
    }),
  );
});

describe("models-config write serialization", () => {
  it("serializes concurrent models.json writes to avoid overlap", async () => {
    await withModelsTempHome(async () => {
      const first = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      const second = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      const firstModel = first.models?.providers?.["custom-proxy"]?.models?.[0];
      const secondModel = second.models?.providers?.["custom-proxy"]?.models?.[0];
      if (!firstModel || !secondModel) {
        throw new Error("custom-proxy fixture missing expected model entries");
      }
      firstModel.name = "Proxy A";
      secondModel.name = "Proxy B with longer name";

      const originalWriteFile = fs.writeFile.bind(fs);
      let inFlightWrites = 0;
      let maxInFlightWrites = 0;
      let modelsTempWriteCount = 0;
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        const targetArg = args[0];
        const targetPath =
          typeof targetArg === "string"
            ? targetArg
            : targetArg instanceof URL
              ? targetArg.pathname
              : undefined;
        const isModelsTempWrite =
          typeof targetPath === "string" &&
          path.basename(targetPath).startsWith("models.json.") &&
          targetPath.endsWith(".tmp");
        if (isModelsTempWrite) {
          modelsTempWriteCount += 1;
          inFlightWrites += 1;
          if (inFlightWrites > maxInFlightWrites) {
            maxInFlightWrites = inFlightWrites;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        try {
          return await originalWriteFile(...args);
        } finally {
          if (isModelsTempWrite) {
            inFlightWrites -= 1;
          }
        }
      });

      try {
        const deps = { planOpenClawModelsJson: planOpenClawModelsJsonMock };
        await Promise.all([
          ensureOpenClawModelsJson(first, undefined, deps),
          ensureOpenClawModelsJson(second, undefined, deps),
        ]);
      } finally {
        writeSpy.mockRestore();
      }

      // Both concurrent writers must have run, and the write lock must have kept
      // them from overlapping. Which writer lands last is an I/O scheduling
      // artifact (Bun and Vitest resolve the fingerprint stats in different
      // orders), so assert the serialized outcome instead of a fixed winner.
      expect(maxInFlightWrites).toBe(1);
      expect(modelsTempWriteCount).toBe(2);
      const parsed = await readGeneratedModelsJson<{
        providers: { "custom-proxy"?: { models?: Array<{ name?: string }> } };
      }>();
      const finalName = parsed.providers["custom-proxy"]?.models?.[0]?.name;
      expect(["Proxy A", "Proxy B with longer name"]).toContain(finalName);
    });
  }, 60_000);
});

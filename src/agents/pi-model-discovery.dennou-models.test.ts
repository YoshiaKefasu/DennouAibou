import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveAuthProfileStore } from "./auth-profiles.js";
import {
  DENNOU_MODELS_FILE_NAME,
  discoverAuthStorage,
  discoverModels,
} from "./pi-model-discovery.js";

const MODELS_FILE_NAME = "models.json";

const GEMINI_MODEL = {
  id: "gemini-3-pro-preview",
  name: "Gemini 3 Pro Preview",
  reasoning: true,
  contextWindow: 1_048_576,
  maxTokens: 65_536,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function buildMasterConfig(input: Array<"text" | "image" | "audio">): unknown {
  return {
    providers: {
      google: {
        api: "openai-completions",
        baseUrl: "https://example.test/v1",
        models: [{ ...GEMINI_MODEL, input }],
      },
    },
  };
}

function buildSdkSafeConfig(): unknown {
  return {
    providers: {
      google: {
        api: "openai-completions",
        baseUrl: "https://example.test/v1",
        models: [{ ...GEMINI_MODEL, input: ["text", "image"] }],
      },
    },
  };
}

async function createAgentDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-dennou-models-"));
}

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = await createAgentDir();
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

async function writeJsonFile(agentDir: string, fileName: string, payload: unknown): Promise<void> {
  await fs.writeFile(path.join(agentDir, fileName), `${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonFile(agentDir: string, fileName: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(agentDir, fileName), "utf8")) as unknown;
}

function writeGoogleAuthProfile(agentDir: string): void {
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "google:default": {
          type: "api_key",
          provider: "google",
          key: "test-key",
        },
      },
    },
    agentDir,
  );
}

type RegistryModel = {
  id?: string;
  provider?: string;
  input?: string[];
};

describe("discoverModels with dennou.models.json master config", () => {
  it("projects a sanitized models.json and restores the audio modality in memory", async () => {
    await withAgentDir(async (agentDir) => {
      writeGoogleAuthProfile(agentDir);
      // Master file declares extended modalities the PI SDK schema rejects.
      await writeJsonFile(
        agentDir,
        DENNOU_MODELS_FILE_NAME,
        buildMasterConfig(["text", "image", "audio"]),
      );

      const modelRegistry = await discoverModels(discoverAuthStorage(agentDir), agentDir);

      expect(modelRegistry.getError?.()).toBeUndefined();

      // The SDK-facing models.json must never carry "audio" (TypeBox).
      const projected = (await readJsonFile(agentDir, MODELS_FILE_NAME)) as {
        providers: {
          google: { models: Array<{ id: string; input: string[] }> };
        };
      };
      expect(projected.providers.google.models[0]?.input).toEqual(["text", "image"]);

      // The registry (and therefore loadModelCatalog / modelSupportsAudio)
      // sees the master file's full modality list in memory only.
      const all = modelRegistry.getAll() as RegistryModel[];
      const found = all.find((entry) => entry.id === "gemini-3-pro-preview");
      expect(found?.input).toEqual(["text", "image", "audio"]);

      const viaFind = modelRegistry.find("google", "gemini-3-pro-preview") as RegistryModel | null;
      expect(viaFind?.input).toContain("audio");
    });
  });

  it("leaves an already-projected models.json untouched", async () => {
    await withAgentDir(async (agentDir) => {
      writeGoogleAuthProfile(agentDir);
      await writeJsonFile(
        agentDir,
        DENNOU_MODELS_FILE_NAME,
        buildMasterConfig(["text", "image", "audio"]),
      );
      const sdkSafe = buildSdkSafeConfig();
      await writeJsonFile(agentDir, MODELS_FILE_NAME, sdkSafe);
      const before = await fs.readFile(path.join(agentDir, MODELS_FILE_NAME), "utf8");

      await discoverModels(discoverAuthStorage(agentDir), agentDir);

      const after = await fs.readFile(path.join(agentDir, MODELS_FILE_NAME), "utf8");
      expect(after).toBe(before);
    });
  });

  it("falls back to models.json as-is when dennou.models.json is absent", async () => {
    await withAgentDir(async (agentDir) => {
      writeGoogleAuthProfile(agentDir);
      const sdkSafe = buildSdkSafeConfig();
      await writeJsonFile(agentDir, MODELS_FILE_NAME, sdkSafe);

      const modelRegistry = await discoverModels(discoverAuthStorage(agentDir), agentDir);

      expect(modelRegistry.getError?.()).toBeUndefined();
      const all = modelRegistry.getAll() as RegistryModel[];
      const found = all.find((entry) => entry.id === "gemini-3-pro-preview");
      expect(found?.input).toEqual(["text", "image"]);
      // No audio is synthesized without a master-file declaration.
      expect(found?.input).not.toContain("audio");
    });
  });

  it("falls back to models.json without crashing when dennou.models.json is malformed", async () => {
    await withAgentDir(async (agentDir) => {
      writeGoogleAuthProfile(agentDir);
      const sdkSafe = buildSdkSafeConfig();
      await writeJsonFile(agentDir, MODELS_FILE_NAME, sdkSafe);
      await fs.writeFile(path.join(agentDir, DENNOU_MODELS_FILE_NAME), "{ not json !!\n");

      const modelRegistry = await discoverModels(discoverAuthStorage(agentDir), agentDir);

      expect(modelRegistry.getError?.()).toBeUndefined();
      const all = modelRegistry.getAll() as RegistryModel[];
      expect(all.some((entry) => entry.id === "gemini-3-pro-preview")).toBe(true);
      // The malformed master file must not clobber the existing models.json.
      const modelsFile = (await readJsonFile(agentDir, MODELS_FILE_NAME)) as {
        providers: {
          google: { models: Array<{ id: string; input: string[] }> };
        };
      };
      expect(modelsFile.providers.google.models[0]?.input).toEqual(["text", "image"]);
    });
  });
});

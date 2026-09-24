import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  MINIMAX_OAUTH_MARKER,
  NON_ENV_SECRETREF_MARKER,
  OLLAMA_LOCAL_AUTH_MARKER,
} from "./model-auth-markers.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

type ProvidersMap = Awaited<ReturnType<typeof resolveImplicitProvidersForTest>>;
type ExplicitProviders = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;
type MatrixCase = {
  name: string;
  env?: NodeJS.ProcessEnv;
  authProfiles?: Record<string, unknown>;
  explicitProviders?: ExplicitProviders;
  assertProviders: (providers: ProvidersMap) => void;
};

const MATRIX_CASES: MatrixCase[] = [
  {
    name: "env api key injects a simple provider",
    env: { NVIDIA_API_KEY: "test-nvidia-key" }, // pragma: allowlist secret
    assertProviders(providers) {
      expect(providers?.nvidia?.apiKey).toBe("NVIDIA_API_KEY");
      expect(providers?.nvidia?.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
      expect(providers?.nvidia?.models?.length).toBeGreaterThan(0);
    },
  },
  {
    name: "env api key injects paired plan providers",
    env: { VOLCANO_ENGINE_API_KEY: "test-volcengine-key" }, // pragma: allowlist secret
    assertProviders(providers) {
      expect(providers?.volcengine?.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(providers?.["volcengine-plan"]?.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(providers?.["volcengine-plan"]?.api).toBe("openai-completions");
    },
  },
  {
    name: "non-env secret refs preserve compatibility markers",
    env: {},
    authProfiles: {
      "byteplus:default": {
        type: "api_key",
        provider: "byteplus",
        key: "runtime-byteplus-key",
        keyRef: { source: "file", provider: "vault", id: "/byteplus/apiKey" },
      },
    },
    assertProviders(providers) {
      expect(providers?.byteplus?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
      expect(providers?.["byteplus-plan"]?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    },
  },
  {
    name: "explicit vllm config suppresses implicit vllm injection",
    env: { VLLM_API_KEY: "test-vllm-key" }, // pragma: allowlist secret
    explicitProviders: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        api: "openai-completions",
        models: [],
      },
    },
    assertProviders(providers) {
      expect(providers?.vllm).toBeUndefined();
    },
  },
  {
    name: "explicit ollama models still normalize the returned provider",
    env: {},
    explicitProviders: {
      ollama: {
        baseUrl: "http://remote-ollama:11434/v1",
        models: [
          {
            id: "gpt-oss:20b",
            name: "GPT-OSS 20B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 81920,
          },
        ],
      },
    },
    assertProviders(providers) {
      expect(providers?.ollama?.baseUrl).toBe("http://remote-ollama:11434");
      expect(providers?.ollama?.api).toBe("ollama");
      expect(providers?.ollama?.apiKey).toBe(OLLAMA_LOCAL_AUTH_MARKER);
      expect(providers?.ollama?.models).toHaveLength(1);
    },
  },
];

describe("implicit provider resolution matrix", () => {
  it.each(MATRIX_CASES)(
    "$name",
    async ({ env, authProfiles, explicitProviders, assertProviders }) => {
      const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
      const providers = await resolveImplicitProvidersForTest({
        agentDir,
        env,
        explicitProviders,
      });

      assertProviders(providers);
    },
    240_000,
  );
});

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { DEFAULT_COPILOT_API_BASE_URL } from "./github-copilot-token.js";
import {
  installModelsConfigTestHooks,
  mockCopilotTokenExchangeSuccess,
  withUnsetCopilotTokenEnv,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

installModelsConfigTestHooks({ restoreFetch: true });

async function readCopilotBaseUrl(agentDir: string) {
  const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    providers: Record<string, { baseUrl?: string }>;
  };
  return parsed.providers["github-copilot"]?.baseUrl;
}

describe("models-config", () => {
  it("falls back to default baseUrl when token exchange fails", async () => {
    await withTempHome(async () => {
      await withEnvAsync({ COPILOT_GITHUB_TOKEN: "gh-token" }, async () => {
        const fetchMock = vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: async () => ({ message: "boom" }),
        });
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const { agentDir } = await ensureOpenClawModelsJson({ models: { providers: {} } });
        expect(await readCopilotBaseUrl(agentDir)).toBe(DEFAULT_COPILOT_API_BASE_URL);
      });
    });
  });
});

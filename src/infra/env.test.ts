import { describe, expect, it, vi } from "vitest";
import { isTruthyEnvValue, logAcceptedEnvOption, normalizeEnv, normalizeZaiEnv } from "./env.js";

function createLog() {
  return { info: vi.fn<(message: string) => void>() };
}

describe("normalizeZaiEnv", () => {
  it("copies Z_AI_API_KEY to ZAI_API_KEY when missing", () => {
    const env: NodeJS.ProcessEnv = { ZAI_API_KEY: "", Z_AI_API_KEY: "zai-legacy" };
    normalizeZaiEnv(env);
    expect(env.ZAI_API_KEY).toBe("zai-legacy");
  });

  it("does not override existing ZAI_API_KEY", () => {
    const env: NodeJS.ProcessEnv = { ZAI_API_KEY: "zai-current", Z_AI_API_KEY: "zai-legacy" };
    normalizeZaiEnv(env);
    expect(env.ZAI_API_KEY).toBe("zai-current");
  });

  it("ignores blank legacy Z_AI_API_KEY values", () => {
    const env: NodeJS.ProcessEnv = { ZAI_API_KEY: "", Z_AI_API_KEY: "   " };
    normalizeZaiEnv(env);
    expect(env.ZAI_API_KEY).toBe("");
  });

  it("does not copy when legacy Z_AI_API_KEY is unset", () => {
    const env: NodeJS.ProcessEnv = { ZAI_API_KEY: "" };
    normalizeZaiEnv(env);
    expect(env.ZAI_API_KEY).toBe("");
  });
});

describe("isTruthyEnvValue", () => {
  it("accepts common truthy values", () => {
    expect(isTruthyEnvValue("1")).toBe(true);
    expect(isTruthyEnvValue("true")).toBe(true);
    expect(isTruthyEnvValue(" yes ")).toBe(true);
    expect(isTruthyEnvValue("ON")).toBe(true);
  });

  it("rejects other values", () => {
    expect(isTruthyEnvValue("0")).toBe(false);
    expect(isTruthyEnvValue("false")).toBe(false);
    expect(isTruthyEnvValue("")).toBe(false);
    expect(isTruthyEnvValue(undefined)).toBe(false);
  });
});

describe("logAcceptedEnvOption", () => {
  it("logs accepted env options once with redaction and formatting", () => {
    const log = createLog();
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "development",
      DENNOU_TEST_ENV: "  line one\nline two  ",
    };
    const option = { key: "DENNOU_TEST_ENV", description: "test option", redact: true };

    logAcceptedEnvOption(option, { env, log });
    logAcceptedEnvOption(option, { env, log });

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("env: DENNOU_TEST_ENV=<redacted> (test option)");
  });

  it("skips blank values and test-mode logging", () => {
    const log = createLog();

    logAcceptedEnvOption(
      { key: "DENNOU_BLANK_ENV", description: "skipped in test" },
      { env: { VITEST: "1", NODE_ENV: "development", DENNOU_BLANK_ENV: "value" }, log },
    );
    logAcceptedEnvOption(
      { key: "DENNOU_BLANK_ENV", description: "blank value" },
      { env: { NODE_ENV: "development", DENNOU_BLANK_ENV: "   " }, log },
    );

    expect(log.info).not.toHaveBeenCalled();
  });
});

describe("normalizeEnv", () => {
  it("normalizes the legacy ZAI env alias", () => {
    const env: NodeJS.ProcessEnv = { ZAI_API_KEY: "", Z_AI_API_KEY: "zai-legacy" };
    normalizeEnv(env);
    expect(env.ZAI_API_KEY).toBe("zai-legacy");
  });
});

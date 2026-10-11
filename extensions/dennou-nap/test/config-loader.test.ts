import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SYSTEM_ONE_ENDPOINT,
  DEFAULT_SYSTEM_ONE_MODEL,
  loadDennouNapConfig,
} from "../src/config-loader.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // クリーンアップ失敗は無視。
    }
  }
});

function tempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dennou-nap-cfg-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

const missingPath = (): string =>
  path.join(os.tmpdir(), `dennou-nap-missing-${Date.now()}-${Math.random()}.json`);

describe("config-loader", () => {
  it("dennou-aibou.json が無ければ既定値（Jev）を返す", () => {
    const cfg = loadDennouNapConfig({
      dennouConfigPath: missingPath(),
      env: {},
    });
    expect(cfg.source).toBe("default");
    expect(cfg.systemOne.endpoint).toBe(DEFAULT_SYSTEM_ONE_ENDPOINT);
    expect(cfg.systemOne.model).toBe(DEFAULT_SYSTEM_ONE_MODEL);
    expect(cfg.timeoutMs).toBe(2000);
    expect(cfg.concurrency).toBe(8);
    expect(cfg.confidenceThreshold).toBe(0.6);
  });

  it("dennou-aibou.json を読む", () => {
    const dennou = tempFile(
      "dennou-aibou.json",
      JSON.stringify({
        plugins: { entries: { "dennou-nap": { config: { systemOne: { model: "from-dennou" } } } } },
      }),
    );
    const cfg = loadDennouNapConfig({
      dennouConfigPath: dennou,
      env: {},
    });
    expect(cfg.source).toBe("dennou");
    expect(cfg.systemOne.model).toBe("from-dennou");
  });

  it("env がファイル設定を上書きする", () => {
    const dennou = tempFile(
      "dennou-aibou.json",
      JSON.stringify({
        plugins: { entries: { "dennou-nap": { config: { systemOne: { model: "file-model" } } } } },
      }),
    );
    const cfg = loadDennouNapConfig({
      dennouConfigPath: dennou,
      env: { NAP_SYSTEMONE_MODEL: "env-model" },
    });
    expect(cfg.source).toBe("dennou");
    expect(cfg.systemOne.model).toBe("env-model");
  });

  it("env だけでも source=env になる", () => {
    const cfg = loadDennouNapConfig({
      dennouConfigPath: missingPath(),
      env: { NAP_SYSTEMONE_ENDPOINT: "http://localhost:8888/v1/systemone" },
    });
    expect(cfg.source).toBe("env");
    expect(cfg.systemOne.endpoint).toBe("http://localhost:8888/v1/systemone");
    expect(cfg.systemOne.model).toBe(DEFAULT_SYSTEM_ONE_MODEL);
  });

  it("壊れた JSON は無視して既定値に倒す", () => {
    const broken = tempFile("broken.json", "{not json{{{");
    const cfg = loadDennouNapConfig({
      dennouConfigPath: broken,
      env: {},
    });
    expect(cfg.source).toBe("default");
    expect(cfg.systemOne.model).toBe(DEFAULT_SYSTEM_ONE_MODEL);
  });

  it("systemOne.fallback をファイルから読む", () => {
    const dennou = tempFile(
      "dennou-aibou.json",
      JSON.stringify({
        plugins: {
          entries: {
            "dennou-nap": {
              config: {
                systemOne: {
                  endpoint: "http://localhost:8888/v1/systemone",
                  model: "laya-multilingual",
                  fallback: {
                    endpoint: "https://api.experientiallabs.ai/v1/systemone",
                    model: "jev-latest",
                  },
                },
              },
            },
          },
        },
      }),
    );
    const cfg = loadDennouNapConfig({
      dennouConfigPath: dennou,
      env: {},
    });
    expect(cfg.source).toBe("dennou");
    expect(cfg.systemOne.endpoint).toBe("http://localhost:8888/v1/systemone");
    expect(cfg.systemOne.fallback?.endpoint).toBe("https://api.experientiallabs.ai/v1/systemone");
    expect(cfg.systemOne.fallback?.model).toBe("jev-latest");
  });

  it("fallback の env オーバーライドが効く", () => {
    const cfg = loadDennouNapConfig({
      dennouConfigPath: missingPath(),
      env: {
        NAP_SYSTEMONE_FALLBACK_ENDPOINT: "https://api.experientiallabs.ai/v1/systemone",
        NAP_SYSTEMONE_FALLBACK_MODEL: "jev-latest",
        NAP_SYSTEMONE_FALLBACK_API_KEY: "secret",
      },
    });
    expect(cfg.source).toBe("env");
    expect(cfg.systemOne.fallback?.endpoint).toBe("https://api.experientiallabs.ai/v1/systemone");
    expect(cfg.systemOne.fallback?.model).toBe("jev-latest");
    expect(cfg.systemOne.fallback?.apiKey).toBe("secret");
  });

  it("fallback 未設定なら undefined のまま", () => {
    const cfg = loadDennouNapConfig({
      dennouConfigPath: missingPath(),
      env: {},
    });
    expect(cfg.systemOne.fallback).toBeUndefined();
  });

  it("既定値は maxKeptRatio=0.25・protectRecentChapters=250", () => {
    const cfg = loadDennouNapConfig({
      dennouConfigPath: missingPath(),
      env: {},
    });
    expect(cfg.maxKeptRatio).toBe(0.25);
    expect(cfg.protectRecentChapters).toBe(250);
  });

  it("ファイルから maxKeptRatio / protectRecentChapters を読む", () => {
    const dennou = tempFile(
      "dennou-aibou.json",
      JSON.stringify({
        plugins: {
          entries: { "dennou-nap": { config: { maxKeptRatio: 0.1, protectRecentChapters: 5 } } },
        },
      }),
    );
    const cfg = loadDennouNapConfig({
      dennouConfigPath: dennou,
      env: {},
    });
    expect(cfg.maxKeptRatio).toBe(0.1);
    expect(cfg.protectRecentChapters).toBe(5);
  });

  it("範囲外の maxKeptRatio は既定に倒す", () => {
    const dennou = tempFile(
      "dennou-aibou.json",
      JSON.stringify({
        plugins: { entries: { "dennou-nap": { config: { maxKeptRatio: 0.9 } } } },
      }),
    );
    const cfg = loadDennouNapConfig({
      dennouConfigPath: dennou,
      env: {},
    });
    expect(cfg.maxKeptRatio).toBe(0.25);
  });

  it("env で maxKeptRatio / protectRecentChapters を上書きできる", () => {
    const cfg = loadDennouNapConfig({
      dennouConfigPath: missingPath(),
      env: { NAP_MAX_KEPT_RATIO: "0.15", NAP_PROTECT_RECENT_CHAPTERS: "7" },
    });
    expect(cfg.source).toBe("env");
    expect(cfg.maxKeptRatio).toBe(0.15);
    expect(cfg.protectRecentChapters).toBe(7);
  });
});

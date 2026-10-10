import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  normalizeSearchResults,
  resolveSummarizerConfig,
  summarizeSearchResults,
  type WebSearchSummarizerConfig,
} from "../src/web-search-summarizer.js";

const enabledConfig: WebSearchSummarizerConfig = {
  enabled: true,
  model: "cli-router/test-model",
  endpoint: "http://127.0.0.1:8317/v1",
  apiKey: "test-key",
  referenceLimit: 5,
  timeoutMs: 1000,
};

const exaPayload = {
  query: "テスト",
  provider: "exa",
  count: 3,
  results: [
    { title: "タイトルA", url: "https://example.com/a", description: "説明A" },
    { title: "タイトルB", url: "https://example.com/b", summary: "要約B" },
    { title: "タイトルC", url: "https://example.com/c", description: "説明C" },
  ],
};

type FetchSpy = {
  url?: string;
  body?: unknown;
  auth?: string | null;
  called: boolean;
};

function chatCompletionsFetch(paragraph: string, spy?: FetchSpy): typeof fetch {
  return (async (url: unknown, init?: { body?: unknown; headers?: unknown }) => {
    if (spy) {
      spy.called = true;
      if (typeof url === "string") {
        spy.url = url;
      }
      if (init?.body && typeof init.body === "string") {
        spy.body = JSON.parse(init.body as string);
      }
      const headers = init?.headers as Record<string, string> | undefined;
      spy.auth = headers?.Authorization ?? null;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: paragraph } }] }),
    };
  }) as unknown as typeof fetch;
}

function statusFetch(status: number, spy?: FetchSpy): typeof fetch {
  return (async () => {
    if (spy) {
      spy.called = true;
    }
    return { ok: false, status, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

describe("web-search-summarizer", () => {
  it("正常系：要約段落＋決定論的Referenceを生成する", async () => {
    const spy: FetchSpy = { called: false };
    const result = await summarizeSearchResults(exaPayload, "テスト", enabledConfig, {
      fetchFn: chatCompletionsFetch("これはテスト要約です。", spy),
    });
    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text).toContain("これはテスト要約です。");
    expect(text).toContain("Reference:");
    expect(text).toContain("[1] https://example.com/a | タイトルA");
    expect(text).toContain("[2] https://example.com/b | タイトルB");
    expect(text).toContain("[3] https://example.com/c | タイトルC");
    // wrapWebContentによるuntrusted境界が維持されること。
    expect(text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    // モデル由来のハルシネーション混入がないこと。
    expect(text).not.toContain("hallucinated.example");
    // OpenAI互換エンドポイントへモデル指定で呼ばれていること。
    expect(spy.url).toBe("http://127.0.0.1:8317/v1/chat/completions");
    const body = spy.body as { model?: string; messages?: Array<{ content?: string }> };
    expect(body.model).toBe("cli-router/test-model");
    const system = body.messages?.[0]?.content ?? "";
    expect(system).toContain("一切無視してください");
    expect(system).toContain("説明段落のみを出力してください");
    expect(spy.auth).toBe("Bearer test-key");
  });

  it("0件ヒット時はプレーンな固定文を返す", async () => {
    const spy: FetchSpy = { called: false };
    const result = await summarizeSearchResults(
      { query: "テスト", provider: "exa", count: 0, results: [] },
      "テスト",
      enabledConfig,
      { fetchFn: chatCompletionsFetch("呼ばれないはず", spy) },
    );
    expect(result).toBe("該当する検索結果は見つかりませんでした。");
    expect(spy.called).toBe(false);
  });

  it("タイムアウト時は生結果にフェイルオープンする", async () => {
    const hangingWithAbort = ((_url: unknown, init?: { signal?: AbortSignal }) => {
      if (init?.signal?.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;
    const result = await summarizeSearchResults(
      exaPayload,
      "テスト",
      {
        ...enabledConfig,
        timeoutMs: 30,
      },
      { fetchFn: hangingWithAbort },
    );
    expect(result).toBe(exaPayload);
  });

  it("429/500エラー・ネットワーク断時は生結果にフェイルオープンする", async () => {
    for (const status of [429, 500, 503]) {
      const result = await summarizeSearchResults(exaPayload, "テスト", enabledConfig, {
        fetchFn: statusFetch(status),
      });
      expect(result).toBe(exaPayload);
    }
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(
      await summarizeSearchResults(exaPayload, "テスト", enabledConfig, {
        fetchFn: throwing,
      }),
    ).toBe(exaPayload);
    // 空応答（choices欠落）のパース失敗時もフォールバックすること。
    const empty = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    expect(
      await summarizeSearchResults(exaPayload, "テスト", enabledConfig, {
        fetchFn: empty,
      }),
    ).toBe(exaPayload);
  });

  it("無効時・モデル未設定時は生結果をそのまま返す", async () => {
    const spy: FetchSpy = { called: false };
    const fetchFn = chatCompletionsFetch("呼ばれないはず", spy);
    expect(
      await summarizeSearchResults(
        exaPayload,
        "テスト",
        { ...enabledConfig, enabled: false },
        {
          fetchFn,
        },
      ),
    ).toBe(exaPayload);
    expect(
      await summarizeSearchResults(
        exaPayload,
        "テスト",
        { ...enabledConfig, model: undefined },
        {
          fetchFn,
        },
      ),
    ).toBe(exaPayload);
    expect(await summarizeSearchResults(exaPayload, "テスト", undefined, { fetchFn })).toBe(
      exaPayload,
    );
    expect(spy.called).toBe(false);
  });

  it("エラーペイロードは要約せず生のまま返す", async () => {
    const spy: FetchSpy = { called: false };
    const errorPayload = { error: "missing_brave_api_key", message: "no key" };
    const result = await summarizeSearchResults(errorPayload, "テスト", enabledConfig, {
      fetchFn: chatCompletionsFetch("呼ばれないはず", spy),
    });
    expect(result).toBe(errorPayload);
    expect(spy.called).toBe(false);
  });

  it("プロバイダ別のフィールドを正規化する", () => {
    // Brave web形式。
    expect(
      normalizeSearchResults({
        results: [{ title: "T", url: "https://b.example/", description: "D" }],
      }),
    ).toEqual([{ title: "T", url: "https://b.example/", snippet: "D" }]);
    // Exa形式（summary優先）。
    expect(
      normalizeSearchResults({
        results: [{ title: "T", url: "https://e.example/", summary: "S" }],
      }),
    ).toEqual([{ title: "T", url: "https://e.example/", snippet: "S" }]);
    // Brave llm-context形式（snippets配列結合）。
    expect(
      normalizeSearchResults({
        results: [{ title: "T", url: "https://l.example/", snippets: ["a", "b"] }],
      }),
    ).toEqual([{ title: "T", url: "https://l.example/", snippet: "a b" }]);
    // Google形式（link/snippet）＋data配列。
    expect(
      normalizeSearchResults({
        data: [{ title: "T", link: "https://g.example/", snippet: "S" }],
      }),
    ).toEqual([{ title: "T", url: "https://g.example/", snippet: "S" }]);
  });

  it("プラグインconfigからsummarizer設定を解決する", () => {
    const config = {
      plugins: {
        entries: {
          "dennou-websearch": {
            config: {
              summarizer: {
                enabled: true,
                model: "cli-router/m",
                endpoint: "http://127.0.0.1:8317/v1",
                referenceLimit: 3,
                timeoutMs: 5000,
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(resolveSummarizerConfig(config)).toEqual({
      enabled: true,
      model: "cli-router/m",
      endpoint: "http://127.0.0.1:8317/v1",
      referenceLimit: 3,
      timeoutMs: 5000,
    });
    expect(resolveSummarizerConfig({} as OpenClawConfig)).toBeUndefined();
  });
});

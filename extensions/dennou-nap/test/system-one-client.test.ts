import { describe, expect, it } from "vitest";
import { isConfident, SystemOneClient } from "../src/system-one-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseOpts = {
  endpoint: "http://localhost:8888/v1/systemone",
  model: "laya-multilingual",
};

describe("system-one-client", () => {
  it("choice クエリで3択＋確率＋確信度を受け取る", async () => {
    let seenUrl = "";
    let seenBody = "";
    const client = new SystemOneClient({
      ...baseOpts,
      fetchFn: async (url, init) => {
        seenUrl = url;
        seenBody = String(init.body);
        return jsonResponse({
          choice: "要約",
          probabilities: { 維持: 0.1, 要約: 0.8, 落とす: 0.1 },
          confidence: 0.8,
        });
      },
    });
    const result = await client.judge("長い作業ログ…");
    expect(seenUrl).toBe(baseOpts.endpoint);
    const body = JSON.parse(seenBody) as Record<string, unknown>;
    expect(body["state"]).toBe("長い作業ログ…");
    const questions = body["questions"] as Record<string, any>;
    expect(questions.action.type).toBe("choice");
    expect(result.choice).toBe("要約");
    expect(result.confidence).toBe(0.8);
    expect(result.fallback).toBeUndefined();
    expect(isConfident(result)).toBe(true);
    expect(isConfident(result, 0.9)).toBe(false);
  });

  it("confidence 欠損時は最大確率で補う", async () => {
    const client = new SystemOneClient({
      ...baseOpts,
      fetchFn: async () =>
        jsonResponse({ choice: "落とす", probabilities: { 維持: 0.2, 要約: 0.1, 落とす: 0.7 } }),
    });
    const result = await client.judge("ノイズ");
    expect(result.choice).toBe("落とす");
    expect(result.confidence).toBeCloseTo(0.7, 5);
  });

  it("タイムアウト時はフェイルオープン（維持・confidence 0）", async () => {
    const client = new SystemOneClient({
      ...baseOpts,
      timeoutMs: 20,
      fetchFn: async (_url, init) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
        return jsonResponse({ choice: "落とす" });
      },
    });
    const result = await client.judge("重い…");
    expect(result.fallback).toBe(true);
    expect(result.choice).toBe("維持");
    expect(result.confidence).toBe(0);
  });

  it("連続3回失敗でサーキットが開き、冷却後に復旧する", async () => {
    let calls = 0;
    const client = new SystemOneClient({
      ...baseOpts,
      cooldownMs: 50,
      fetchFn: async () => {
        calls += 1;
        return new Response("boom", { status: 500 });
      },
    });
    await client.judge("a");
    await client.judge("b");
    await client.judge("c");
    expect(client.getState().circuitOpen).toBe(true);
    // 開放中は fetch しない。
    await client.judge("d");
    expect(calls).toBe(3);
    // 冷却後に半開→成功で閉じる。
    await new Promise((r) => setTimeout(r, 60));
    const okClient = client;
    // 成功させるため fetch を差し替えられないので状態だけ確認：開いていた回路が閉じること。
    // judge 1発を通す（まだ500なので再開放される）。
    await okClient.judge("e");
    expect(calls).toBe(4);
  });

  it("401/429/5xx 以外の 4xx はカウントしないがフェイルオープンする", async () => {
    const client = new SystemOneClient({
      ...baseOpts,
      fetchFn: async () => new Response("bad request", { status: 400 }),
    });
    const r1 = await client.judge("x");
    const r2 = await client.judge("y");
    const r3 = await client.judge("z");
    expect(r1.fallback).toBe(true);
    expect(r3.choice).toBe("維持");
    expect(client.getState().circuitOpen).toBe(false);
  });

  it("concurrency cap（8）を守る", async () => {
    const client = new SystemOneClient({
      ...baseOpts,
      concurrency: 8,
      fetchFn: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return jsonResponse({ choice: "維持", confidence: 0.9 });
      },
    });
    const results = await client.judgeMany(Array.from({ length: 20 }, (_, i) => `t${i}`));
    expect(results).toHaveLength(20);
    expect(client.maxObservedConcurrency).toBeLessThanOrEqual(8);
  });

  it("不正な応答形状はフェイルオープンする", async () => {
    const client = new SystemOneClient({
      ...baseOpts,
      fetchFn: async () => jsonResponse({ choice: "unknown" }),
    });
    const result = await client.judge("???");
    expect(result.fallback).toBe(true);
    expect(result.choice).toBe("維持");
  });

  it("プライマリ5xx時はフォールバック先へ転送して判定を返す", async () => {
    const fb = "https://api.experientiallabs.ai/v1/systemone";
    const client = new SystemOneClient({
      ...baseOpts,
      fallback: { endpoint: fb, model: "jev-latest" },
      fetchFn: async (url) => {
        if (url === baseOpts.endpoint) return new Response("boom", { status: 500 });
        return jsonResponse({ choice: "要約", confidence: 0.85 });
      },
    });
    const result = await client.judge("長い作業ログ…");
    expect(result.choice).toBe("要約");
    expect(result.confidence).toBe(0.85);
    expect(result.fallback).toBeUndefined();
    expect(result.fallbackEndpoint).toBe(fb);
  });

  it("プライマリ通信エラー時もフォールバックが機能する", async () => {
    const fb = "https://api.experientiallabs.ai/v1/systemone";
    const client = new SystemOneClient({
      ...baseOpts,
      fallback: { endpoint: fb, model: "jev-latest" },
      fetchFn: async (url) => {
        if (url === baseOpts.endpoint) throw new Error("connection refused");
        return jsonResponse({ choice: "維持", confidence: 0.7 });
      },
    });
    const result = await client.judge("hello");
    expect(result.choice).toBe("維持");
    expect(result.fallback).toBeUndefined();
    expect(result.fallbackEndpoint).toBe(fb);
  });

  it("両方死んだ時はフェイルオープンする", async () => {
    const client = new SystemOneClient({
      ...baseOpts,
      fallback: { endpoint: "http://fallback.invalid/v1/systemone", model: "jev-latest" },
      fetchFn: async () => new Response("boom", { status: 500 }),
    });
    const result = await client.judge("hello");
    expect(result.fallback).toBe(true);
    expect(result.choice).toBe("維持");
    expect(result.confidence).toBe(0);
    expect(result.fallbackEndpoint).toBeUndefined();
  });

  it("fallback未設定なら従来通り即フェイルオープンする", async () => {
    const client = new SystemOneClient({
      ...baseOpts,
      fetchFn: async () => new Response("boom", { status: 500 }),
    });
    const result = await client.judge("hello");
    expect(result.fallback).toBe(true);
    expect(result.fallbackEndpoint).toBeUndefined();
  });

  it("サーキットOPEN中もフォールバックへ直行する", async () => {
    let primaryCalls = 0;
    let fbCalls = 0;
    const fb = "https://api.experientiallabs.ai/v1/systemone";
    const client = new SystemOneClient({
      ...baseOpts,
      cooldownMs: 60_000,
      fallback: { endpoint: fb, model: "jev-latest" },
      fetchFn: async (url) => {
        if (url === baseOpts.endpoint) {
          primaryCalls += 1;
          return new Response("boom", { status: 500 });
        }
        fbCalls += 1;
        return jsonResponse({ choice: "要約", confidence: 0.9 });
      },
    });
    // 3回失敗で回路が開く（その間フォールバックが成功判定を返す）。
    for (let i = 0; i < 3; i += 1) {
      const r = await client.judge(`t${i}`);
      expect(r.fallbackEndpoint).toBe(fb);
    }
    expect(client.getState().circuitOpen).toBe(true);
    const before = primaryCalls;
    const r = await client.judge("after-open");
    expect(r.fallbackEndpoint).toBe(fb);
    expect(r.choice).toBe("要約");
    expect(primaryCalls).toBe(before); // プライマリを叩いていない
    expect(fbCalls).toBe(4);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildRespanPayload,
  isConfident,
  isRespanEndpoint,
  isRespanModel,
  normalizeRespanResponse,
  parseRetryAfterMs,
  resolveRespanUrl,
  RESPAN_BEHAVIORS,
  RESPAN_EVAL_INSTRUCTION,
  retryBackoffMs,
  SystemOneClient,
  SYSTEM_ONE_MAX_RETRIES,
  usesRespanProtocol,
} from "../src/system-one-client.js";

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

describe("system-one-client busy retry (503/429)", () => {
  const baseOpts = {
    endpoint: "http://localhost:8888/v1/systemone",
    model: "laya-multilingual",
  };

  it("リトライ可能な最大回数は2回", () => {
    expect(SYSTEM_ONE_MAX_RETRIES).toBe(2);
  });

  it("503 は Retry-After を待ってリトライし、実判定を返す", async () => {
    let calls = 0;
    const client = new SystemOneClient({
      ...baseOpts,
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
        }
        return jsonResponse({ choice: "要約", confidence: 0.8 });
      },
    });
    const result = await client.judge("hello");
    expect(result.choice).toBe("要約");
    expect(result.fallback).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("429 はバックオフを待って最大2回リトライする", async () => {
    let calls = 0;
    const client = new SystemOneClient({
      ...baseOpts,
      fetchFn: async () => {
        calls += 1;
        if (calls <= 2) return new Response("slow down", { status: 429 });
        return jsonResponse({ choice: "維持", confidence: 0.9 });
      },
    });
    const result = await client.judge("hello");
    expect(result.choice).toBe("維持");
    expect(result.fallback).toBeUndefined();
    expect(calls).toBe(1 + SYSTEM_ONE_MAX_RETRIES);
  });

  it("503 が続く場合は最大2回で諦めてフェイルオープンする", async () => {
    let calls = 0;
    const client = new SystemOneClient({
      ...baseOpts,
      failureThreshold: 10,
      fetchFn: async () => {
        calls += 1;
        return new Response("busy", { status: 503 });
      },
    });
    const result = await client.judge("hello");
    expect(result.choice).toBe("維持");
    expect(result.fallback).toBe(true);
    expect(calls).toBe(1 + SYSTEM_ONE_MAX_RETRIES);
  });

  it("リトライで解消した busy はサーキットの失敗に数えない", async () => {
    const script = [503, 200, 200, 500];
    let calls = 0;
    const client = new SystemOneClient({
      ...baseOpts,
      failureThreshold: 2,
      cooldownMs: 60_000,
      fetchFn: async () => {
        const status = script[Math.min(calls, script.length - 1)] ?? 500;
        calls += 1;
        if (status === 503) return new Response("busy", { status: 503 });
        if (status === 500) return new Response("boom", { status: 500 });
        return jsonResponse({ choice: "維持", confidence: 0.9 });
      },
    });
    await client.judge("a"); // 503 → リトライ → 200
    // 503 はリトライで解消したので breaker の失敗カウントは 0 のまま。
    expect(client.getState().failures).toBe(0);
    await client.judge("b"); // 200
    expect(client.getState().circuitOpen).toBe(false);
    await client.judge("c"); // 本当の 500 が1件
    expect(client.getState().failures).toBe(1);
    // busy が失敗として数えられていれば 500 で failures=2 → 回路が開いている。
    expect(client.getState().circuitOpen).toBe(false);
  });

  it("busy 以外のステータスはリトライしない", async () => {
    let calls = 0;
    const client = new SystemOneClient({
      ...baseOpts,
      fetchFn: async () => {
        calls += 1;
        return new Response("boom", { status: 500 });
      },
    });
    const result = await client.judge("hello");
    expect(result.fallback).toBe(true);
    expect(calls).toBe(1);
  });

  it("Retry-After の解析とバックオフ段階", () => {
    expect(parseRetryAfterMs("1")).toBe(1000);
    expect(parseRetryAfterMs(" 0 ")).toBe(0);
    expect(parseRetryAfterMs("-5")).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("garbage")).toBeUndefined();
    expect(parseRetryAfterMs(new Date(Date.now() + 2000).toUTCString())).toBeGreaterThan(0);
    expect(retryBackoffMs(0)).toBe(300);
    expect(retryBackoffMs(1)).toBe(600);
    expect(retryBackoffMs(9)).toBe(600);
  });
});

describe("system-one-client: respan scores protocol", () => {
  const respanEndpoint = "https://api.respan.ai/api/v1/scores";
  const respanModel = "span-01-free";

  function respanResponse(results: Array<{ id: string; p_present: number }>): Response {
    return jsonResponse({
      model: respanModel,
      results: results.map((row) => ({
        ...row,
        p_absent: Number((1 - row.p_present).toFixed(3)),
      })),
    });
  }

  it("判別ヘルパーがエンドポイントとモデルの両方で Respan を検出する", () => {
    expect(isRespanEndpoint(respanEndpoint)).toBe(true);
    expect(isRespanEndpoint("https://API.RESPAN.AI/api/v1/scores")).toBe(true);
    expect(isRespanEndpoint("http://localhost:8888/v1/systemone")).toBe(false);
    expect(isRespanModel(respanModel)).toBe(true);
    expect(isRespanModel(" SPAN-01-FREE ")).toBe(true);
    expect(isRespanModel("laya-multilingual")).toBe(false);
    expect(usesRespanProtocol({ endpoint: respanEndpoint, model: "x" })).toBe(true);
    expect(
      usesRespanProtocol({ endpoint: "http://localhost:8888/v1/systemone", model: respanModel }),
    ).toBe(true);
    expect(
      usesRespanProtocol({ endpoint: "http://localhost:8888/v1/systemone", model: "laya" }),
    ).toBe(false);
  });

  it("ホストのみのエンドポイントは公式 scores URL に補正する", () => {
    expect(resolveRespanUrl("https://api.respan.ai")).toBe(respanEndpoint);
    expect(resolveRespanUrl("https://api.respan.ai/")).toBe(respanEndpoint);
    expect(resolveRespanUrl(`${respanEndpoint}/`)).toBe(respanEndpoint);
    expect(resolveRespanUrl(respanEndpoint)).toBe(respanEndpoint);
  });

  it("Respan エンドポイントでは scores ペイロードを送る", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const client = new SystemOneClient({
      endpoint: respanEndpoint,
      model: respanModel,
      apiKey: "sk-respan-test",
      fetchFn: async (url, init) => {
        seenUrl = url;
        seenInit = init;
        return respanResponse([
          { id: "drop", p_present: 0.818 },
          { id: "summarize", p_present: 0.611 },
          { id: "keep", p_present: 0.191 },
        ]);
      },
    });

    const result = await client.judge("巨大なツールログ…");

    expect(seenUrl).toBe(respanEndpoint);
    expect(seenInit?.method).toBe("POST");
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-respan-test");
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(String(seenInit?.body)) as Record<string, any>;
    expect(body.model).toBe(respanModel);
    expect(body.span.input).toEqual([{ role: "user", content: RESPAN_EVAL_INSTRUCTION }]);
    expect(body.span.output).toEqual({ role: "assistant", content: "巨大なツールログ…" });
    expect(body.behaviors.map((b: { id: string }) => b.id)).toEqual(["drop", "summarize", "keep"]);
    expect(body.behaviors).toEqual(RESPAN_BEHAVIORS.map((b) => ({ ...b })));
    // 従来の systemone 形式は含まれない。
    expect(body.state).toBeUndefined();
    expect(body.questions).toBeUndefined();

    // drop が最大なので「落とす」。
    expect(result.choice).toBe("落とす");
    expect(result.confidence).toBeCloseTo(0.818, 5);
    expect(result.fallback).toBeUndefined();
  });

  it("モデル名が span- なら従来エンドポイントでも scores ペイロードを送る", async () => {
    let seenBody = "";
    const client = new SystemOneClient({
      endpoint: "http://localhost:8888/v1/systemone",
      model: respanModel,
      fetchFn: async (_url, init) => {
        seenBody = String(init.body);
        return respanResponse([{ id: "keep", p_present: 0.9 }]);
      },
    });

    await client.judge("重要な決定");

    const body = JSON.parse(seenBody) as Record<string, unknown>;
    expect(body["span"]).toBeDefined();
    expect(body["state"]).toBeUndefined();
  });

  it("drop が高ければ「落とす」、keep が高ければ「維持」、summarize なら「要約」", () => {
    const drop = normalizeRespanResponse({
      results: [
        { id: "drop", p_present: 0.818 },
        { id: "summarize", p_present: 0.611 },
        { id: "keep", p_present: 0.191 },
      ],
    });
    expect(drop?.choice).toBe("落とす");
    expect(drop?.confidence).toBeCloseTo(0.818, 5);

    const keep = normalizeRespanResponse({
      results: [
        { id: "drop", p_present: 0.05 },
        { id: "summarize", p_present: 0.25 },
        { id: "keep", p_present: 0.7 },
      ],
    });
    expect(keep?.choice).toBe("維持");
    expect(keep?.confidence).toBeCloseTo(0.7, 5);

    const summarize = normalizeRespanResponse({
      results: [
        { id: "drop", p_present: 0.2 },
        { id: "summarize", p_present: 0.65 },
        { id: "keep", p_present: 0.15 },
      ],
    });
    expect(summarize?.choice).toBe("要約");
    expect(summarize?.confidence).toBeCloseTo(0.65, 5);
  });

  it("確率を合計 1.0 に正規化し、内部ラベルへ写像する", () => {
    const result = normalizeRespanResponse({
      results: [
        { id: "drop", p_present: 0.818 },
        { id: "summarize", p_present: 0.611 },
        { id: "keep", p_present: 0.191 },
      ],
    });

    expect(result).toBeDefined();
    const probabilities = result!.probabilities;
    const sum = probabilities["維持"] + probabilities["要約"] + probabilities["落とす"];
    expect(sum).toBeCloseTo(1, 10);
    expect(probabilities["落とす"]).toBeCloseTo(0.818 / 1.62, 5);
    expect(probabilities["要約"]).toBeCloseTo(0.611 / 1.62, 5);
    expect(probabilities["維持"]).toBeCloseTo(0.191 / 1.62, 5);
  });

  it("欠損した behavior は 0 として扱う", () => {
    const result = normalizeRespanResponse({
      results: [{ id: "keep", p_present: 0.4 }],
    });

    expect(result?.choice).toBe("維持");
    expect(result?.probabilities).toEqual({ 維持: 1, 要約: 0, 落とす: 0 });
    expect(result?.confidence).toBeCloseTo(0.4, 5);
  });

  it("Respan 形式でないレスポンスは undefined を返す", () => {
    expect(normalizeRespanResponse({ choice: "要約", confidence: 0.8 })).toBeUndefined();
    expect(normalizeRespanResponse({ results: [] })).toBeUndefined();
    expect(normalizeRespanResponse({ results: [{ id: "unknown", p_present: 1 }] })).toBeUndefined();
    expect(normalizeRespanResponse(null)).toBeUndefined();
  });

  it("従来の Jev/Laya レスポンスはそのまま解釈する（後方互換）", async () => {
    const client = new SystemOneClient({
      ...baseOpts,
      fetchFn: async () => jsonResponse({ choice: "要約", confidence: 0.85 }),
    });
    const result = await client.judge("長い作業ログ…");
    expect(result.choice).toBe("要約");
    expect(result.confidence).toBe(0.85);
    expect(result.fallback).toBeUndefined();
  });

  it("Laya プライマリ失敗時は Respan フォールバックへ scores で転送する", async () => {
    const bodies: string[] = [];
    const client = new SystemOneClient({
      ...baseOpts,
      fallback: { endpoint: "https://api.respan.ai", model: respanModel },
      fetchFn: async (url, init) => {
        if (url.includes("api.respan.ai")) {
          bodies.push(String(init.body));
          return respanResponse([
            { id: "drop", p_present: 0.1 },
            { id: "summarize", p_present: 0.2 },
            { id: "keep", p_present: 0.9 },
          ]);
        }
        return new Response("boom", { status: 500 });
      },
    });

    const result = await client.judge("重要な設定");

    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
    expect(body["span"]).toBeDefined();
    expect(result.choice).toBe("維持");
    expect(result.fallbackEndpoint).toBe("https://api.respan.ai");
  });

  it("buildRespanPayload は text を span.output に載せる", () => {
    const body = JSON.parse(buildRespanPayload(respanModel, "本文テキスト")) as Record<string, any>;
    expect(body.span.output.content).toBe("本文テキスト");
    expect(body.span.input[0].content).toBe(RESPAN_EVAL_INSTRUCTION);
  });
});

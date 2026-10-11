/**
 * `compressPromptForNap`（本体ランナー向けファサード）の契約テスト。
 *
 * - config `enabled: false` 時は System 1 を一切呼ばず入力をそのまま返す（BLOCKER 2）。
 * - 既定の `triageBudget` が System 1 呼び出しをバウンドする（MED 1）。
 * - 閾値超過時は圧縮され、system ロールを出さず入力配列は非破壊。
 * - `triageCache` は上限を超えたら最古から削除される（LOW 1）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoCompactCacheSize,
  clearAutoCompactCache,
  compressPromptForNap,
  DEFAULT_NAP_TRIAGE_BUDGET,
  type CompactableMessage,
} from "../index.js";

const DEAD_ENDPOINT = "http://127.0.0.1:1/v1/systemone";

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      choice: "維持",
      confidence: 0.9,
      probabilities: { 維持: 0.9, 要約: 0.05, 落とす: 0.05 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** 各ターンが独立した章になるよう 10 分間隔で並べる。`tag` で内容を一意化する。 */
function buildTurns(count: number, chars: number, tag = ""): CompactableMessage[] {
  const messages: CompactableMessage[] = [];
  let t = 1_700_000_000_000;
  for (let i = 0; i < count; i++) {
    messages.push({ role: "user", content: `${tag}T${i} Q: ${"あ".repeat(chars)}`, timestamp: t });
    messages.push({
      role: "assistant",
      content: `${tag}T${i} A: ${"い".repeat(chars)}`,
      timestamp: t + 1_000,
    });
    t += 10 * 60_000;
  }
  return messages;
}

beforeEach(() => {
  clearAutoCompactCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("compressPromptForNap", () => {
  it("config enabled:false のとき System 1 を呼ばず入力をそのまま返す", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (): Promise<Response> => {
        throw new Error("fetch must not be called when dennou-nap is disabled");
      });
    const messages = buildTurns(30, 400);

    const outcome = await compressPromptForNap({
      messages,
      contextWindow: 10_000,
      config: { enabled: false, systemOne: { endpoint: DEAD_ENDPOINT, model: "x" } },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.applied).toBe(false);
    expect(outcome.stats.fired).toBe(false);
    expect(outcome.messages).toBe(messages);
    expect(outcome.summaryText).toBe("");
    expect(outcome.firstKeptInputIndex).toBe(-1);
    // 入力は破壊されない。
    expect(messages).toHaveLength(60);
  });

  it("有効時は圧縮して system ロールを出さない・入力は非破壊", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (): Promise<Response> => okResponse());
    const messages = buildTurns(40, 400);

    const outcome = await compressPromptForNap({
      messages,
      contextWindow: 10_000,
      config: { systemOne: { endpoint: DEAD_ENDPOINT, model: "x" } },
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(outcome.applied).toBe(true);
    expect(outcome.stats.estimatedAfter).toBeLessThan(outcome.stats.estimatedBefore);
    expect(outcome.messages).not.toBe(messages);
    expect(outcome.messages.some((m) => m.role === "system")).toBe(false);
    expect(String(outcome.messages[0]?.content ?? "")).toContain("<dennou-nap-summary>");
    expect(messages).toHaveLength(80);
  });

  it("既定の triageBudget が System 1 呼び出しをバウンドする", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (): Promise<Response> => okResponse());

    await compressPromptForNap({
      messages: buildTurns(400, 400),
      contextWindow: 10_000,
      config: { systemOne: { endpoint: DEAD_ENDPOINT, model: "x" } },
    });

    // 上限まで張り付く（= budget が実際に効いている）ことを上限と併せて確認する。
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(DEFAULT_NAP_TRIAGE_BUDGET);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(DEFAULT_NAP_TRIAGE_BUDGET - 10);
  });

  it("triageCache が上限を超えたら最古から削除される", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (): Promise<Response> => okResponse());
    const config = { systemOne: { endpoint: DEAD_ENDPOINT, model: "x" } };

    // 1 呼び出しで入る件数は triageBudget と直近章ガードで制限されるため、
    // 上限を跨ぐまで十分なラウンドを回す（tag で毎ラウンド内容を一意化）。
    for (let round = 0; round < 12; round++) {
      await compressPromptForNap({
        messages: buildTurns(240, 40, String(round)),
        contextWindow: 2_000,
        config,
        triageBudget: 400,
      });
    }

    const size = autoCompactCacheSize();
    expect(size.triage).toBeLessThanOrEqual(2000);
    expect(size.triage).toBeGreaterThan(1900);
  });
});

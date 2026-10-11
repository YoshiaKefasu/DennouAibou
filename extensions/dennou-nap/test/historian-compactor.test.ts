import { describe, expect, it } from "vitest";
import { compact, composePrompt } from "../src/compactor.js";
import { buildTurns } from "../src/compartment.js";
import { buildHistorianContext, summarizeSelection } from "../src/historian.js";
import { nap } from "../src/index.js";
import type { ChatMessage, TriageResult } from "../src/types.js";

function decision(choice: TriageResult["choice"]): TriageResult {
  return {
    choice,
    confidence: 0.9,
    probabilities: { 維持: 0, 要約: 0, 落とす: 0 },
  };
}

describe("historian + compactor", () => {
  it("「落とす」を除外し、要約対象だけ一括要約する", async () => {
    const turns = buildTurns([
      { role: "user", content: "大事な方針" },
      { role: "user", content: "長い作業ログ…" },
      { role: "user", content: "雑談ノイズ" },
    ]);
    const decisions = [decision("維持"), decision("要約"), decision("落とす")];
    const context = buildHistorianContext(turns, decisions);
    expect(context).toContain("大事な方針");
    expect(context).toContain("長い作業ログ");
    expect(context).not.toContain("雑談ノイズ");

    let batchCalls = 0;
    const historian = await summarizeSelection(turns, decisions, (texts) => {
      batchCalls += 1;
      return `SUMMARY(${texts.length}): ${texts.join("|")}`;
    });
    expect(batchCalls).toBe(1);
    expect(historian.summarizedIds).toEqual([1]);
    expect(historian.summary).toContain("長い作業ログ");
  });

  it("要約対象ゼロなら空要約・summarizer不発", async () => {
    const turns = buildTurns([{ role: "user", content: "hi" }]);
    let called = false;
    const historian = await summarizeSelection(turns, [decision("維持")], () => {
      called = true;
      return "x";
    });
    expect(called).toBe(false);
    expect(historian.summary).toBe("");
  });

  it("合成は維持原文＋要約を含み、落とすを含まない", () => {
    const turns = buildTurns([
      { role: "user", content: "KEEP-ME" },
      { role: "user", content: "SUMMARIZE-ME" },
      { role: "user", content: "DROP-ME" },
    ]);
    const decisions = [decision("維持"), decision("要約"), decision("落とす")];
    const result = compact(turns, decisions, "SUMMARIZED");
    expect(result.promptPrefix).toContain("KEEP-ME");
    expect(result.promptPrefix).toContain("SUMMARIZED");
    expect(result.promptPrefix).not.toContain("DROP-ME");
    expect(result.promptPrefix).not.toContain("SUMMARIZE-ME");
    expect(result.droppedCount).toBe(1);
    expect(result.reversible).toBe(true);
  });

  it("入力メッセージ配列を破壊しない（可逆）", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "a", timestamp: 0 },
      { role: "assistant", content: "b", timestamp: 1 },
    ];
    const snapshot = JSON.stringify(messages);
    const fakeClient = {
      judgeMany: async (texts: string[]): Promise<TriageResult[]> =>
        texts.map(() => decision("維持")),
    };
    const result = await nap(messages, { client: fakeClient });
    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(result.promptPrefix).toContain("a");
    expect(result.droppedCount).toBe(0);
    expect(result.chapters).toHaveLength(1);
  });

  it("composePrompt: 要約だけ・維持だけの両端を通す", () => {
    expect(composePrompt([], "S")).toContain("S");
    const turns = buildTurns([{ role: "user", content: "K" }]);
    expect(composePrompt(turns, "")).toContain("K");
  });
});

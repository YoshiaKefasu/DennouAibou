import { describe, expect, it } from "vitest";
import { buildTurns, splitIntoChapters } from "../src/compartment.js";
import type { ChatMessage } from "../src/types.js";

const MIN = 60_000;

function msg(role: ChatMessage["role"], content: string, timestamp?: number): ChatMessage {
  return timestamp === undefined ? { role, content } : { role, content, timestamp };
}

describe("compartment", () => {
  it("User/Assistant/Tool束を不可分なターンにまとめる", () => {
    const turns = buildTurns([
      msg("user", "調べて", 0),
      msg("assistant", "了解", 1),
      msg("tool", "結果1", 2),
      msg("tool", "結果2", 3),
      msg("user", "次は？", 4),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(turns[1]?.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("先頭の非User群は Turn 0 にまとめる", () => {
    const turns = buildTurns([msg("system", "sys", 0), msg("assistant", "hi", 1)]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.id).toBe(0);
  });

  it("「間」で章を割る（既定5分）", () => {
    const chapters = splitIntoChapters([
      msg("user", "おはよう", 0),
      msg("assistant", "おはよう", 1_000),
      msg("user", "ただいま", 60 * MIN),
      msg("assistant", "おかえり", 60 * MIN + 1_000),
    ]);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]?.turns).toHaveLength(1);
    expect(chapters[1]?.turns).toHaveLength(1);
    expect(chapters[1]?.gapBeforeMs).toBeGreaterThan(5 * MIN);
  });

  it("ターン真ん中の「間」では割らず、ターン境界でのみ割る（原子性）", () => {
    // 1ターン内で assistant 応答が10分遅れても割らない。
    const chapters = splitIntoChapters([
      msg("user", "重い調査して", 0),
      msg("tool", "途中経過", 10 * MIN),
      msg("assistant", "完了", 11 * MIN),
      msg("user", "ありがとう", 12 * MIN),
    ]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.turns).toHaveLength(2);
    expect(chapters[0]?.turns[0]?.messages).toHaveLength(3);
  });

  it("timestamp 欠損では分割しない", () => {
    const chapters = splitIntoChapters([msg("user", "a"), msg("assistant", "b"), msg("user", "c")]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.turns).toHaveLength(2);
  });

  it("空会話は空章リスト", () => {
    expect(splitIntoChapters([])).toEqual([]);
  });

  it("ISO文字列timestampでも「間」を検知して章を割る（Kasou実データ）", () => {
    const chapters = splitIntoChapters([
      { role: "user", content: "おはよう", timestamp: "2026-10-08T00:00:00.000Z" },
      { role: "assistant", content: "おはよう", timestamp: "2026-10-08T00:00:01.000Z" },
      { role: "user", content: "ただいま", timestamp: "2026-10-08T01:00:00.000Z" },
    ]);
    expect(chapters).toHaveLength(2);
    expect(chapters[1]?.gapBeforeMs).toBeGreaterThan(5 * MIN);
  });

  it("配列contentでも [object Object] にならない", () => {
    const turns = buildTurns([
      {
        role: "user",
        content: [
          { type: "text", text: "見て" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      } as unknown as ChatMessage,
    ]);
    expect(turns[0]?.text).toContain("見て");
    expect(turns[0]?.text).not.toContain("[object Object]");
  });

  it("画像内の inbound_media パスは残す", () => {
    const turns = buildTurns([
      {
        role: "user",
        content: [{ type: "image", path: "inbound_media/foo.jpg", mimeType: "image/jpeg" }],
      } as unknown as ChatMessage,
    ]);
    expect(turns[0]?.text).toContain("inbound_media/foo.jpg");
  });
});

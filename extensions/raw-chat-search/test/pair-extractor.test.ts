import { describe, expect, it } from "vitest";
import {
  extractConversationPairs,
  formatPairSnippet,
  formatPairText,
  isNoiseTurn,
  PAIR_SNIPPET_MAX_LENGTH,
} from "../src/pair-extractor.js";
import type { PairWindowMessage } from "../src/types.js";

function msg(
  id: number,
  role: string,
  text: string,
  sessionId = "sess-1",
  timestampIso = "2026-04-08T10:00:00.000Z",
): PairWindowMessage {
  return { id, sessionId, role, text, timestampIso };
}

describe("pair-extractor: extractConversationPairs", () => {
  it("extracts a single user/assistant round trip", () => {
    const pairs = extractConversationPairs([
      msg(1, "user", "このライブラリの設定ってどうするんだっけ？"),
      msg(2, "assistant", "設定ファイルに追加して、ポートを8317にすれば動くよ！"),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      baseId: 1,
      assistantId: 2,
      sessionId: "sess-1",
      userText: "このライブラリの設定ってどうするんだっけ？",
      assistantText: "設定ファイルに追加して、ポートを8317にすれば動くよ！",
      timestampIso: "2026-04-08T10:00:00.000Z",
    });
    expect(pairs[0]!.text).toBe(
      "User: このライブラリの設定ってどうするんだっけ？\nAssistant: 設定ファイルに追加して、ポートを8317にすれば動くよ！",
    );
  });

  it("extracts multiple round trips in chronological order", () => {
    const pairs = extractConversationPairs([
      msg(1, "user", "How do I set the port?"),
      msg(2, "assistant", "Add it to the config file."),
      msg(3, "user", "Which section?"),
      msg(4, "assistant", "The gateway section."),
    ]);

    expect(pairs.map((pair) => pair.baseId)).toEqual([1, 3]);
    expect(pairs.map((pair) => pair.assistantId)).toEqual([2, 4]);
  });

  it("sorts unordered input by id before pairing", () => {
    const pairs = extractConversationPairs([msg(2, "assistant", "Pong"), msg(1, "user", "Ping")]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.userText).toBe("Ping");
    expect(pairs[0]!.assistantText).toBe("Pong");
  });

  it("skips system messages entirely", () => {
    const pairs = extractConversationPairs([
      msg(1, "system", "You are Kasou, an omnipotent Cyber-VTuber partner."),
      msg(2, "user", "Are you there?"),
      msg(3, "system", "Reminder: stay in character."),
      msg(4, "assistant", "Always. What do you need?"),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.text).not.toContain("Cyber-VTuber");
    expect(pairs[0]!.text).not.toContain("stay in character");
  });

  it("ignores toolResult rows between the user turn and the reply", () => {
    const pairs = extractConversationPairs([
      msg(1, "user", "Check the disk usage"),
      msg(
        2,
        "toolResult",
        "Filesystem Size Used Avail Use% Mounted on\n/dev/sdc2 2.7T 450G 2.2T 18% /mnt/HDD",
      ),
      msg(3, "assistant", "The external drive has 2.2T available."),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.baseId).toBe(1);
    expect(pairs[0]!.assistantId).toBe(3);
    expect(pairs[0]!.text).not.toContain("Filesystem Size");
  });

  it("joins consecutive user messages into one turn (the pair base stays the first id)", () => {
    const pairs = extractConversationPairs([
      msg(1, "user", "Set up the logger"),
      msg(2, "user", "And rotate the files daily"),
      msg(3, "assistant", "Configured both."),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.baseId).toBe(1);
    expect(pairs[0]!.userText).toBe("Set up the logger And rotate the files daily");
    expect(pairs[0]!.text).toBe(
      "User: Set up the logger And rotate the files daily\nAssistant: Configured both.",
    );
  });

  it("lets a tool-call-only assistant turn pass through without closing the pair", () => {
    // Assistant rows without text (tool calls only) have nothing to embed.
    const pairs = extractConversationPairs([
      msg(1, "user", "Run the memory check"),
      msg(2, "assistant", ""),
      msg(3, "assistant", "Memory is healthy: 12Gi available."),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.assistantId).toBe(3);
    expect(pairs[0]!.assistantText).toBe("Memory is healthy: 12Gi available.");
  });

  it("never pairs across session boundaries", () => {
    const pairs = extractConversationPairs([
      msg(1, "user", "Session one question", "sess-1"),
      msg(2, "user", "Session two question", "sess-2"),
      msg(3, "assistant", "Answer to session two", "sess-2"),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.sessionId).toBe("sess-2");
    expect(pairs[0]!.baseId).toBe(2);
    expect(pairs[0]!.text).not.toContain("Session one question");
  });

  it("ignores an assistant reply with no preceding user turn", () => {
    const pairs = extractConversationPairs([
      msg(1, "assistant", "Welcome back! Session resumed."),
      msg(2, "user", "Thanks, where were we?"),
      msg(3, "assistant", "We were setting up the gateway."),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.baseId).toBe(2);
    expect(pairs[0]!.text).not.toContain("Welcome back");
  });

  it("leaves a turn unextracted while the assistant reply is still missing", () => {
    const pairs = extractConversationPairs([msg(1, "user", "Are you there?")]);
    expect(pairs).toEqual([]);
  });

  it("returns nothing for an empty or all-noise message list", () => {
    expect(extractConversationPairs([])).toEqual([]);
    expect(
      extractConversationPairs([msg(1, "system", "boot"), msg(2, "toolResult", "ok")]),
    ).toEqual([]);
  });

  it("is case-insensitive about the role field", () => {
    const pairs = extractConversationPairs([
      msg(1, "User", "Case test"),
      msg(2, "Assistant", "Handled."),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.userText).toBe("Case test");
  });

  it("carries the base user message timestamp", () => {
    const pairs = extractConversationPairs([
      msg(1, "user", "Timestamp check", "sess-1", "2026-04-08T09:59:58.000Z"),
      msg(2, "assistant", "Noted.", "sess-1", "2026-04-08T10:00:05.000Z"),
    ]);

    expect(pairs[0]!.timestampIso).toBe("2026-04-08T09:59:58.000Z");
  });

  it("keeps pairs after a partial (user-only) turn so later turns still index", () => {
    const pairs = extractConversationPairs([
      msg(1, "user", "Dangling question with no reply"),
      msg(2, "user", "Follow-up that does get a reply"),
      msg(3, "assistant", "Here is the answer."),
    ]);

    expect(pairs).toHaveLength(1);
    // The dangling turn is absorbed as a second user message of the same run,
    // matching how the transcript represents an unanswered prompt.
    expect(pairs[0]!.baseId).toBe(1);
    expect(pairs[0]!.userText).toBe(
      "Dangling question with no reply Follow-up that does get a reply",
    );
  });
});

describe("pair-extractor: noise filtering", () => {
  it("drops a bare greeting exchange", () => {
    expect(
      extractConversationPairs([
        msg(1, "user", "おはよう！"),
        msg(2, "assistant", "おはようございます！"),
      ]),
    ).toEqual([]);
  });

  it("drops a bare acknowledgement exchange", () => {
    expect(
      extractConversationPairs([
        msg(1, "user", "ありがとう！"),
        msg(2, "assistant", "どういたしまして！"),
      ]),
    ).toEqual([]);
    expect(extractConversationPairs([msg(1, "user", "OK"), msg(2, "assistant", "Sure!")])).toEqual(
      [],
    );
    expect(
      extractConversationPairs([
        msg(1, "user", "Thanks!"),
        msg(2, "assistant", "You're welcome 🙂"),
      ]),
    ).toEqual([]);
  });

  it("keeps a greeting that carries real content", () => {
    const pairs = extractConversationPairs([
      msg(1, "user", "おはよう！今日のバックアップ状態を確認して"),
      msg(2, "assistant", "おはようございます！バックアップは正常です。"),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.userText).toContain("バックアップ");
  });

  it("keeps a substantive question paired with a short reply", () => {
    const pairs = extractConversationPairs([
      msg(1, "user", "Which port should the gateway listen on?"),
      msg(2, "assistant", "8317."),
    ]);

    expect(pairs).toHaveLength(1);
  });

  it("drops an emoji-only turn as noise", () => {
    expect(extractConversationPairs([msg(1, "user", "🙂🙂"), msg(2, "assistant", "👍")])).toEqual(
      [],
    );
  });

  it("documents the noise predicate directly", () => {
    expect(isNoiseTurn("おはよう", "おはようございます")).toBe(true);
    expect(isNoiseTurn("Hello", "Hi there")).toBe(true);
    expect(isNoiseTurn("", "anything")).toBe(true);
    expect(isNoiseTurn("anything", "")).toBe(true);
    expect(isNoiseTurn("hi", "hint: the config lives in dennou-aibou.json")).toBe(false);
    expect(isNoiseTurn("What is the port?", "8317")).toBe(false);
  });
});

describe("pair-extractor: text formatting", () => {
  it("matches the design-spec pair format", () => {
    expect(formatPairText("hello", "world")).toBe("User: hello\nAssistant: world");
  });

  it("collapses newlines and runs of whitespace inside a speaker line", () => {
    const formatted = formatPairText("line one\n\nline two", "answer   with\nspacing");
    expect(formatted).toBe("User: line one line two\nAssistant: answer with spacing");
    expect(formatted.split("\n")).toHaveLength(2);
  });

  it("trims each side", () => {
    expect(formatPairText("  padded  ", "\n\tindented\t\n")).toBe(
      "User: padded\nAssistant: indented",
    );
  });

  it("keeps the snippet within the documented budget", () => {
    const snippet = formatPairSnippet("u".repeat(5000), "a".repeat(5000));
    expect(snippet.length).toBeLessThanOrEqual(PAIR_SNIPPET_MAX_LENGTH + ".....".length);
    expect(snippet.startsWith("User: u")).toBe(true);
    expect(snippet).toContain("\nAssistant: a");
  });

  it("does not let one long side erase the other from the snippet", () => {
    const snippet = formatPairSnippet("u".repeat(5000), "short answer");
    expect(snippet).toContain("Assistant: short answer");
  });

  it("leaves short pairs untouched", () => {
    const snippet = formatPairSnippet("ping", "pong");
    expect(snippet).toBe("User: ping\nAssistant: pong");
  });

  it("bounds the internally embedded user text without dropping the assistant reply", () => {
    const pairs = extractConversationPairs([
      msg(1, "user", "u".repeat(9000)),
      msg(2, "assistant", "reply"),
    ]);

    expect(pairs[0]!.userText.length).toBeLessThanOrEqual(2003);
    expect(pairs[0]!.assistantText).toBe("reply");
    expect(pairs[0]!.textSnippet).toContain("Assistant: reply");
  });
});

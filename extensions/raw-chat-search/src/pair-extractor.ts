/**
 * Round-trip (User + Assistant) pair extraction for RAW_CHAT_SEARCH (§2, §4).
 *
 * The recall index unit is one conversation exchange, not a single message: a
 * query should hit from both the user's question and the assistant's
 * explanation (§2 "インデックス単位"). This module is a pure function over
 * already-indexed `chat_messages` rows — it never touches SQLite — so the
 * background indexer and the backfill job share exactly one pair definition.
 */
import type { PairWindowMessage } from "./types.js";

/** Max length of the stored/embedded pair excerpt (`chat_embeddings.text_snippet`). */
export const PAIR_SNIPPET_MAX_LENGTH = 300;

/**
 * Max length kept per speaker in `ExtractedPair.userText` / `.assistantText`.
 *
 * Purely a memory guard for pathological rows (a single message can be
 * hundreds of KB); the excerpt that actually gets embedded and stored is
 * bounded by {@link PAIR_SNIPPET_MAX_LENGTH} instead. Module-private because no
 * caller needs to reason about the pre-snippet bound.
 */
const PAIR_SIDE_MAX_LENGTH = 2000;

const USER_LABEL = "User: ";
const ASSISTANT_LABEL = "Assistant: ";
const ELLIPSIS = "...";

/** Fixed characters around the two speakers: labels plus the separating newline. */
const PAIR_LABEL_OVERHEAD = USER_LABEL.length + 1 + ASSISTANT_LABEL.length;

/**
 * Per-speaker budget inside a {@link PAIR_SNIPPET_MAX_LENGTH} excerpt.
 *
 * Split evenly and on purpose: a single total cap would let one long side erase
 * the other, and the whole point of pair indexing is that both the question and
 * the answer stay searchable. Two ellipses are reserved so a truncated snippet
 * still lands at or under the documented maximum.
 *
 * Note: Phase 3 may re-tune this split once real recall quality is measured.
 */
const PAIR_SNIPPET_SIDE_BUDGET = Math.max(
  1,
  Math.floor((PAIR_SNIPPET_MAX_LENGTH - PAIR_LABEL_OVERHEAD - 2 * ELLIPSIS.length) / 2),
);

/**
 * Filler phrases that carry no recall value, removed with substring matching.
 *
 * Every entry is CJK or multi-letter ASCII written without separators, where
 * substring stripping is safe because the phrase cannot be a fragment of an
 * unrelated word in practice ("おはよう" inside "おはよう、予定を教えて" leaves the
 * real content behind). Longest forms come first so they are consumed whole.
 */
const NOISE_PHRASES: readonly string[] = [
  // Japanese greetings
  "おはようございます",
  "おはよう",
  "こんにちは",
  "こんばんは",
  "おやすみなさい",
  "おやすみ",
  "おかえりなさい",
  "おかえり",
  "ただいま",
  // Japanese thanks / courtesy
  "ありがとうございました",
  "ありがとうございます",
  "ありがとう",
  "ありがと",
  "どういたしまして",
  "よろしくおねがいいたします",
  "よろしくお願いいたします",
  "よろしくおねがいします",
  "よろしくお願いします",
  "よろしく",
  "おねがいします",
  "お願いします",
  "おつかれさまです",
  "おつかれさま",
  "おつかれ",
  "お疲れさま",
  "お疲れ",
  "いえいえ",
  "とんでもないです",
  "とんでもない",
  "ございます",
  "ございました",
  // Japanese acknowledgements / farewells
  "了解しました",
  "了解です",
  "了解",
  "りょうかい",
  "わかりました",
  "わかった",
  "承知しました",
  "またね",
  "じゃあね",
  "はい",
  "うん",
  "ええ",
  "いいえ",
  "どうも",
  // ASCII phrases normalized to a single token by punctuation stripping
  "goodmorning",
  "goodafternoon",
  "goodevening",
  "goodnight",
  "yourewelcome",
  "seeyoulater",
  "seeyou",
  "thankyou",
  "thanks",
  "hello",
  "hiya",
  "goodbye",
  "welcome",
  "okay",
  "surething",
  "gotit",
];

/**
 * Short filler words matched as whole whitespace-separated tokens only.
 *
 * Substring matching is unsafe at this length: "hi" would swallow "hint" and
 * "ok" would swallow "oklab" (both words appear in this repo).
 */
const NOISE_WORDS = new Set([
  "hi",
  "hey",
  "yo",
  "bye",
  "cya",
  "thx",
  "ty",
  "ok",
  "yes",
  "yeah",
  "yep",
  "no",
  "nope",
  "sure",
  "cool",
  "nice",
  "great",
  "noted",
  "there",
  "you",
  "youre",
  "welcome",
  "thank",
  "k",
]);

/** Iteration bound for the filler-stripping loop (each pass must shrink input). */
const NOISE_STRIP_MAX_PASSES = 32;

/** One extracted round trip ready to be embedded and stored. */
export type ExtractedPair = {
  /** `chat_messages.id` of the first user message of the turn (the pair key). */
  baseId: number;
  /** `chat_messages.id` of the assistant reply. */
  assistantId: number;
  sessionId: string;
  /** Whitespace-normalized user turn, capped at {@link PAIR_SIDE_MAX_LENGTH}. */
  userText: string;
  /** Whitespace-normalized assistant turn, capped at {@link PAIR_SIDE_MAX_LENGTH}. */
  assistantText: string;
  /** Full `User: ...\nAssistant: ...` text. */
  text: string;
  /** `text` excerpt bounded by {@link PAIR_SNIPPET_MAX_LENGTH}; this is what gets embedded. */
  textSnippet: string;
  /** `timestamp_iso` of the base user message. */
  timestampIso: string;
};

/** Collapses newlines/tabs/runs of spaces so one speaker stays on one line. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Truncates with an ellipsis, mirroring `database.ts`'s snippet behavior. */
function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}...`;
}

/** Strips punctuation/symbols and lowercases, keeping spaces as token separators. */
function stripForNoiseCheck(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * True when the text is nothing but greetings, thanks, and acknowledgements.
 *
 * Runs two passes because the two tables need different matching: whole-token for
 * short ASCII fillers, substring for CJK and multi-letter phrases.
 */
function isBareGreeting(normalized: string): boolean {
  if (!normalized) {
    return true;
  }

  let rest = normalized;
  for (let pass = 0; pass < NOISE_STRIP_MAX_PASSES; pass++) {
    let next = rest
      .split(" ")
      .filter((token) => token && !NOISE_WORDS.has(token))
      .join(" ");

    for (const phrase of NOISE_PHRASES) {
      if (next.includes(phrase)) {
        next = next.replaceAll(phrase, " ");
      }
    }

    next = next.replace(/\s+/gu, " ").trim();
    if (!next) {
      return true;
    }
    if (next === rest) {
      // Nothing else matched, so real content is left.
      return false;
    }
    rest = next;
  }

  return !rest;
}

/**
 * True when a turn carries no recall value: an empty side, or two sides that are
 * nothing but greetings and acknowledgements ("おはよう！" / "おはようございます"),
 * which would otherwise fill the index with noise (§2).
 */
export function isNoiseTurn(userText: string, assistantText: string): boolean {
  const user = stripForNoiseCheck(userText);
  const assistant = stripForNoiseCheck(assistantText);
  if (!user || !assistant) {
    return true;
  }
  return isBareGreeting(user) && isBareGreeting(assistant);
}

/** Builds the design-spec pair format `User: ...\nAssistant: ...` (§2). */
export function formatPairText(userText: string, assistantText: string): string {
  return `${USER_LABEL}${normalizeWhitespace(userText)}\n${ASSISTANT_LABEL}${normalizeWhitespace(
    assistantText,
  )}`;
}

/**
 * Builds the stored/embedded excerpt: same format as {@link formatPairText},
 * but each side is capped so both speakers survive the snippet budget.
 */
export function formatPairSnippet(userText: string, assistantText: string): string {
  return formatPairText(
    truncate(normalizeWhitespace(userText), PAIR_SNIPPET_SIDE_BUDGET),
    truncate(normalizeWhitespace(assistantText), PAIR_SNIPPET_SIDE_BUDGET),
  );
}

/**
 * Extracts every User -> Assistant round trip from `messages`.
 *
 * Rules (design doc §2, §4):
 * - only `user` / `assistant` rows take part; `system`, `toolResult`, and any
 *   other role is skipped as noise;
 * - consecutive user messages belong to the same turn and are joined, so the
 *   pair keeps the full question;
 * - assistant rows without text (tool-call-only turns) do not close a turn, the
 *   next assistant row with text does;
 * - a user turn never spans two sessions, and an assistant row with no pending
 *   user turn (session resumed mid-turn) starts nothing;
 * - noise turns are dropped by {@link isNoiseTurn}.
 *
 * The pair key is the first user message id of the turn, which is stable across
 * runs — that is what makes re-running the indexer idempotent.
 *
 * Input is sorted by `id` defensively; callers may pass unordered rows.
 */
export function extractConversationPairs(messages: readonly PairWindowMessage[]): ExtractedPair[] {
  const pairs: ExtractedPair[] = [];
  const ordered = [...messages].toSorted((a, b) => a.id - b.id);

  let sessionId: string | null = null;
  let pending: {
    baseId: number;
    timestampIso: string;
    userTexts: string[];
  } | null = null;

  for (const message of ordered) {
    if (message.sessionId !== sessionId) {
      sessionId = message.sessionId;
      pending = null;
    }

    const role = message.role.trim().toLowerCase();
    const text = normalizeWhitespace(message.text ?? "");
    if (!text) {
      continue;
    }

    if (role === "user") {
      if (pending) {
        pending.userTexts.push(text);
      } else {
        pending = {
          baseId: message.id,
          timestampIso: message.timestampIso ?? "",
          userTexts: [text],
        };
      }
      continue;
    }

    if (role !== "assistant" || !pending) {
      continue;
    }

    const userText = truncate(pending.userTexts.join(" "), PAIR_SIDE_MAX_LENGTH);
    const assistantText = truncate(text, PAIR_SIDE_MAX_LENGTH);
    if (!isNoiseTurn(userText, assistantText)) {
      pairs.push({
        baseId: pending.baseId,
        assistantId: message.id,
        sessionId: message.sessionId,
        userText,
        assistantText,
        text: formatPairText(userText, assistantText),
        textSnippet: formatPairSnippet(userText, assistantText),
        timestampIso: pending.timestampIso,
      });
    }
    pending = null;
  }

  return pairs;
}

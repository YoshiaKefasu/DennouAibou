/**
 * 時間認識ブロック分割 ＆ ターン原子性。
 *
 * - `buildTurns`: User 発話を起点に、後続 Assistant / Tool / System を束ねて
 *   不可分な Turn を作る（先頭の非 User メッセージ群は Turn 0 にまとめる）。
 * - `splitIntoChapters`: Turn を先に作ってから、Turn 境界でのみ「間」を判定。
 *   Turn の真ん中で章を割らない＝ターン原子性を保証する。
 *   timestamp 欠損の箇所では分割しない。
 */

import type { Chapter, ChatMessage, Turn } from "./types.js";

export const DEFAULT_MA_GAP_MS = 5 * 60 * 1000;

/** number ms または ISO 文字列を ms に正規化。不正・欠損は undefined。 */
function toTime(ts: unknown): number | undefined {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string" && ts.length > 0) {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 配列パーツからテキストを安全に抽出。`inbound_media/...` があればパスを残す。 */
function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!isRecord(part)) return "";
  if (typeof part["text"] === "string") return part["text"];
  if (typeof part["thinking"] === "string") return part["thinking"];
  if (part["type"] === "toolCall") {
    const name = typeof part["name"] === "string" ? part["name"] : "tool";
    return `[toolCall ${name}]`;
  }
  if (part["type"] === "image") {
    for (const [key, value] of Object.entries(part)) {
      if (key === "data") continue; // base64本体は走査しない
      if (typeof value === "string" && value.includes("inbound_media")) return value;
    }
    return "[image]";
  }
  // 未知のパートは [object Object] にしない。テキストらしきものだけ拾う。
  for (const key of ["content", "data", "path", "url"]) {
    const value = part[key];
    if (typeof value === "string" && value.length > 0) {
      if (value.includes("inbound_media")) return value;
    }
  }
  return "";
}

function messageText(m: ChatMessage): string {
  if (typeof m.content === "string") return `${m.role}: ${m.content}`;
  if (Array.isArray(m.content)) {
    return `${m.role}: ${m.content
      .map(partText)
      .filter((s) => s.length > 0)
      .join("\n")}`;
  }
  return `${m.role}: `;
}

function turnText(messages: ChatMessage[]): string {
  return messages.map(messageText).join("\n");
}

function bounds(messages: ChatMessage[]): {
  startedAt?: number;
  endedAt?: number;
} {
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  for (const m of messages) {
    const ts = toTime(m.timestamp);
    if (ts === undefined) continue;
    if (startedAt === undefined || ts < startedAt) startedAt = ts;
    if (endedAt === undefined || ts > endedAt) endedAt = ts;
  }
  return { startedAt, endedAt };
}

export function buildTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: ChatMessage[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const { startedAt, endedAt } = bounds(current);
    turns.push({
      id: turns.length,
      messages: current,
      text: turnText(current),
      startedAt,
      endedAt,
    });
    current = [];
  };
  for (const m of messages) {
    if (m.role === "user" && current.length > 0) flush();
    current.push(m);
  }
  flush();
  return turns;
}

function chapterBounds(turns: Turn[]): {
  startedAt?: number;
  endedAt?: number;
} {
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  for (const t of turns) {
    if (t.startedAt !== undefined) {
      if (startedAt === undefined || t.startedAt < startedAt) startedAt = t.startedAt;
    }
    if (t.endedAt !== undefined) {
      if (endedAt === undefined || t.endedAt > endedAt) endedAt = t.endedAt;
    }
  }
  return { startedAt, endedAt };
}

export function splitIntoChapters(
  messages: ChatMessage[],
  maGapMs: number = DEFAULT_MA_GAP_MS,
): Chapter[] {
  const turns = buildTurns(messages);
  const chapters: Chapter[] = [];
  let current: Turn[] = [];
  let gapBefore: number | undefined;

  const flush = (): void => {
    if (current.length === 0) return;
    const { startedAt, endedAt } = chapterBounds(current);
    chapters.push({
      id: chapters.length,
      turns: current,
      startedAt,
      endedAt,
      gapBeforeMs: gapBefore,
    });
    current = [];
    gapBefore = undefined;
  };

  let prevEnd: number | undefined;
  for (const turn of turns) {
    if (
      prevEnd !== undefined &&
      turn.startedAt !== undefined &&
      turn.startedAt - prevEnd > maGapMs
    ) {
      flush();
      gapBefore = turn.startedAt - prevEnd;
    }
    current.push(turn);
    if (turn.endedAt !== undefined) prevEnd = turn.endedAt;
  }
  flush();
  return chapters;
}

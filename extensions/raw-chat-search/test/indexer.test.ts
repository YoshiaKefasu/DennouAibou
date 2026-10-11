/**
 * raw-chat-search — indexSessionFile の単体テスト
 *
 * 対象: insertMessages 失敗時（SQLite busy 等）に watermark を進めないこと。
 * 失敗行が永久にスキップされず、次回スキャンで再試行されることを保証する。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RawChatDatabase } from "../src/database.js";
import { indexSessionFile } from "../src/indexer.js";
import type { ChatMessageRecord, WatermarkRecord } from "../src/types.js";

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
  }
});

function tempSessionFile(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-indexer-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.join("\n"), "utf-8");
  tempFiles.push(file);
  return file;
}

function messageLine(id: string, text: string, role = "user"): string {
  return JSON.stringify({ type: "message", id, message: { role, content: text } });
}

/** getWatermark / insertMessages / setWatermark のみを持つフェイク DB。 */
function createFakeDb(options?: { failInserts?: boolean }) {
  const watermarks: WatermarkRecord[] = [];
  let indexedCount = 0;
  const db = {
    getWatermark: (_sourceFile: string) => null,
    insertMessages: (records: readonly ChatMessageRecord[]): number => {
      if (options?.failInserts) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      indexedCount += records.length;
      return records.length;
    },
    setWatermark: (wm: WatermarkRecord) => {
      watermarks.push(wm);
    },
  };
  return {
    db: db as unknown as RawChatDatabase,
    watermarks,
    getInsertedCount: () => indexedCount,
  };
}

describe("indexSessionFile", () => {
  it("indexes message lines and advances the watermark on success", () => {
    const file = tempSessionFile([
      messageLine("m1", "hello"),
      messageLine("m2", "world", "assistant"),
    ]);
    const fake = createFakeDb();

    const result = indexSessionFile({ db: fake.db, sessionFile: file, agentId: "main" });

    expect(result).toEqual({ indexed: 2, skipped: 0, errors: 0 });
    expect(fake.getInsertedCount()).toBe(2);
    expect(fake.watermarks).toHaveLength(1);
    expect(fake.watermarks[0]!.last_line).toBe(2);
    expect(fake.watermarks[0]!.source_file).toBe(file);
  });

  it("does not advance the watermark when insertMessages fails so failed lines are retried", () => {
    const file = tempSessionFile([messageLine("m1", "hello"), messageLine("m2", "world")]);
    const fake = createFakeDb({ failInserts: true });

    const result = indexSessionFile({ db: fake.db, sessionFile: file, agentId: "main" });

    // 失敗行は errors としてカウントされ、watermark は進まない（次回再試行）
    expect(result).toEqual({ indexed: 0, skipped: 0, errors: 2 });
    expect(fake.watermarks).toHaveLength(0);
  });
});

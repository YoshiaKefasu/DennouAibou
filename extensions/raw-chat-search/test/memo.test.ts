import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import rawChatSearchPlugin from "../index.js";
import { RawChatDatabase, closeAllRawChatDatabases } from "../src/database.js";
import {
  DEFAULT_MEMO_MAX_TOKENS,
  DEFAULT_MEMO_TTL_DAYS,
  MEMO_CONTENT_MAX_LENGTH,
  MS_PER_DAY,
  applyDreamConsolidation,
  expireMemos,
  getActiveMemosForPrompt,
  normalizeMemoCategory,
  normalizeMemoTags,
  readMemos,
  removeMemo,
  resolveMemoMaxTokens,
  updateMemo,
  writeMemo,
} from "../src/memo-db.js";
import { createMemoTool, MEMO_TOOL_DESCRIPTION } from "../src/memo-tool.js";

const NOW = 1_790_000_000_000;

function makeDb(): { db: RawChatDatabase; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-memo-"));
  const db = new RawChatDatabase(path.join(tmpDir, "raw-chat.sqlite"));
  return { db, tmpDir };
}

function minimalConfig(): OpenClawConfig {
  return {} as OpenClawConfig;
}

function readPayload(result: unknown): Record<string, unknown> {
  const tool = result as { content: Array<{ text?: string }> };
  return JSON.parse(tool.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("memo subsystem (DENNOU_SHINKEI_MEMO Phase 1)", () => {
  let tmpDir: string;
  let db: RawChatDatabase;

  beforeEach(() => {
    ({ db, tmpDir } = makeDb());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreTestGlobals();
    restoreTestEnvs();
  });

  it("creates the memos table and its indexes", () => {
    const table = db
      .getRawDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memos'")
      .get();
    expect(table).toBeDefined();
    for (const index of ["idx_memos_status_expires", "idx_memos_category"]) {
      const row = db
        .getRawDb()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(index);
      expect(row).toBeDefined();
    }
    const version = db
      .getRawDb()
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe("2");
  });

  it("write uses a 3-day default expiry", () => {
    const memo = writeMemo(db, { category: "User", content: "call mom" }, NOW);
    expect(memo.id).toBeGreaterThan(0);
    expect(memo.category).toBe("User");
    expect(memo.days).toBe(DEFAULT_MEMO_TTL_DAYS);
    expect(memo.forever).toBe(false);
    expect(memo.expiresAt).toBe(NOW + 3 * MS_PER_DAY);
    expect(memo.status).toBe("active");
  });

  it("write with forever keeps the memo indefinitely", () => {
    const memo = writeMemo(
      db,
      { category: "Project", content: "never forget", forever: true },
      NOW,
    );
    expect(memo.forever).toBe(true);
    expect(memo.expiresAt).toBeNull();
  });

  it("rejects content over 2,000 characters", () => {
    expect(() =>
      writeMemo(db, { category: "User", content: "x".repeat(MEMO_CONTENT_MAX_LENGTH + 1) }, NOW),
    ).toThrow(/exceeds maximum length/);
  });

  it("normalizes categories case-insensitively", () => {
    expect(normalizeMemoCategory("user")).toBe("User");
    expect(normalizeMemoCategory("PROJECT")).toBe("Project");
    expect(normalizeMemoCategory("agenthabits")).toBe("AgentHabits");
    expect(normalizeMemoCategory("etc")).toBe("etc");
    expect(normalizeMemoCategory("nope")).toBeUndefined();
    const memo = writeMemo(db, { category: "project", content: "rule" }, NOW);
    expect(memo.category).toBe("Project");
  });

  it("read hides expired memos via lazy expiry", () => {
    const memo = writeMemo(db, { category: "User", content: "short promise" }, NOW);
    // Backdate the deadline to simulate 4 days passing.
    db.getRawDb()
      .prepare("UPDATE memos SET expires_at = ? WHERE id = ?")
      .run(NOW - 1_000, memo.id);

    expect(readMemos(db, {}, NOW)).toEqual([]);
    const row = db.getRawDb().prepare("SELECT status FROM memos WHERE id = ?").get(memo.id) as {
      status: string;
    };
    expect(row.status).toBe("archived");
    // Archived rows reappear only with includeArchived.
    expect(readMemos(db, { includeArchived: true }, NOW)).toHaveLength(1);
  });

  it("prompt injection lazily expires dated memos", () => {
    const memo = writeMemo(db, { category: "User", content: "short promise" }, NOW);
    // Backdate the deadline to simulate 4 days passing.
    db.getRawDb()
      .prepare("UPDATE memos SET expires_at = ? WHERE id = ?")
      .run(NOW - 1_000, memo.id);

    expect(getActiveMemosForPrompt(db, { nowMs: NOW })).toBeNull();
    const row = db.getRawDb().prepare("SELECT status FROM memos WHERE id = ?").get(memo.id) as {
      status: string;
    };
    expect(row.status).toBe("archived");
  });

  it("expireMemos archives only due, non-forever rows", () => {
    const dated = writeMemo(db, { category: "User", content: "dated" }, NOW);
    const eternal = writeMemo(db, { category: "User", content: "eternal", forever: true }, NOW);
    db.getRawDb()
      .prepare("UPDATE memos SET expires_at = ? WHERE id = ?")
      .run(NOW - 1_000, dated.id);

    expect(expireMemos(db, NOW)).toBe(1);
    expect(readMemos(db, {}, NOW).map((memo) => memo.id)).toEqual([eternal.id]);
  });

  it("update edits content and recomputes expiry from days", () => {
    const memo = writeMemo(db, { category: "User", content: "old" }, NOW);
    const updated = updateMemo(db, memo.id, { content: "new", days: 30 }, NOW + 1_000);
    expect(updated.content).toBe("new");
    expect(updated.days).toBe(30);
    expect(updated.expiresAt).toBe(NOW + 1_000 + 30 * MS_PER_DAY);
  });

  it("update toggles forever on and off", () => {
    const memo = writeMemo(db, { category: "User", content: "x" }, NOW);
    const eternal = updateMemo(db, memo.id, { forever: true }, NOW);
    expect(eternal.forever).toBe(true);
    expect(eternal.expiresAt).toBeNull();

    const dated = updateMemo(db, memo.id, { forever: false }, NOW);
    expect(dated.forever).toBe(false);
    expect(dated.expiresAt).toBe(NOW + DEFAULT_MEMO_TTL_DAYS * MS_PER_DAY);
  });

  it("update rejects unknown ids and empty patches", () => {
    expect(() => updateMemo(db, 999, { content: "x" }, NOW)).toThrow(/not found/);
    const memo = writeMemo(db, { category: "User", content: "x" }, NOW);
    expect(() => updateMemo(db, memo.id, {}, NOW)).toThrow(/nothing to update/);
  });

  it("remove dismisses logically and read skips dismissed rows", () => {
    const memo = writeMemo(db, { category: "User", content: "x" }, NOW);
    expect(removeMemo(db, memo.id, NOW)).toBe(true);
    expect(removeMemo(db, memo.id, NOW)).toBe(false);
    expect(readMemos(db, { includeArchived: true }, NOW)).toEqual([]);
  });

  it("read filters by query and category", () => {
    writeMemo(db, { category: "User", content: "likes black coffee" }, NOW);
    writeMemo(db, { category: "Project", content: "deploy with git-bash tar" }, NOW);
    writeMemo(db, { category: "User", content: "likes green tea" }, NOW);

    expect(readMemos(db, { query: "coffee" }, NOW)).toHaveLength(1);
    expect(readMemos(db, { category: "user" }, NOW)).toHaveLength(2);
    expect(readMemos(db, { query: "likes", category: "Project" }, NOW)).toHaveLength(0);
  });

  it("prompt injection renders <active-memos> deterministically", () => {
    writeMemo(db, { category: "Project", content: "use git-bash tar", forever: true }, NOW);
    writeMemo(db, { category: "User", content: "short tone", days: 3 }, NOW);

    const text = getActiveMemosForPrompt(db, { timezone: "UTC", nowMs: NOW });
    expect(text).toContain("<active-memos>");
    expect(text).toContain("[User]");
    expect(text).toContain("[Project]");
    expect(text).toContain("(期限: 無限)");
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(NOW + 3 * MS_PER_DAY));
    expect(text).toContain(`(期限: ${date})`);
    // Standing rule first: forever Project memo sorts before dated User memo.
    expect(text!.indexOf("[Project]")).toBeLessThan(text!.indexOf("[User]"));
    // No dynamic relative dates that would bust the prompt cache.
    expect(text).not.toMatch(/残り\d+日/);
  });

  it("prompt injection returns null when empty", () => {
    expect(getActiveMemosForPrompt(db, { nowMs: NOW })).toBeNull();
    expect(getActiveMemosForPrompt(db, { maxTokens: 0, nowMs: NOW })).toBeNull();
  });

  it("prompt injection enforces the token budget, forever first", () => {
    const eternal = writeMemo(
      db,
      { category: "Project", content: "eternal rule", forever: true },
      NOW,
    );
    const oldDated = writeMemo(
      db,
      { category: "User", content: "old dated" },
      NOW - 2 * MS_PER_DAY,
    );
    const newDated = writeMemo(db, { category: "User", content: "new dated" }, NOW);

    const full = getActiveMemosForPrompt(db, { timezone: "UTC", nowMs: NOW })!;
    expect(full).toContain(`#${oldDated.id}`);

    // Tight budget (eternal + newest dated fit, oldest dated drops).
    const clamped = getActiveMemosForPrompt(db, {
      timezone: "UTC",
      nowMs: NOW,
      maxTokens: 35,
    })!;
    expect(clamped).toContain(`#${eternal.id}`);
    expect(clamped).toContain(`#${newDated.id}`);
    expect(clamped).not.toContain(`#${oldDated.id}`);
    expect(clamped).toContain("<active-memos>");
  });

  it("default budget is 4,000 tokens", () => {
    expect(DEFAULT_MEMO_MAX_TOKENS).toBe(4_000);
  });

  it("resolveMemoMaxTokens scales to 5% of the model context window", () => {
    // 1M model: ~52K (1_048_576 * 0.05 = 52_428).
    expect(resolveMemoMaxTokens(undefined, 1_048_576)).toBe(52_428);
    // 500K model: ~26K (524_288 * 0.05 = 26_214).
    expect(resolveMemoMaxTokens(undefined, 524_288)).toBe(26_214);
    // 200K model: 10K.
    expect(resolveMemoMaxTokens(undefined, 200_000)).toBe(10_000);
  });

  it("resolveMemoMaxTokens falls back to 4,000 for unknown or small windows", () => {
    expect(resolveMemoMaxTokens(undefined, undefined)).toBe(DEFAULT_MEMO_MAX_TOKENS);
    expect(resolveMemoMaxTokens(undefined, 0)).toBe(DEFAULT_MEMO_MAX_TOKENS);
    expect(resolveMemoMaxTokens(undefined, -10)).toBe(DEFAULT_MEMO_MAX_TOKENS);
    // 5% below the floor clamps to 4,000.
    expect(resolveMemoMaxTokens(undefined, 50_000)).toBe(DEFAULT_MEMO_MAX_TOKENS);
    expect(resolveMemoMaxTokens({}, 50_000)).toBe(DEFAULT_MEMO_MAX_TOKENS);
  });

  it("resolveMemoMaxTokens prefers explicit memo.maxTokens", () => {
    expect(resolveMemoMaxTokens({ memo: { maxTokens: 8_000 } }, 1_048_576)).toBe(8_000);
    expect(resolveMemoMaxTokens({ memo: { maxTokens: 1_000 } }, 200_000)).toBe(1_000);
    // Non-positive explicit values fall through to scaling.
    expect(resolveMemoMaxTokens({ memo: { maxTokens: 0 } }, 200_000)).toBe(10_000);
  });

  it("memo tool validates correlations and limits", async () => {
    const tool = createMemoTool({ config: minimalConfig(), db })!;
    expect(tool.name).toBe("memo");
    expect(MEMO_TOOL_DESCRIPTION).toContain("3 日間");

    await expect(tool.execute!("t1", { action: "write", content: "x" })).rejects.toThrow(
      /category required/,
    );
    await expect(tool.execute!("t2", { action: "write", category: "User" })).rejects.toThrow(
      /content required/,
    );
    await expect(
      tool.execute!("t3", { action: "write", category: "User", content: "x".repeat(2001) }),
    ).rejects.toThrow(/exceeds maximum length/);
    await expect(
      tool.execute!("t4", { action: "write", category: "User", content: "x", days: 0 }),
    ).rejects.toThrow(/positive integer/);
    await expect(tool.execute!("t5", { action: "update", content: "x" })).rejects.toThrow(
      /id required/,
    );
    await expect(tool.execute!("t6", { action: "remove" })).rejects.toThrow(/id required/);
    await expect(tool.execute!("t7", { action: "remove", id: 4242 })).rejects.toThrow(/not found/);
    await expect(tool.execute!("t8", { action: "dance" })).rejects.toThrow(/invalid action/);
  });

  it("memo tool runs the full write/read/update/remove cycle", async () => {
    const tool = createMemoTool({ config: minimalConfig(), db })!;

    const written = readPayload(
      await tool.execute!("w", {
        action: "write",
        category: "user",
        content: "ship it",
        forever: true,
      }),
    ) as { id: number; category: string; forever: boolean; expiresAt: null };
    expect(written.category).toBe("User");
    expect(written.forever).toBe(true);
    expect(written.expiresAt).toBeNull();

    const listed = readPayload(await tool.execute!("r", { action: "read" })) as {
      memos: Array<{ id: number }>;
      count: number;
    };
    expect(listed.count).toBe(1);

    const updated = readPayload(
      await tool.execute!("u", {
        action: "update",
        id: written.id,
        forever: false,
        days: 10,
      }),
    ) as { forever: boolean; days: number };
    expect(updated.forever).toBe(false);
    expect(updated.days).toBe(10);

    const removed = readPayload(await tool.execute!("d", { action: "remove", id: written.id })) as {
      removed: number;
    };
    expect(removed.removed).toBe(written.id);
    expect(readPayload(await tool.execute!("r2", { action: "read" }))).toMatchObject({ count: 0 });
  });

  it("memo tool returns null without config", () => {
    expect(createMemoTool({})).toBeNull();
  });

  it("plugin registers the memo tool and injects memos before vector recall", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-memo-hook-"));
    setTestEnv("DENNOU_STATE_DIR", path.join(stateDir, "state"));
    // Keep vector recall out of this test: memo injection must stand alone.
    setTestEnv("DENNOU_SKIP_VECTOR_RECALL", "1");
    try {
      const registeredTools: Array<{ names?: string[] }> = [];
      let hookHandler:
        | ((event: { prompt: string }, ctx: { agentId?: string }) => Promise<unknown>)
        | undefined;
      const api = {
        logger: { warn: vi.fn(), info: vi.fn() },
        on: vi.fn((name: string, handler: typeof hookHandler) => {
          if (name === "before_prompt_build") {
            hookHandler = handler;
          }
        }),
        registerTool: vi.fn((_factory: unknown, opts: { names?: string[] }) => {
          registeredTools.push(opts);
        }),
        registerService: vi.fn(),
      };

      rawChatSearchPlugin.register(api as never);
      expect(registeredTools).toContainEqual({ names: ["memo"] });
      expect(hookHandler).toBeDefined();

      // Empty ledger: hook stays silent.
      await expect(
        hookHandler!({ prompt: "hello" }, { agentId: "hook-agent" }),
      ).resolves.toBeUndefined();

      const { getRawChatDatabase } = await import("../src/database.js");
      const hookDb = getRawChatDatabase("hook-agent");
      writeMemo(hookDb, { category: "User", content: "hook memo", forever: true }, NOW);

      const result = (await hookHandler!({ prompt: "hello" }, { agentId: "hook-agent" })) as {
        appendSystemContext?: string;
      };
      expect(result?.appendSystemContext).toContain("<active-memos>");
      expect(result?.appendSystemContext).toContain("hook memo");
      expect(result).not.toHaveProperty("prependContext");
    } finally {
      closeAllRawChatDatabases();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("memo tags (DENNOU_SHINKEI_MEMO tags)", () => {
  let tmpDir: string;
  let db: RawChatDatabase;

  beforeEach(() => {
    ({ db, tmpDir } = makeDb());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreTestGlobals();
    restoreTestEnvs();
  });

  it("write keeps tags as-is", () => {
    const memo = writeMemo(
      db,
      { category: "Project", content: "tagged rule", tags: ["DennouAibou", "アイデア"] },
      NOW,
    );
    expect(memo.tags).toEqual(["DennouAibou", "アイデア"]);
    const row = db.getRawDb().prepare("SELECT tags_json FROM memos WHERE id = ?").get(memo.id) as {
      tags_json: string;
    };
    expect(JSON.parse(row.tags_json)).toEqual(["DennouAibou", "アイデア"]);
  });

  it("normalizes comma strings, trims, drops empties, dedupes", () => {
    expect(normalizeMemoTags([" a ", "", "a", "b", " b "])).toEqual(["a", "b"]);
    expect(normalizeMemoTags("DennouAibou, アイデア, DennouAibou,, ")).toEqual([
      "DennouAibou",
      "アイデア",
    ]);
    expect(normalizeMemoTags(undefined)).toBeUndefined();
    const memo = writeMemo(
      db,
      { category: "User", content: "comma", tags: "DennouAibou, アイデア, DennouAibou" },
      NOW,
    );
    expect(memo.tags).toEqual(["DennouAibou", "アイデア"]);
  });

  it("update replaces tags", () => {
    const memo = writeMemo(db, { category: "User", content: "x", tags: ["A"] }, NOW);
    const updated = updateMemo(db, memo.id, { tags: ["B", "C"] }, NOW);
    expect(updated.tags).toEqual(["B", "C"]);
    const cleared = updateMemo(db, memo.id, { tags: [] }, NOW);
    expect(cleared.tags).toEqual([]);
  });

  it("read filters by tag case-insensitively", () => {
    const first = writeMemo(
      db,
      { category: "Project", content: "one", tags: ["DennouAibou"] },
      NOW,
    );
    writeMemo(db, { category: "Project", content: "two", tags: ["GoRakuDo"] }, NOW);
    writeMemo(db, { category: "Project", content: "three" }, NOW);
    expect(readMemos(db, { tag: "dennouaibou" }, NOW).map((memo) => memo.id)).toEqual([first.id]);
    expect(readMemos(db, { tag: "Dennou" }, NOW)).toHaveLength(1);
    expect(readMemos(db, { tag: "nope" }, NOW)).toHaveLength(0);
  });

  it("prompt shows [tag1, tag2] only when tags exist", () => {
    const tagged = writeMemo(
      db,
      {
        category: "Project",
        content: "tagged body",
        tags: ["DennouAibou", "アイデア"],
        forever: true,
      },
      NOW,
    );
    const plain = writeMemo(db, { category: "Project", content: "plain body", forever: true }, NOW);
    const text = getActiveMemosForPrompt(db, { timezone: "UTC", nowMs: NOW })!;
    expect(text).toContain(`#${tagged.id} [DennouAibou, アイデア] (期限: 無限)`);
    expect(text).toContain(`#${plain.id} (期限: 無限)`);
    expect(text).not.toContain(`#${plain.id} [`);
  });

  it("memo tool write/read/update round-trips tags", async () => {
    const tool = createMemoTool({ config: minimalConfig(), db })!;
    const written = readPayload(
      await tool.execute!("w", {
        action: "write",
        category: "Project",
        content: "tool tags",
        tags: ["DennouAibou", "アイデア"],
      }),
    ) as { id: number; tags: string[] };
    expect(written.tags).toEqual(["DennouAibou", "アイデア"]);
    const filtered = readPayload(await tool.execute!("r", { action: "read", tag: "dennou" })) as {
      count: number;
    };
    expect(filtered.count).toBe(1);
    const updated = readPayload(
      await tool.execute!("u", { action: "update", id: written.id, tags: "GoRakuDo, アイデア" }),
    ) as { tags: string[] };
    expect(updated.tags).toEqual(["GoRakuDo", "アイデア"]);
  });

  it("dream consolidation merges archived tags into keepId", () => {
    const keep = writeMemo(db, { category: "User", content: "keep", tags: ["A"] }, NOW);
    const drop = writeMemo(db, { category: "User", content: "drop", tags: ["B", "A"] }, NOW);
    const result = applyDreamConsolidation(db, [{ keepId: keep.id, archiveIds: [drop.id] }], NOW);
    expect(result).toEqual({ updated: 1, archived: 1 });
    expect(readMemos(db, {}, NOW)[0]?.tags).toEqual(["A", "B"]);
  });

  it("migrates pre-tags database by adding tags_json column via ALTER TABLE", () => {
    const preTagsDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-pre-tags-"));
    const dbPath = path.join(preTagsDir, "raw-chat.sqlite");

    // Initialize raw database with pre-tags memos table (no tags_json)
    const initDb = new RawChatDatabase(dbPath);
    initDb.getRawDb().exec(`
      DROP TABLE IF EXISTS memos;
      CREATE TABLE memos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK(category IN ('User', 'Project', 'AgentHabits', 'etc')),
        content TEXT NOT NULL,
        days INTEGER DEFAULT 3,
        forever INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'dismissed')),
        metadata_json TEXT
      );
      INSERT INTO memos (category, content, days, forever, created_at, updated_at, expires_at, status)
      VALUES ('Project', 'pre-existing memo', 3, 1, 1000, 1000, NULL, 'active');
    `);
    initDb.close();

    // Reopen using RawChatDatabase which triggers ALTER TABLE ADD COLUMN tags_json
    const migratedDb = new RawChatDatabase(dbPath);
    try {
      const memos = readMemos(migratedDb, {}, NOW);
      expect(memos).toHaveLength(1);
      expect(memos[0].content).toBe("pre-existing memo");
      expect(memos[0].tags).toEqual([]);

      // Writing with tags works on migrated table
      const newMemo = writeMemo(
        migratedDb,
        { category: "Project", content: "new tagged", tags: ["migrated"] },
        NOW,
      );
      expect(newMemo.tags).toEqual(["migrated"]);
    } finally {
      migratedDb.close();
      fs.rmSync(preTagsDir, { recursive: true, force: true });
    }
  });
});

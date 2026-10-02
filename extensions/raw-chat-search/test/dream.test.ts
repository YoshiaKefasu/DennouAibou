import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import rawChatSearchPlugin from "../index.js";
import { RawChatDatabase } from "../src/database.js";
import {
  DEFAULT_DREAM_LANGUAGE,
  DEFAULT_DREAM_SCHEDULE,
  DreamDeps,
  DreamScheduler,
  buildDreamPrompt,
  parseDreamResponseText,
  resolveDreamConfig,
  resolveDreamLanguageName,
  runDreamConsolidation,
  withDreamLanguageDirective,
} from "../src/dream.js";
import { applyDreamConsolidation, archiveMemo, readMemos, writeMemo } from "../src/memo-db.js";
import { createMemoTool } from "../src/memo-tool.js";

const NOW = 1_790_000_000_000;

function makeDb(): { db: RawChatDatabase; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-dream-"));
  const db = new RawChatDatabase(path.join(tmpDir, "raw-chat.sqlite"));
  return { db, tmpDir };
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function assistantReply(text: string): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    stopReason: "stop",
    timestamp: NOW,
  };
}

function preparedOk() {
  return {
    model: { provider: "test-provider", id: "test-model", api: "openai-completions" },
    auth: { apiKey: "test-key", source: "test", mode: "api-key" },
  };
}

/** Prepare/complete fakes so no test touches the network or model registry. */
function makeDeps(replyText: string): {
  deps: DreamDeps;
  prepare: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
} {
  const prepare = vi.fn(async () => preparedOk());
  const complete = vi.fn(async () => assistantReply(replyText));
  return {
    deps: {
      prepareModel: prepare as unknown as DreamDeps["prepareModel"],
      completeSimpleFn: complete as unknown as DreamDeps["completeSimpleFn"],
      now: () => NOW,
    },
    prepare,
    complete,
  };
}

function seedPair(db: RawChatDatabase): { keep: number; drop: number } {
  const keep = writeMemo(db, { category: "User", content: "likes black coffee" }, NOW);
  const drop = writeMemo(db, { category: "User", content: "loves black coffee" }, NOW);
  return { keep: keep.id, drop: drop.id };
}

function readPayload(result: unknown): Record<string, unknown> {
  const tool = result as { content: Array<{ text?: string }> };
  return JSON.parse(tool.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("dream config (DENNOU_SHINKEI_MEMO §6.1)", () => {
  it("defaults to enabled, 3am, and Japanese", () => {
    const config = resolveDreamConfig(undefined, {} as OpenClawConfig);
    expect(config.enabled).toBe(true);
    expect(config.schedule).toBe(DEFAULT_DREAM_SCHEDULE);
    expect(config.model).toBeUndefined();
    expect(config.language).toBe("ja");
    expect(config.language).toBe(DEFAULT_DREAM_LANGUAGE);
    expect(typeof config.timezone).toBe("string");
  });

  it("honors explicit dream settings", () => {
    const config = resolveDreamConfig(
      {
        dream: {
          enabled: false,
          schedule: "*/5 * * * *",
          model: "cli-router/test-model",
          timezone: "Asia/Jakarta",
          language: "en",
        },
      },
      {} as OpenClawConfig,
    );
    expect(config).toMatchObject({
      enabled: false,
      schedule: "*/5 * * * *",
      model: "cli-router/test-model",
      timezone: "Asia/Jakarta",
      language: "en",
    });
  });

  it("falls back to the plugin-level language, dream.language wins", () => {
    expect(resolveDreamConfig({ language: "de" }, {} as OpenClawConfig).language).toBe("de");
    expect(
      resolveDreamConfig({ language: "de", dream: { language: "en" } }, {} as OpenClawConfig)
        .language,
    ).toBe("en");
  });
});

describe("dream language directive (MagicContext spec)", () => {
  it("resolves display names, rejects garbage", () => {
    expect(resolveDreamLanguageName("ja")).toBe("Japanese (日本語)");
    expect(resolveDreamLanguageName("JA")).toBe("Japanese (日本語)");
    expect(resolveDreamLanguageName("en")).toBe("English");
    expect(resolveDreamLanguageName("xx")).toBe("");
    expect(resolveDreamLanguageName("")).toBe("");
    expect(resolveDreamLanguageName(undefined)).toBe("");
  });

  it("appends the directive, keeps structural tokens English", () => {
    const out = withDreamLanguageDirective("base prompt", "ja");
    expect(out.startsWith("base prompt")).toBe(true);
    expect(out).toContain("## Output language");
    expect(out).toContain("Japanese (日本語)");
    expect(out).toContain("JSON keys");
    expect(out).not.toContain("```");
  });

  it("emits no directive for invalid codes", () => {
    expect(withDreamLanguageDirective("base", "xx")).toBe("base");
    expect(withDreamLanguageDirective("base", undefined)).toBe("base");
  });
});

describe("buildDreamPrompt (3-phase + language)", () => {
  it("lists memos, walks A→B→C, and ends with the Japanese directive", () => {
    const { db, tmpDir } = makeDb();
    try {
      const memo = writeMemo(db, { category: "Project", content: "use git-bash tar" }, NOW);
      const prompt = buildDreamPrompt(readMemos(db, {}, NOW), "UTC");
      expect(prompt).toContain(`#${memo.id} [Project]`);
      expect(prompt).toContain("use git-bash tar");
      expect(prompt).toContain("### Phase A — Consolidate duplicates");
      expect(prompt).toContain("### Phase B — Improve wording");
      expect(prompt).toContain("### Phase C — Archive stale / low-value");
      expect(prompt.indexOf("### Phase A")).toBeLessThan(prompt.indexOf("### Phase B"));
      expect(prompt.indexOf("### Phase B")).toBeLessThan(prompt.indexOf("### Phase C"));
      // Language directive is last (prompt末尾).
      expect(prompt.lastIndexOf("## Output language")).toBeGreaterThan(prompt.indexOf("Phase C"));
      expect(prompt).toContain("日本語");
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("switches the directive language on request", () => {
    const prompt = buildDreamPrompt([], "UTC", "en");
    expect(prompt).toContain("Write human-readable prose you author in: English.");
    expect(prompt).not.toContain("日本語");
  });
});

describe("parseDreamResponseText", () => {
  it("parses plain, fenced, and prose-wrapped JSON", () => {
    const body = '{"consolidations": [{"keepId": 1, "updateContent": "x", "archiveIds": [2]}]}';
    expect(parseDreamResponseText(body)).toEqual([
      { keepId: 1, updateContent: "x", archiveIds: [2] },
    ]);
    expect(parseDreamResponseText(`\`\`\`json\n${body}\n\`\`\``)).toEqual([
      { keepId: 1, updateContent: "x", archiveIds: [2] },
    ]);
    expect(parseDreamResponseText(`Done!\n${body}\nHope that helps.`)).toEqual([
      { keepId: 1, updateContent: "x", archiveIds: [2] },
    ]);
  });

  it("throws on garbage or wrong shapes", () => {
    expect(() => parseDreamResponseText("no json here")).toThrow(/no JSON object/);
    expect(() => parseDreamResponseText("{oops")).toThrow();
    expect(() => parseDreamResponseText('{"foo": 1}')).toThrow(/consolidations array/);
    expect(() => parseDreamResponseText('{"consolidations": {}}')).toThrow(/consolidations array/);
  });

  it("drops item-level garbage but keeps the valid half", () => {
    const parsed = parseDreamResponseText(
      JSON.stringify({
        consolidations: [
          { keepId: 0, archiveIds: [2] },
          { keepId: 1, archiveIds: [1, 2, 2, -3, "x"] },
          { keepId: 2, updateContent: "   " },
          { keepId: 3, updateContent: "y".repeat(2001), archiveIds: [4] },
          { keepId: 5 },
          "nope",
          null,
        ],
      }),
    );
    expect(parsed).toEqual([
      { keepId: 1, archiveIds: [2] },
      { keepId: 3, archiveIds: [4] },
    ]);
  });
});

describe("applyDreamConsolidation (memo-db transaction)", () => {
  let tmpDir = "";
  let db: RawChatDatabase;

  beforeEach(() => {
    ({ db, tmpDir } = makeDb());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates the kept memo and archives the absorbed ones atomically", () => {
    const { keep, drop } = seedPair(db);
    const result = applyDreamConsolidation(
      db,
      [{ keepId: keep, updateContent: "likes black coffee (merged)", archiveIds: [drop] }],
      NOW,
    );
    expect(result).toEqual({ updated: 1, archived: 1 });
    const kept = db.getRawDb().prepare("SELECT * FROM memos WHERE id = ?").get(keep) as {
      content: string;
      status: string;
    };
    expect(kept.content).toBe("likes black coffee (merged)");
    expect(kept.status).toBe("active");
    const archived = db.getRawDb().prepare("SELECT status FROM memos WHERE id = ?").get(drop) as {
      status: string;
    };
    expect(archived.status).toBe("archived");
  });

  it("skips unknown ids and never archives keepId itself", () => {
    const { keep } = seedPair(db);
    const result = applyDreamConsolidation(db, [{ keepId: keep, archiveIds: [keep, 4242] }], NOW);
    expect(result).toEqual({ updated: 0, archived: 0 });
    expect(readMemos(db, {}, NOW)).toHaveLength(2);
  });

  it("returns zeros for empty input", () => {
    expect(applyDreamConsolidation(db, [], NOW)).toEqual({ updated: 0, archived: 0 });
  });
});

describe("archiveMemo + memo tool archive action", () => {
  let tmpDir = "";
  let db: RawChatDatabase;

  beforeEach(() => {
    ({ db, tmpDir } = makeDb());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("archives but keeps the row re-readable", () => {
    const memo = writeMemo(db, { category: "User", content: "x" }, NOW);
    expect(archiveMemo(db, memo.id, NOW)).toBe(true);
    expect(archiveMemo(db, memo.id, NOW)).toBe(false);
    expect(readMemos(db, {}, NOW)).toEqual([]);
    expect(readMemos(db, { includeArchived: true }, NOW)).toHaveLength(1);
  });

  it("rejects bad ids and misses unknown rows", () => {
    expect(() => archiveMemo(db, 0, NOW)).toThrow(/id required/);
    expect(archiveMemo(db, 4242, NOW)).toBe(false);
  });

  it("memo tool archive/remove split: archive stays visible, remove does not", async () => {
    const tool = createMemoTool({ config: {} as OpenClawConfig, db })!;
    const first = readPayload(
      await tool.execute!("w1", { action: "write", category: "User", content: "a" }),
    ) as { id: number };
    const second = readPayload(
      await tool.execute!("w2", { action: "write", category: "User", content: "b" }),
    ) as { id: number };

    await expect(tool.execute!("no-id", { action: "archive" })).rejects.toThrow(/id required/);
    await expect(tool.execute!("missing", { action: "archive", id: 4242 })).rejects.toThrow(
      /not found/,
    );

    expect(
      readPayload(await tool.execute!("a", { action: "archive", id: first.id })),
    ).toMatchObject({ archived: first.id });
    expect(
      readPayload(await tool.execute!("r", { action: "read", includeArchived: true })),
    ).toMatchObject({ count: 2 });

    expect(
      readPayload(await tool.execute!("d", { action: "remove", id: second.id })),
    ).toMatchObject({ removed: second.id });
    // dismissed rows stay hidden even with includeArchived.
    const listed = readPayload(
      await tool.execute!("r2", { action: "read", includeArchived: true }),
    ) as { count: number };
    expect(listed.count).toBe(1);

    await expect(tool.execute!("bad", { action: "dance" })).rejects.toThrow(
      /write, read, update, archive, remove/,
    );
  });
});

describe("runDreamConsolidation", () => {
  let tmpDir = "";
  let db: RawChatDatabase;

  beforeEach(() => {
    ({ db, tmpDir } = makeDb());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(cfg: { replyText?: string; params?: Record<string, unknown> } = {}) {
    const { deps, prepare, complete } = makeDeps(cfg.replyText ?? '{"consolidations": []}');
    const logger = fakeLogger();
    const promise = runDreamConsolidation({
      db,
      cfg: {} as OpenClawConfig,
      agentId: "main",
      agentDir: tmpDir,
      logger,
      deps,
      ...(cfg.params ?? {}),
    });
    return { promise, prepare, complete, logger };
  }

  it("skips the LLM call on 0–1 active memos", async () => {
    const empty = run();
    await expect(empty.promise).resolves.toMatchObject({
      ok: true,
      skipped: true,
      activeCount: 0,
    });
    expect(empty.prepare).not.toHaveBeenCalled();
    expect(empty.complete).not.toHaveBeenCalled();

    writeMemo(db, { category: "User", content: "lone memo" }, NOW);
    const lone = run();
    await expect(lone.promise).resolves.toMatchObject({
      ok: true,
      skipped: true,
      activeCount: 1,
    });
    expect(lone.complete).not.toHaveBeenCalled();
  });

  it("merges via one LLM call and logs the summary", async () => {
    const { keep, drop } = seedPair(db);
    const { promise, prepare, complete, logger } = run({
      replyText: JSON.stringify({
        consolidations: [{ keepId: keep, updateContent: "coffee enjoyer", archiveIds: [drop] }],
      }),
    });
    await expect(promise).resolves.toMatchObject({
      ok: true,
      activeCount: 2,
      consolidatedCount: 1,
      archivedCount: 1,
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(readMemos(db, {}, NOW).map((memo) => memo.content)).toEqual(["coffee enjoyer"]);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(String(logger.info.mock.calls[0]?.[0])).toContain("archived 1");
  });

  it("sends the Japanese directive by default, English on request", async () => {
    seedPair(db);
    const ja = run();
    await ja.promise;
    const jaContent = String(
      (ja.complete.mock.calls[0]?.[1] as { messages: Array<{ content: string }> }).messages[0]
        ?.content,
    );
    expect(jaContent).toContain("## Output language");
    expect(jaContent).toContain("日本語");

    seedPair(db);
    const en = run({ params: { language: "en" } });
    await en.promise;
    const enContent = String(
      (en.complete.mock.calls[0]?.[1] as { messages: Array<{ content: string }> }).messages[0]
        ?.content,
    );
    expect(enContent).toContain("author in: English.");
  });

  it("forwards an explicit model override to preparation", async () => {
    seedPair(db);
    const { promise, prepare } = run({ params: { modelOverride: "cli-router/custom" } });
    await promise;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({ modelRef: "cli-router/custom" });
  });

  it("applies nothing when the model sees nothing to merge", async () => {
    seedPair(db);
    const { promise } = run({ replyText: '{"consolidations": []}' });
    await expect(promise).resolves.toMatchObject({
      ok: true,
      consolidatedCount: 0,
      archivedCount: 0,
    });
    expect(readMemos(db, {}, NOW)).toHaveLength(2);
  });

  it("drops consolidations that reference unknown ids", async () => {
    seedPair(db);
    const { promise } = run({
      replyText: JSON.stringify({ consolidations: [{ keepId: 999, archiveIds: [1000] }] }),
    });
    await expect(promise).resolves.toMatchObject({ ok: true });
    expect(readMemos(db, {}, NOW)).toHaveLength(2);
  });

  it("reports auth failures without calling the model", async () => {
    seedPair(db);
    const prepare = vi.fn(async () => ({ error: "no key" }));
    const complete = vi.fn(async () => assistantReply("{}"));
    const logger = fakeLogger();
    const result = await runDreamConsolidation({
      db,
      cfg: {} as OpenClawConfig,
      agentId: "main",
      agentDir: tmpDir,
      logger,
      deps: {
        prepareModel: prepare as unknown as DreamDeps["prepareModel"],
        completeSimpleFn: complete as unknown as DreamDeps["completeSimpleFn"],
        now: () => NOW,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no key");
    expect(complete).not.toHaveBeenCalled();
  });

  it("resolves { ok: false } when prepareModel throws (gateway never crashes)", async () => {
    seedPair(db);
    const prepare = vi.fn(async () => {
      throw new Error("model registry exploded");
    });
    const complete = vi.fn(async () => assistantReply("{}"));
    const logger = fakeLogger();
    const result = await runDreamConsolidation({
      db,
      cfg: {} as OpenClawConfig,
      agentId: "main",
      agentDir: tmpDir,
      logger,
      deps: {
        prepareModel: prepare as unknown as DreamDeps["prepareModel"],
        completeSimpleFn: complete as unknown as DreamDeps["completeSimpleFn"],
        now: () => NOW,
      },
    });
    expect(result).toMatchObject({ ok: false, activeCount: 2 });
    expect(String(result.error)).toContain("model registry exploded");
    expect(complete).not.toHaveBeenCalled();
  });

  it("never archives another job's keepId (cross-job keepId defense)", async () => {
    const first = writeMemo(db, { category: "User", content: "alpha" }, NOW);
    const second = writeMemo(db, { category: "User", content: "beta" }, NOW);
    const { promise } = run({
      replyText: JSON.stringify({
        consolidations: [
          { keepId: first.id, archiveIds: [second.id] },
          { keepId: second.id, archiveIds: [first.id] },
        ],
      }),
    });
    await expect(promise).resolves.toMatchObject({ ok: true });
    // Both ids are keepIds, so both archiveIds are stripped: nothing archived.
    expect(readMemos(db, {}, NOW)).toHaveLength(2);
  });

  it("warns and fails cleanly on unparseable answers", async () => {
    seedPair(db);
    const { promise, logger } = run({ replyText: "definitely not json" });
    await expect(promise).resolves.toMatchObject({ ok: false });
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("DreamScheduler", () => {
  it("refuses invalid schedules without throwing", () => {
    const logger = fakeLogger();
    const scheduler = new DreamScheduler({
      schedule: "not a cron expression at all !!!",
      db: () =>
        new RawChatDatabase(
          path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dream-sched-")), "x.sqlite"),
        ),
      cfg: {} as OpenClawConfig,
      logger,
    });
    expect(scheduler.start()).toBe(false);
    expect(scheduler.isRunning).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
    scheduler.stop();
  });

  it("starts/stops through the injected factory and runs on demand", async () => {
    const { db, tmpDir } = makeDb();
    try {
      writeMemo(db, { category: "User", content: "lone" }, NOW);
      const logger = fakeLogger();
      const stops: Array<() => void> = [];
      let fired: (() => void) | undefined;
      const scheduler = new DreamScheduler({
        schedule: "0 3 * * *",
        timezone: "UTC",
        db,
        cfg: {} as OpenClawConfig,
        logger,
        deps: makeDeps('{"consolidations": []}').deps,
        cronFactory: (schedule, timezone, onFire) => {
          expect(schedule).toBe("0 3 * * *");
          expect(timezone).toBe("UTC");
          fired = onFire;
          return {
            stop: vi.fn(() => {
              stops.push(() => {});
            }),
          };
        },
      });
      expect(scheduler.start()).toBe(true);
      expect(scheduler.isRunning).toBe(true);
      // Double start reuses the job.
      expect(scheduler.start()).toBe(true);
      expect(fired).toBeDefined();

      const result = await scheduler.runOnce();
      expect(result).toMatchObject({ ok: true, skipped: true, activeCount: 1 });

      scheduler.stop();
      expect(scheduler.isRunning).toBe(false);
      expect(stops).toHaveLength(1);
      scheduler.stop();
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips a second run while one is in flight", async () => {
    const { db, tmpDir } = makeDb();
    try {
      seedPair(db);
      const prepare = vi.fn(() => new Promise<never>(() => {}));
      const scheduler = new DreamScheduler({
        db,
        cfg: {} as OpenClawConfig,
        logger: fakeLogger(),
        deps: {
          prepareModel: prepare as unknown as DreamDeps["prepareModel"],
          now: () => NOW,
        },
      });
      const first = scheduler.runOnce();
      await expect(scheduler.runOnce()).resolves.toMatchObject({
        ok: true,
        skipped: true,
        reason: "dream run already in flight",
      });
      expect(prepare).toHaveBeenCalledTimes(1);
      void first;
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("plugin wiring (raw-chat-search-dream service)", () => {
  it("registers the dream service and honors the enabled flag", () => {
    const services: Array<{ id: string; start: (ctx: never) => void; stop?: () => void }> = [];
    const api = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      on: vi.fn(),
      registerTool: vi.fn(),
      registerService: vi.fn((service: (typeof services)[number]) => {
        services.push(service);
      }),
      pluginConfig: { dream: { enabled: false } },
    };
    rawChatSearchPlugin.register(api as never);
    const dream = services.find((service) => service.id === "raw-chat-search-dream");
    expect(dream).toBeDefined();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-dream-svc-"));
    try {
      dream!.start({ config: {}, stateDir: tmpDir, logger: api.logger } as never);
      expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("dream disabled"));
      dream!.stop?.();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("starts the scheduler when enabled and stops it cleanly", () => {
    const services: Array<{ id: string; start: (ctx: never) => void; stop?: () => void }> = [];
    const api = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      on: vi.fn(),
      registerTool: vi.fn(),
      registerService: vi.fn((service: (typeof services)[number]) => {
        services.push(service);
      }),
      pluginConfig: { dream: { enabled: true, schedule: "0 3 * * *", language: "ja" } },
    };
    rawChatSearchPlugin.register(api as never);
    const dream = services.find((service) => service.id === "raw-chat-search-dream");
    expect(dream).toBeDefined();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-chat-dream-svc-"));
    try {
      dream!.start({ config: {}, stateDir: tmpDir, logger: api.logger } as never);
      expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("dream scheduled"));
      dream!.stop?.();
      // Double stop is safe.
      dream!.stop?.();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import { isProtectedSessionKey, type ProtectedSessionConfig } from "./protected-session.js";
import { capEntryCount, pruneStaleEntries } from "./store.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdDirs: string[] = [];

async function createCaseDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  createdDirs.length = 0;
});

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

function makeStore(entries: Array<[string, SessionEntry]>): Record<string, SessionEntry> {
  return Object.fromEntries(entries);
}

const PROTECTED_CFG: ProtectedSessionConfig = {
  session: { protectedKeys: ["agent:main:main"] },
};

// ---------------------------------------------------------------------------
// pruneStaleEntries — protected key survives pruning
// ---------------------------------------------------------------------------
describe("pruneStaleEntries — protected key exclusion", () => {
  it("skips protected keys when pruning stale entries", () => {
    const now = Date.now();
    const store = makeStore([
      ["agent:main:main", makeEntry(now - 60 * DAY_MS)], // very stale but protected
      ["stale-other", makeEntry(now - 60 * DAY_MS)],
      ["fresh", makeEntry(now - 1 * DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS, {
      protectedSessionCfg: PROTECTED_CFG,
    });

    expect(pruned).toBe(1); // only stale-other pruned
    expect(store["agent:main:main"]).toBeDefined(); // protected survives
    expect(store["stale-other"]).toBeUndefined();
    expect(store.fresh).toBeDefined();
  });

  it("still prunes unprotected stale entries normally", () => {
    const now = Date.now();
    const store = makeStore([
      ["stale-a", makeEntry(now - 60 * DAY_MS)],
      ["stale-b", makeEntry(now - 60 * DAY_MS)],
      ["fresh", makeEntry(now - 1 * DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS, {
      protectedSessionCfg: PROTECTED_CFG,
    });

    expect(pruned).toBe(2);
    expect(store.fresh).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// capEntryCount — protected key survives capping
// ---------------------------------------------------------------------------
describe("capEntryCount — protected key exclusion", () => {
  it("never evicts protected keys even when over limit", () => {
    const now = Date.now();
    const store = makeStore([
      ["agent:main:main", makeEntry(now - 4 * DAY_MS)], // old but protected
      ["oldest", makeEntry(now - 5 * DAY_MS)],
      ["old", makeEntry(now - 3 * DAY_MS)],
      ["mid", makeEntry(now - 2 * DAY_MS)],
      ["recent", makeEntry(now - 1 * DAY_MS)],
      ["newest", makeEntry(now)],
    ]);

    const evicted = capEntryCount(store, 3, {
      protectedSessionCfg: PROTECTED_CFG,
    });

    // With 6 entries total, 1 protected, 5 unprotected, and maxEntries=3:
    // protected key does not count toward the cap, so 5 unprotected > 3 max
    // means 2 evictions (oldest unprotected entries removed first).
    expect(evicted).toBe(2);
    expect(store["agent:main:main"]).toBeDefined(); // protected survives
    expect(store.newest).toBeDefined();
    expect(store.recent).toBeDefined();
    expect(store.mid).toBeDefined(); // within cap for unprotected
    // Oldest unprotected entries evicted
    expect(store.oldest).toBeUndefined();
    expect(store.old).toBeUndefined();
  });

  it("returns 0 when under limit", () => {
    const now = Date.now();
    const store = makeStore([
      ["agent:main:main", makeEntry(now)],
      ["other", makeEntry(now)],
    ]);

    const evicted = capEntryCount(store, 5, {
      protectedSessionCfg: PROTECTED_CFG,
    });

    expect(evicted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// enforceSessionDiskBudget — protected key survives budget eviction
// ---------------------------------------------------------------------------
describe("enforceSessionDiskBudget — protected key exclusion", () => {
  it("skips protected keys when evicting store entries to meet budget", async () => {
    const dir = await createCaseDir("openclaw-phase3-budget-");
    const storePath = path.join(dir, "sessions.json");
    const protectedSessionId = "session-protected";
    const otherSessionId = "session-other";
    const protectedTranscript = path.join(dir, `${protectedSessionId}.jsonl`);
    const otherTranscript = path.join(dir, `${otherSessionId}.jsonl`);

    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: protectedSessionId,
        updatedAt: Date.now(),
      },
      "agent:main:telegram:direct:999": {
        sessionId: otherSessionId,
        updatedAt: Date.now(),
      },
    };

    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
    // Write transcripts large enough to exceed budget
    await fs.writeFile(protectedTranscript, "p".repeat(200), "utf-8");
    await fs.writeFile(otherTranscript, "o".repeat(200), "utf-8");

    const result = await enforceSessionDiskBudget({
      store,
      storePath,
      maintenance: {
        maxDiskBytes: 300,
        highWaterBytes: 250,
      },
      warnOnly: false,
      protectedSessionCfg: PROTECTED_CFG,
    });

    // Protected key must survive in the store
    expect(store["agent:main:main"]).toBeDefined();
    expect(result).toEqual(
      expect.objectContaining({
        removedEntries: expect.any(Number),
      }),
    );
  });

  it("replaces raw activeSessionKey comparison with isProtectedSessionKey normalization", async () => {
    const dir = await createCaseDir("openclaw-phase3-normalize-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "session-norm";
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);

    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId,
        updatedAt: Date.now(),
      },
    };

    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
    await fs.writeFile(transcriptPath, "x".repeat(300), "utf-8");

    // Use lowercase "main" as activeSessionKey — old code would miss this.
    const result = await enforceSessionDiskBudget({
      store,
      storePath,
      activeSessionKey: "main",
      maintenance: {
        maxDiskBytes: 200,
        highWaterBytes: 150,
      },
      warnOnly: false,
      protectedSessionCfg: PROTECTED_CFG,
    });

    // Protected key must survive even with alias activeSessionKey
    expect(store["agent:main:main"]).toBeDefined();
    expect(result).toEqual(
      expect.objectContaining({
        overBudget: expect.any(Boolean),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// isProtectedSessionKey — sanity check used by all surfaces
// ---------------------------------------------------------------------------
describe("isProtectedSessionKey — sanity for Phase 3", () => {
  it("recognizes main session as protected", () => {
    expect(isProtectedSessionKey("agent:main:main", PROTECTED_CFG)).toBe(true);
  });

  it("recognizes unprotected session keys", () => {
    expect(isProtectedSessionKey("agent:main:telegram:direct:999", PROTECTED_CFG)).toBe(false);
  });

  it("recognizes main alias as protected", () => {
    expect(isProtectedSessionKey("main", PROTECTED_CFG)).toBe(true);
  });
});

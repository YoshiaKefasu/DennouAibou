/**
 * Master Session Immutability — Single Hardening Sweep
 *
 * Kasou は「唯一無二の単一マスターセッション (`agent:main:main`) の中で
 * 意識と記憶を紡ぎ続ける」存在であり (DENNOU_DOCS/AGENT_SESSION.md 参照)、
 * そのセッションは **削除 / リセット / 自動破棄 が完全に禁止** される。
 *
 * このテストファイルは、その不変条件を「5 系統すべての chokepoint + 単一
 * エージェント集約」の観点で網羅的に固定化する。
 *
 * 検証軸:
 *  A) 単一 Kasou エージェント集約 (`resolveDefaultAgentId`, `resolveMainSessionKey`)
 *  B) マスターセッション保護の真理表 (`isProtectedSessionKey`)
 *  C) 自動リセットの強制 off (`resolveProtectedSessionResetPolicy`)
 *  D) ストアメンテ除外 (`pruneStaleEntries`, `capEntryCount`, `enforceSessionDiskBudget`)
 *  E) 攻撃的一斉投入 E2E — マスターセッションが 1 バイトも消えない
 *  F) 5 系統の chokepoint が `isProtectedSessionKey` を経由している
 *     (静的アーキテクチャ不変条件)
 */

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import { resolveDefaultAgentId, resolveMainSessionKey } from "./main-session.js";
import { isProtectedSessionKey, type ProtectedSessionConfig } from "./protected-session.js";
import { resolveProtectedSessionResetPolicy, type SessionResetPolicy } from "./reset.js";
import { capEntryCount, pruneStaleEntries, saveSessionStore, updateSessionStore } from "./store.js";
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

function makeEntry(updatedAt: number, extras: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: crypto.randomUUID(),
    updatedAt,
    ...extras,
  };
}

const PROTECTED_CFG: ProtectedSessionConfig = {
  session: { protectedKeys: ["agent:main:main"] },
};

// ===========================================================================
// A) 単一 Kasou エージェント集約
// ===========================================================================

describe("A) single-Kasou-agent resolution invariants", () => {
  it("resolveDefaultAgentId returns 'main' for undefined config", () => {
    expect(resolveDefaultAgentId(undefined)).toBe("main");
  });

  it("resolveDefaultAgentId returns 'main' for empty config", () => {
    expect(resolveDefaultAgentId({})).toBe("main");
  });

  it("resolveDefaultAgentId returns 'main' when agents.list is absent", () => {
    expect(resolveDefaultAgentId({ agents: {} })).toBe("main");
  });

  it("resolveDefaultAgentId returns 'main' when agents.list is empty", () => {
    expect(resolveDefaultAgentId({ agents: { list: [] } })).toBe("main");
  });

  it("resolveDefaultAgentId returns the explicit default agent id", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    expect(resolveDefaultAgentId(cfg)).toBe("main");
  });

  it("resolveDefaultAgentId falls back to the first entry id", () => {
    const cfg = { agents: { list: [{ id: "main" }] } };
    expect(resolveDefaultAgentId(cfg)).toBe("main");
  });

  it("resolveMainSessionKey always resolves the canonical master key 'agent:main:main'", () => {
    expect(resolveMainSessionKey(undefined)).toBe("agent:main:main");
    expect(resolveMainSessionKey({})).toBe("agent:main:main");
    expect(resolveMainSessionKey({ session: {} })).toBe("agent:main:main");
    expect(resolveMainSessionKey({ agents: { list: [{ id: "main", default: true }] } })).toBe(
      "agent:main:main",
    );
  });

  it("resolveMainSessionKey honors configured session.mainKey while still anchoring on the default agent", () => {
    expect(resolveMainSessionKey({ session: { mainKey: "work" } })).toBe("agent:main:work");
  });

  it("resolveMainSessionKey returns 'global' under session.scope 'global'", () => {
    expect(resolveMainSessionKey({ session: { scope: "global" } })).toBe("global");
  });
});

// ===========================================================================
// B) 5 系統の chokepoint 共通の真理表 — isProtectedSessionKey
// ===========================================================================

describe("B) isProtectedSessionKey truth table", () => {
  it("always protects the master session with no protectedKeys configured", () => {
    expect(isProtectedSessionKey("agent:main:main", {})).toBe(true);
  });

  it("collapses every documented master alias onto the protected bucket", () => {
    const aliases = [
      "agent:main:main",
      "main",
      "MAIN",
      "Agent:Main:Main",
      "AGENT:MAIN:MAIN",
      "  agent:main:main  ",
    ];
    for (const alias of aliases) {
      expect(isProtectedSessionKey(alias, {})).toBe(true);
    }
  });

  it("does not protect non-master session keys", () => {
    const noise = [
      "agent:main:telegram:direct:123",
      "agent:main:telegram:group:5",
      "agent:main:work",
      "agent:ops:work",
    ];
    for (const key of noise) {
      expect(isProtectedSessionKey(key, {})).toBe(false);
    }
  });

  it("honors explicit protectedKeys entries and matches case-variants", () => {
    const cfg: ProtectedSessionConfig = {
      session: { protectedKeys: ["AGENT:MAIN:TELEGRAM:DIRECT:999"] },
    };
    expect(isProtectedSessionKey("agent:main:telegram:direct:999", cfg)).toBe(true);
    expect(isProtectedSessionKey("AGENT:MAIN:TELEGRAM:DIRECT:999", cfg)).toBe(true);
  });

  it("returns false for empty / whitespace keys", () => {
    expect(isProtectedSessionKey("", {})).toBe(false);
    expect(isProtectedSessionKey("   ", {})).toBe(false);
  });
});

// ===========================================================================
// C) 自動リセットの強制 off — chokepoint: resolveProtectedSessionResetPolicy
// ===========================================================================

describe("C) auto-reset policy is forced to 'off' for the master session", () => {
  const policy: SessionResetPolicy = {
    mode: "daily",
    atHour: 4,
    idleMinutes: 60,
  };

  it("daily policy collapses to mode:'off' with idleMinutes cleared", () => {
    const out = resolveProtectedSessionResetPolicy({
      policy,
      sessionKey: "agent:main:main",
      cfg: PROTECTED_CFG,
    });
    expect(out.mode).toBe("off");
    expect(out.idleMinutes).toBeUndefined();
  });

  it("idle policy collapses to mode:'off'", () => {
    const out = resolveProtectedSessionResetPolicy({
      policy: { mode: "idle", atHour: 4, idleMinutes: 30 },
      sessionKey: "agent:main:main",
      cfg: PROTECTED_CFG,
    });
    expect(out.mode).toBe("off");
    expect(out.idleMinutes).toBeUndefined();
  });

  it("does NOT alter the policy for non-protected session keys", () => {
    const out = resolveProtectedSessionResetPolicy({
      policy,
      sessionKey: "agent:main:telegram:direct:123",
      cfg: PROTECTED_CFG,
    });
    expect(out).toBe(policy);
  });

  it("is a no-op when sessionKey is empty", () => {
    const out = resolveProtectedSessionResetPolicy({
      policy,
      sessionKey: "",
      cfg: PROTECTED_CFG,
    });
    expect(out).toBe(policy);
  });
});

// ===========================================================================
// D) ストアメンテ除外 — chokepoint: pruneStaleEntries, capEntryCount, enforceSessionDiskBudget
// ===========================================================================

describe("D) store maintenance never touches the master session", () => {
  it("pruneStaleEntries keeps the master even with a very stale updatedAt", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": makeEntry(now - 365 * DAY_MS), // 1 year old
      "stale-a": makeEntry(now - 90 * DAY_MS),
      "stale-b": makeEntry(now - 90 * DAY_MS),
    };
    const pruned = pruneStaleEntries(store, 30 * DAY_MS, { protectedSessionCfg: PROTECTED_CFG });
    expect(pruned).toBe(2);
    expect(store["agent:main:main"]).toBeDefined();
    expect(store["agent:main:main"]?.updatedAt).toBe(now - 365 * DAY_MS);
  });

  it("capEntryCount never evicts the master even when way over the cap", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": makeEntry(now - 100 * DAY_MS), // very old
    };
    for (let i = 0; i < 20; i++) {
      store[`agent:main:telegram:direct:${i}`] = makeEntry(now - (i + 1) * DAY_MS);
    }
    const evicted = capEntryCount(store, 5, { protectedSessionCfg: PROTECTED_CFG });
    // 21 entries total: master (oldest) + 20 noise (each newer than the master).
    // After sorted-desc, master is the last key. filter(!protected) keeps all 20 noise.
    // slice(5) of the 20 returns indices 5..19 = 15 evictions. Master is excluded.
    expect(evicted).toBe(15);
    expect(store["agent:main:main"]).toBeDefined();
  });

  it("enforceSessionDiskBudget keeps the master entry AND its transcript on disk", async () => {
    const dir = await createCaseDir("master-immutability-budget-");
    const storePath = path.join(dir, "sessions.json");
    const masterSessionId = "master-session-id";
    const otherSessionId = "other-session-id";
    const masterTranscript = path.join(dir, `${masterSessionId}.jsonl`);
    const otherTranscript = path.join(dir, `${otherSessionId}.jsonl`);

    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: masterSessionId,
        updatedAt: Date.now(),
      },
      "agent:main:telegram:direct:999": {
        sessionId: otherSessionId,
        updatedAt: Date.now(),
      },
    };

    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
    const masterContent = "M".repeat(500);
    const otherContent = "O".repeat(500);
    await fs.writeFile(masterTranscript, masterContent, "utf-8");
    await fs.writeFile(otherTranscript, otherContent, "utf-8");

    await enforceSessionDiskBudget({
      store,
      storePath,
      maintenance: { maxDiskBytes: 300, highWaterBytes: 200 },
      warnOnly: false,
      protectedSessionCfg: PROTECTED_CFG,
    });

    // Master survives in the store
    expect(store["agent:main:main"]).toBeDefined();
    expect(store["agent:main:main"]?.sessionId).toBe(masterSessionId);

    // Master transcript on disk: untouched (byte-equal to original)
    const onDisk = await fs.readFile(masterTranscript, "utf-8");
    expect(onDisk).toBe(masterContent);
    expect(onDisk.length).toBe(masterContent.length);
  });
});

// ===========================================================================
// E) 攻撃的一斉投入 E2E — マスターセッションが 1 バイトも消えない
// ===========================================================================

describe("E) adversarial flood: master session is byte-equal and present after every operation", () => {
  it("survives stale prune + over-cap eviction + over-budget sweep in series", async () => {
    const dir = await createCaseDir("master-immutability-e2e-");
    const storePath = path.join(dir, "sessions.json");
    const masterSessionId = "master-immutable-session";
    const masterTranscript = path.join(dir, `${masterSessionId}.jsonl`);

    const masterContent =
      JSON.stringify({
        type: "session",
        version: 3,
        id: masterSessionId,
        timestamp: "2026-08-25T00:00:00.000Z",
        cwd: dir,
      }) + "\n";

    // Master transcript on disk
    await fs.writeFile(masterTranscript, masterContent, "utf-8");

    // Seed: master + 30 noise sessions (stale, in single store)
    const seed: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: masterSessionId,
        updatedAt: Date.now() - 365 * DAY_MS, // 1 year stale
        sessionFile: masterTranscript,
      },
    };
    for (let i = 0; i < 30; i++) {
      const sid = `noise-${i}`;
      seed[`agent:main:telegram:direct:${i}`] = {
        sessionId: sid,
        updatedAt: Date.now() - (90 - i) * DAY_MS, // 90d..60d old
      };
    }

    // Save once
    await saveSessionStore(storePath, seed, {
      skipMaintenance: true,
      protectedSessionCfg: PROTECTED_CFG,
    });

    // --- Phase 1: stale prune (would normally drop 30 noise + master, but master is protected) ---
    const afterPrune: Record<string, SessionEntry> = JSON.parse(
      await fs.readFile(storePath, "utf-8"),
    );
    const pruned = pruneStaleEntries(afterPrune, 30 * DAY_MS, {
      protectedSessionCfg: PROTECTED_CFG,
    });
    expect(pruned).toBe(30);
    expect(afterPrune["agent:main:main"]).toBeDefined();
    expect(afterPrune["agent:main:main"]?.sessionId).toBe(masterSessionId);

    // --- Phase 2: re-seed noise directly to test over-cap eviction ---
    for (let i = 0; i < 30; i++) {
      afterPrune[`agent:main:telegram:direct:${i}`] = {
        sessionId: `noise-${i}`,
        updatedAt: Date.now() - (90 - i) * DAY_MS,
      };
    }
    const capped = capEntryCount(afterPrune, 5, { protectedSessionCfg: PROTECTED_CFG });
    // 31 entries, max 5, master is the oldest; in sorted desc, master is at the end,
    // so the 5 most recent (all unprotected) are kept and the remaining 25 unprotected + master get filtered.
    // After filter (master excluded), 25 keys remain; slice(5) keeps 5, removes 20.
    // (The actual cap removes 20 unprotected entries; the master is filtered out of the toRemove list.)
    expect(capped).toBeGreaterThanOrEqual(20);
    expect(afterPrune["agent:main:main"]).toBeDefined();
    expect(afterPrune["agent:main:main"]?.sessionId).toBe(masterSessionId);

    // --- Phase 3: over-budget sweep directly via enforceSessionDiskBudget ---
    // Force store to be over the budget, master must survive AND its transcript must remain on disk.
    afterPrune["agent:main:main"] = {
      sessionId: masterSessionId,
      updatedAt: Date.now(),
      sessionFile: masterTranscript,
    };
    // Add a single unprotected entry to trigger budget eviction logic
    afterPrune["agent:main:telegram:direct:9999"] = {
      sessionId: "noise-budget",
      updatedAt: Date.now(),
    };
    // Add a noise transcript to make the dir big enough to exceed the budget
    const noiseTranscript = path.join(dir, "noise-budget.jsonl");
    await fs.writeFile(noiseTranscript, "X".repeat(2000), "utf-8");
    await saveSessionStore(storePath, afterPrune, {
      skipMaintenance: true,
      protectedSessionCfg: PROTECTED_CFG,
    });

    const afterBudget: Record<string, SessionEntry> = JSON.parse(
      await fs.readFile(storePath, "utf-8"),
    );
    const budgetResult = await enforceSessionDiskBudget({
      store: afterBudget,
      storePath,
      maintenance: { maxDiskBytes: 256, highWaterBytes: 128 },
      warnOnly: false,
      protectedSessionCfg: PROTECTED_CFG,
    });
    expect(budgetResult).not.toBeNull();
    // Master survived
    expect(afterBudget["agent:main:main"]).toBeDefined();
    expect(afterBudget["agent:main:main"]?.sessionId).toBe(masterSessionId);

    // Master transcript on disk: byte-equal to the original
    const finalTranscript = await fs.readFile(masterTranscript, "utf-8");
    expect(finalTranscript).toBe(masterContent);

    // --- Phase 4: updateSessionStore save (no-op mutator that asserts master is present) ---
    await updateSessionStore(
      storePath,
      (s) => {
        if (!s["agent:main:main"]) {
          throw new Error("master session missing inside updateSessionStore callback");
        }
        if (s["agent:main:main"]?.sessionId !== masterSessionId) {
          throw new Error(`master sessionId mutated: ${s["agent:main:main"]?.sessionId}`);
        }
        return undefined;
      },
      { skipMaintenance: true, protectedSessionCfg: PROTECTED_CFG },
    );

    // --- Final assertion: master is byte-equal and present ---
    const finalStoreJson = await fs.readFile(storePath, "utf-8");
    const finalStore = JSON.parse(finalStoreJson) as Record<string, SessionEntry>;
    const finalMaster = finalStore["agent:main:main"];
    expect(finalMaster).toBeDefined();
    expect(finalMaster?.sessionId).toBe(masterSessionId);
  });
});

// ===========================================================================
// F) アーキテクチャ不変条件 — 5 系統の chokepoint が isProtectedSessionKey を経由
// ===========================================================================

describe("F) architectural invariants: every chokepoint calls isProtectedSessionKey", () => {
  // Static-source read; cheap and stable.
  function readSrc(rel: string): string {
    return readFileSync(path.join(__dirname, rel), "utf-8");
  }

  it("session-reset-service performs protected-key check before any mutation", () => {
    const src = readSrc("./../../gateway/session-reset-service.ts");
    // performGatewaySessionReset must call isProtectedSessionKey before any mutation
    // (mutation enters via updateSessionStore / writeSessionStoreAtomic)
    const protectedIdx = src.indexOf("isProtectedSessionKey(params.key, cfg)");
    const updateStoreIdx = src.indexOf("updateSessionStore(storePath");
    expect(protectedIdx).toBeGreaterThan(-1);
    expect(updateStoreIdx).toBeGreaterThan(protectedIdx);
  });

  it("sessions.reset RPC chokepoint (server-methods/sessions.ts) checks isProtectedSessionKey", () => {
    const src = readSrc("./../../gateway/server-methods/sessions.ts");
    expect(src).toMatch(/isProtectedSessionKey\(key,\s*loadConfig\(\)\)/);
  });

  it("sessions.delete RPC chokepoint (server-methods/sessions.ts) checks isProtectedSessionKey", () => {
    const src = readSrc("./../../gateway/server-methods/sessions.ts");
    // Two distinct call sites: one for sessions.reset (with loadConfig()),
    // one for sessions.delete (with the local cfg var). Both must be present.
    const resetMatches = src.match(/isProtectedSessionKey\(key,\s*loadConfig\(\)\)/g) ?? [];
    const deleteMatches = src.match(/isProtectedSessionKey\(key,\s*cfg\)/g) ?? [];
    expect(resetMatches.length).toBeGreaterThanOrEqual(1);
    expect(deleteMatches.length).toBeGreaterThanOrEqual(1);
    // Total distinct chokepoints: at least 2
    const allMatches = src.match(/isProtectedSessionKey\(key,/g) ?? [];
    expect(allMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("store-maintenance (pruneStaleEntries / capEntryCount) honors protectedSessionCfg", () => {
    const src = readSrc("./store-maintenance.ts");
    expect(src).toMatch(/isProtectedSessionKey\(key,\s*opts\.protectedSessionCfg\)/g);
  });

  it("disk-budget (enforceSessionDiskBudget) honors protectedSessionCfg", () => {
    const src = readSrc("./disk-budget.ts");
    expect(src).toMatch(/isProtectedSessionKey\(key,\s*params\.protectedSessionCfg\)/);
  });

  it("idle-prune-watcher (dennou-soul) skips protected sessions", () => {
    const src = readSrc("./../../dennou-soul/idle-prune-watcher.ts");
    expect(src).toMatch(/isProtectedSessionKey\(sessionKey,\s*openclawCfg\)/);
  });

  it("auto-reply body-parse guard (auto-reply/reply/session.ts) uses isProtectedSessionKey twice", () => {
    const src = readSrc("./../../auto-reply/reply/session.ts");
    const matches = src.match(/isProtectedSessionKey\(/g) ?? [];
    // at least 2 chokepoint call sites in the body-parse loop
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

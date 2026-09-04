import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyRemovals,
  hashMessageRows,
  identifyRemovableOrphans,
  isRemovableOrphan,
  runRepairForFile,
} from "../src/repair.js";

function entry(id: string, parentId: string | null, extras: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: extras.type ?? "message",
    id,
    parentId,
    timestamp: "2026-09-04T00:00:00Z",
    ...extras,
  });
}

function header(id = "session-a"): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-09-04T00:00:00Z",
    cwd: "/tmp/agent",
  });
}

function buildOrphanFixture(): string {
  return [
    header(),
    entry("u1", null, { type: "message", message: { role: "user", content: "hi" } }),
    entry("a1", "u1", { type: "message", message: { role: "assistant", content: "hello" } }),
    // Orphan: snapshot referencing a missing parent.
    entry("snap-1", "gone", { type: "custom", customType: "model-snapshot", data: { foo: 1 } }),
    entry("snap-2", "also-gone", {
      type: "custom",
      customType: "prompt-error",
      data: { msg: "x" },
    }),
    "",
  ].join("\n");
}

describe("isRemovableOrphan", () => {
  it("returns true only for non-message types", () => {
    expect(isRemovableOrphan({ id: "x", parentId: null, type: "custom" })).toBe(true);
    expect(isRemovableOrphan({ id: "x", parentId: null, type: "model-snapshot" })).toBe(true);
    expect(isRemovableOrphan({ id: "x", parentId: null, type: "message" })).toBe(false);
  });
});

describe("identifyRemovableOrphans", () => {
  it("marks only non-message orphans as removable", () => {
    const content = [
      header(),
      entry("u1", null, { type: "message", message: { role: "user", content: "hi" } }),
      entry("snap-x", "missing-parent", { type: "custom", customType: "model-snapshot" }),
      // Orphan message row — must NOT be removed.
      entry("orphan-msg", "missing-parent", {
        type: "message",
        message: { role: "user", content: "ghost" },
      }),
    ].join("\n");
    const info = identifyRemovableOrphans(content);
    expect(info.orphanEntries.map((o) => o.id).sort()).toEqual(["orphan-msg", "snap-x"]);
    expect(info.removableEntries.map((o) => o.id).sort()).toEqual(["snap-x"]);
  });
});

describe("applyRemovals", () => {
  it("removes only the listed ids and preserves malformed lines", () => {
    const content = [
      header(),
      entry("u1", null, { type: "message", message: { role: "user", content: "hi" } }),
      entry("snap-x", "gone", { type: "custom", customType: "model-snapshot" }),
      "{not-json",
    ].join("\n");
    const result = applyRemovals(content, new Set(["snap-x"]));
    expect(result.removedCount).toBe(1);
    expect(result.content).not.toContain("snap-x");
    expect(result.content).toContain("u1");
    expect(result.content).toContain("{not-json");
  });
});

describe("hashMessageRows", () => {
  it("is stable across re-runs and ignores non-message rows", async () => {
    const content = [
      header(),
      entry("snap-x", "gone", { type: "custom", customType: "model-snapshot" }),
      entry("u1", null, { type: "message", message: { role: "user", content: "hi" } }),
      entry("a1", "u1", { type: "message", message: { role: "assistant", content: "hello" } }),
    ].join("\n");
    const h1 = await hashMessageRows(content);
    const h2 = await hashMessageRows(content);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("runRepairForFile — integration (filesystem)", () => {
  let tmpDir = "";
  let sourceFile = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-integrity-guard-repair-"));
    sourceFile = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(sourceFile, buildOrphanFixture(), "utf-8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns skipped with no-anomalies when the file has no removable orphans", async () => {
    const clean = [
      header(),
      entry("u1", null, { type: "message", message: { role: "user", content: "hi" } }),
      entry("a1", "u1", { type: "message", message: { role: "assistant", content: "hello" } }),
    ].join("\n");
    await fs.writeFile(sourceFile, clean, "utf-8");
    const outcome = await runRepairForFile({ file: sourceFile, content: clean, autoRepair: true });
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") {
      expect(outcome.reason).toBe("no-anomalies");
    }
    const siblings = await fs.readdir(tmpDir);
    expect(siblings.filter((s) => s.includes(".bak."))).toHaveLength(0);
  });

  it("returns skipped with auto-repair-disabled without touching the file when autoRepair=false", async () => {
    const content = await fs.readFile(sourceFile, "utf-8");
    const outcome = await runRepairForFile({ file: sourceFile, content, autoRepair: false });
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped" || outcome.reason !== "auto-repair-disabled") {
      throw new Error(`expected skipped/auto-repair-disabled, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.dryRun.removableCount).toBe(2);
    const after = await fs.readFile(sourceFile, "utf-8");
    expect(after).toBe(content);
    const siblings = await fs.readdir(tmpDir);
    expect(siblings.filter((s) => s.includes(".bak."))).toHaveLength(0);
  });

  it("removes only non-message orphans, leaves user/assistant untouched, and produces a backup", async () => {
    const before = await fs.readFile(sourceFile, "utf-8");
    const beforeHash = await hashMessageRows(before);
    const outcome = await runRepairForFile({ file: sourceFile, content: before, autoRepair: true });
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") {
      throw new Error(`expected applied, got ${outcome.status}`);
    }
    expect(outcome.removedCount).toBe(2);
    expect(outcome.backupPath).toMatch(/\.bak\.\d{8}-\d{6}$/);
    expect(outcome.reparse.orphanCount).toBe(0);
    expect(outcome.reparse.messageRowHash).toBe(beforeHash);

    const after = await fs.readFile(sourceFile, "utf-8");
    expect(after).not.toContain("snap-1");
    expect(after).not.toContain("snap-2");
    expect(after).toContain('"id":"u1"');
    expect(after).toContain('"id":"a1"');
    expect(after).toContain('"role":"user"');
    expect(after).toContain('"role":"assistant"');

    // Backup exists and matches the pre-repair content byte-for-byte.
    const backup = await fs.readFile(outcome.backupPath, "utf-8");
    expect(backup).toBe(before);

    // Backup has the expected sibling location.
    expect(path.dirname(outcome.backupPath)).toBe(tmpDir);
    const siblings = await fs.readdir(tmpDir);
    expect(siblings.filter((s) => s.includes(".bak.")).length).toBeGreaterThanOrEqual(1);
  });
});

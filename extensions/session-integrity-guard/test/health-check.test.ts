import { describe, expect, it } from "vitest";
import { formatHealthCheckLine, runHealthCheck } from "../src/health-check.js";

function entry(id: string, parentId: string | null, extras: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: extras.type ?? "message",
    id,
    parentId,
    timestamp: "2026-09-04T00:00:00Z",
    ...extras,
  });
}

function header(id = "00000000-0000-0000-0000-000000000001"): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-09-04T00:00:00Z",
    cwd: "/tmp/agent",
  });
}

describe("runHealthCheck — happy path", () => {
  it("returns zero anomalies for a clean session", () => {
    const content = [
      header("session-a"),
      entry("u1", null, { type: "message", message: { role: "user", content: "hi" } }),
      entry("a1", "u1", { type: "message", message: { role: "assistant", content: "hello" } }),
      "",
    ].join("\n");

    const result = runHealthCheck(content);
    expect(result).toMatchObject({
      entryCount: 2,
      jsonErrorCount: 0,
      duplicateIdCount: 0,
      orphanCount: 0,
      leafCount: 1, // a1 (leaf); u1 is referenced as parentId
    });
    expect(result.orphanEntries).toEqual([]);
    expect(result.duplicateIds).toEqual([]);
  });

  it("counts the header row as 1 total line but excludes it from leaf math", () => {
    const content = [header("s"), entry("u1", null), entry("a1", "u1")].join("\n");
    const result = runHealthCheck(content);
    expect(result.totalLines).toBe(3);
    expect(result.entryCount).toBe(2);
    expect(result.leafCount).toBe(1);
  });
});

describe("runHealthCheck — orphan detection (design contract)", () => {
  it("counts orphan: parentId !== null && parentId not present", () => {
    // 'orphan-x' references parent 'gone' which never appears. 'a1' is a normal child.
    const content = [
      header("s"),
      entry("u1", null),
      entry("a1", "u1"),
      entry("orphan-x", "gone", { type: "message" }),
    ].join("\n");

    const result = runHealthCheck(content);
    expect(result.orphanCount).toBe(1);
    expect(result.orphanEntries).toEqual([{ id: "orphan-x", type: "message" }]);
  });

  it("excludes the root entry (parentId === null) from orphan count", () => {
    const content = [
      header("s"),
      entry("u1", null),
      entry("a1", "gone"), // a1 -> gone (orphan), u1 -> null (root, NOT orphan)
    ].join("\n");

    const result = runHealthCheck(content);
    expect(result.orphanCount).toBe(1);
    expect(result.orphanEntries.map((o) => o.id).sort()).toEqual(["a1"]);
  });
});

describe("runHealthCheck — duplicate ids", () => {
  it("detects ids appearing more than once", () => {
    const content = [
      header("s"),
      entry("u1", null),
      entry("u1", null), // duplicate id
      entry("a1", "u1"),
    ].join("\n");

    const result = runHealthCheck(content);
    expect(result.duplicateIdCount).toBe(1);
    expect(result.duplicateIds.sort()).toEqual(["u1"]);
  });
});

describe("runHealthCheck — JSON syntax", () => {
  it("counts every malformed line as jsonErrorCount", () => {
    const content = [
      header("s"),
      entry("u1", null),
      "{not-json",
      entry("a1", "u1"),
      "still-bad",
    ].join("\n");

    const result = runHealthCheck(content);
    expect(result.jsonErrorCount).toBe(2);
    expect(result.entryCount).toBe(2);
  });
});

describe("runHealthCheck — leaf count", () => {
  it("returns leafCount === 1 for a single linear chain", () => {
    const content = [
      header("s"),
      entry("u1", null),
      entry("a1", "u1"),
      entry("u2", "a1"),
      entry("a2", "u2"),
    ].join("\n");

    const result = runHealthCheck(content);
    expect(result.leafCount).toBe(1);
  });

  it("returns leafCount === 2 when the chain splits into two branches", () => {
    // u1 -> a1 -> u2, and also u1 -> branch2 (no further children)
    const content = [
      header("s"),
      entry("u1", null),
      entry("a1", "u1"),
      entry("u2", "a1"),
      entry("branch2", "u1"),
    ].join("\n");

    const result = runHealthCheck(content);
    expect(result.leafCount).toBe(2);
  });

  it("does NOT count the header row as a leaf", () => {
    // Only header row present → 0 leaves (header is excluded)
    const content = [header("s")].join("\n");
    const result = runHealthCheck(content);
    expect(result.leafCount).toBe(0);
    expect(result.entryCount).toBe(0);
  });
});

describe("runHealthCheck — empty / whitespace", () => {
  it("returns zeroed result for empty content", () => {
    const result = runHealthCheck("");
    expect(result).toMatchObject({
      totalLines: 0,
      entryCount: 0,
      jsonErrorCount: 0,
      duplicateIdCount: 0,
      orphanCount: 0,
      leafCount: 0,
    });
  });
});

describe("formatHealthCheckLine", () => {
  it("emits a single-line summary including all four metrics", () => {
    const content = [header("s"), entry("u1", null)].join("\n");
    const result = runHealthCheck(content);
    const line = formatHealthCheckLine("/tmp/sessions/x.jsonl", result);
    expect(line).toContain("entries=1");
    expect(line).toContain("jsonErrors=0");
    expect(line).toContain("duplicates=0");
    expect(line).toContain("orphans=0");
    expect(line).toContain("leaves=1");
  });
});

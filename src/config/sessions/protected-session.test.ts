import { describe, expect, it } from "vitest";
import {
  isProtectedSessionKey,
  normalizeProtectedSessionKey,
  type ProtectedSessionConfig,
} from "./protected-session.js";

const DEFAULT_CFG: ProtectedSessionConfig = {};

describe("isProtectedSessionKey", () => {
  it("always protects the main session even with no protectedKeys configured", () => {
    expect(isProtectedSessionKey("agent:main:main", DEFAULT_CFG)).toBe(true);
  });

  it("treats the bare main alias as the main session", () => {
    expect(isProtectedSessionKey("main", DEFAULT_CFG)).toBe(true);
  });

  it("recognizes legacy agent:main aliases as the main session", () => {
    expect(isProtectedSessionKey("agent:main:main", DEFAULT_CFG)).toBe(true);
    // Legacy keys built with the hardcoded default agent id collapse to main.
    expect(
      isProtectedSessionKey("agent:main:main", {
        agents: { list: [{ id: "ops", default: true }] },
      }),
    ).toBe(true);
  });

  it("protects case-variant main aliases (case-insensitive comparison)", () => {
    for (const key of ["MAIN", "agent:main:MAIN", "AGENT:MAIN:MAIN", "Agent:Main:Main"]) {
      expect(isProtectedSessionKey(key, DEFAULT_CFG)).toBe(true);
    }
  });

  it("protects explicit protectedKeys entries", () => {
    const cfg: ProtectedSessionConfig = {
      session: { protectedKeys: ["agent:main:telegram:direct:123"] },
    };
    expect(isProtectedSessionKey("agent:main:telegram:direct:123", cfg)).toBe(true);
  });

  it("matches case-variant protectedKeys entries against the main key", () => {
    const cfg: ProtectedSessionConfig = {
      session: { protectedKeys: ["AGENT:MAIN:MAIN"] },
    };
    expect(isProtectedSessionKey("agent:main:main", cfg)).toBe(true);
    expect(isProtectedSessionKey("main", cfg)).toBe(true);
    expect(isProtectedSessionKey("MAIN", cfg)).toBe(true);
  });

  it("matches explicit entries after canonical alias normalization", () => {
    const cfg: ProtectedSessionConfig = {
      session: { protectedKeys: ["agent:main:main"] },
    };
    expect(isProtectedSessionKey("main", cfg)).toBe(true);

    const cfgAlias: ProtectedSessionConfig = {
      session: { protectedKeys: ["main"] },
    };
    expect(isProtectedSessionKey("agent:main:main", cfgAlias)).toBe(true);
  });

  it("does not protect unlisted session keys", () => {
    expect(isProtectedSessionKey("agent:main:telegram:direct:123", DEFAULT_CFG)).toBe(false);
    expect(isProtectedSessionKey("agent:main:telegram:group:5", DEFAULT_CFG)).toBe(false);
  });

  it("protects the global bucket when scope is global", () => {
    const cfg: ProtectedSessionConfig = { session: { scope: "global" } };
    expect(isProtectedSessionKey("global", cfg)).toBe(true);
    expect(isProtectedSessionKey("main", cfg)).toBe(true);
    expect(isProtectedSessionKey("agent:main:main", cfg)).toBe(true);
    // Non-main keys are not implicitly protected under global scope.
    expect(isProtectedSessionKey("agent:main:telegram:direct:123", cfg)).toBe(false);
  });

  it("honors a custom mainKey and default agent id", () => {
    const cfg: ProtectedSessionConfig = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    };
    expect(isProtectedSessionKey("agent:ops:work", cfg)).toBe(true);
    expect(isProtectedSessionKey("main", cfg)).toBe(true);
    // "main" suffix aliases still collapse onto the main bucket.
    expect(isProtectedSessionKey("agent:ops:main", cfg)).toBe(true);
    // Legacy agent:main:<mainKey> form collapses onto the main bucket.
    expect(isProtectedSessionKey("agent:main:work", cfg)).toBe(true);
  });

  it("returns false for empty keys", () => {
    expect(isProtectedSessionKey("", DEFAULT_CFG)).toBe(false);
    expect(isProtectedSessionKey("   ", DEFAULT_CFG)).toBe(false);
  });
});

describe("normalizeProtectedSessionKey", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeProtectedSessionKey("  agent:main:main  ", DEFAULT_CFG)).toBe(
      "agent:main:main",
    );
  });

  it("collapses main aliases onto the canonical main key", () => {
    expect(normalizeProtectedSessionKey("main", DEFAULT_CFG)).toBe("agent:main:main");
    expect(normalizeProtectedSessionKey("agent:main:main", DEFAULT_CFG)).toBe("agent:main:main");
  });

  it("passes non-main keys through unchanged", () => {
    expect(normalizeProtectedSessionKey("agent:main:telegram:group:5", DEFAULT_CFG)).toBe(
      "agent:main:telegram:group:5",
    );
  });

  it("lowercases case-variant keys before canonicalization", () => {
    expect(normalizeProtectedSessionKey("MAIN", DEFAULT_CFG)).toBe("agent:main:main");
    expect(normalizeProtectedSessionKey("AGENT:MAIN:MAIN", DEFAULT_CFG)).toBe("agent:main:main");
  });
});

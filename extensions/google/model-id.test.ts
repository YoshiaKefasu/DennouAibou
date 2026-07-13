import { describe, expect, it } from "vitest";
import { normalizeAntigravityModelId, normalizeGoogleModelId } from "./api.js";

describe("google model id helpers", () => {
  it.each(["gemini-3-pro", "gemini-3.1-pro", "gemini-3-1-pro"])(
    "adds default -low suffix to bare antigravity pro id: %s",
    (id) => {
      expect(normalizeAntigravityModelId(id)).toBe(`${id}-low`);
    },
  );

  it.each([
    "gemini-3-pro-low",
    "gemini-3-pro-high",
    "gemini-3.1-flash",
    "claude-opus-4-6-thinking",
  ])("keeps already-tiered and non-pro ids unchanged: %s", (id) => {
    expect(normalizeAntigravityModelId(id)).toBe(id);
  });

  it("normalizes google/ prefixed 3.1 flash aliases to official current id", () => {
    expect(normalizeGoogleModelId("google/gemini-3.1-flash")).toBe("google/gemini-3-flash-preview");
    expect(normalizeGoogleModelId("google/gemini-3.1-flash-preview")).toBe(
      "google/gemini-3-flash-preview",
    );
  });

  it("normalizes google/ prefixed model ids", () => {
    expect(normalizeGoogleModelId("google/gemini-3.1-pro")).toBe("google/gemini-3.1-pro-preview");
    expect(normalizeGoogleModelId("google/gemini-3-pro")).toBe("google/gemini-3.1-pro-preview");
  });
});

describe("official current Google model IDs", () => {
  it.each([
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemma-4-26b-a4b-it",
  ])("passes through normalizeGoogleModelId unchanged: %s", (id) => {
    expect(normalizeGoogleModelId(id)).toBe(id);
  });
});

describe("old alias normalization", () => {
  it.each([
    ["gemini-3-pro", "gemini-3.1-pro-preview"],
    ["gemini-3-pro-preview", "gemini-3.1-pro-preview"],
    ["gemini-3.1-pro", "gemini-3.1-pro-preview"],
    ["gemini-3.1-flash", "gemini-3-flash-preview"],
    ["gemini-3.1-flash-preview", "gemini-3-flash-preview"],
    ["gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite"],
    ["gemma-4-26b", "gemma-4-26b-a4b-it"],
  ])("maps %s to %s", (input, expected) => {
    expect(normalizeGoogleModelId(input)).toBe(expected);
  });
});

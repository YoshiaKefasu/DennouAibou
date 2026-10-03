import { describe, expect, it } from "vitest";
import { extractFollowupMessage, isFollowupRequestText } from "./followup-command.js";

describe("followup-command", () => {
  it("detects /followup requests", () => {
    expect(isFollowupRequestText("/followup do this after")).toBe(true);
    expect(isFollowupRequestText("/FOLLOWUP do this after")).toBe(true);
    expect(isFollowupRequestText("/followup: do this after")).toBe(true);
    expect(isFollowupRequestText("/followup")).toBe(true);
    expect(isFollowupRequestText("hello")).toBe(false);
    expect(isFollowupRequestText("/followups are great")).toBe(false);
    expect(isFollowupRequestText(undefined)).toBe(false);
  });

  it("extracts the followup message", () => {
    expect(extractFollowupMessage("/followup do this after")).toBe("do this after");
    expect(extractFollowupMessage("/followup: do this after")).toBe("do this after");
    expect(extractFollowupMessage("/followup")).toBe("");
    expect(extractFollowupMessage("hello")).toBeNull();
    expect(extractFollowupMessage(undefined)).toBeNull();
  });
});

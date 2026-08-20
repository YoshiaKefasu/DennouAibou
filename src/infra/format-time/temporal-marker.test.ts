import { describe, expect, it } from "vitest";
import {
  formatGap,
  temporalMarkerPrefix,
  TEMPORAL_MARKER_THRESHOLD_SECONDS,
} from "./temporal-marker.js";

describe("formatGap", () => {
  it("returns null for gaps below the 5-minute threshold", () => {
    expect(formatGap(0)).toBeNull();
    expect(formatGap(60)).toBeNull(); // 1 minute
    expect(formatGap(299)).toBeNull(); // just under 5 min
    expect(formatGap(TEMPORAL_MARKER_THRESHOLD_SECONDS - 1)).toBeNull();
  });

  it("returns null for non-finite values", () => {
    expect(formatGap(NaN)).toBeNull();
    expect(formatGap(Infinity)).toBeNull();
    expect(formatGap(-Infinity)).toBeNull();
  });

  it("returns null for negative values", () => {
    expect(formatGap(-1)).toBeNull();
    expect(formatGap(-300)).toBeNull();
  });

  it("formats 5 minutes as +5m", () => {
    expect(formatGap(300)).toBe("+5m");
  });

  it("formats 12 minutes as +12m", () => {
    expect(formatGap(720)).toBe("+12m");
  });

  it("formats 59 minutes as +59m", () => {
    expect(formatGap(3540)).toBe("+59m");
  });

  it("formats exactly 1 hour as +1h", () => {
    expect(formatGap(3600)).toBe("+1h");
  });

  it("formats 2 hours 15 minutes as +2h 15m", () => {
    expect(formatGap(8100)).toBe("+2h 15m");
  });

  it("formats 23 hours 59 minutes as +23h 59m", () => {
    expect(formatGap(86340)).toBe("+23h 59m");
  });

  it("formats exactly 1 day as +1d", () => {
    expect(formatGap(86400)).toBe("+1d");
  });

  it("formats 3 days 4 hours as +3d 4h", () => {
    expect(formatGap(273600)).toBe("+3d 4h");
  });

  it("formats exactly 1 week as +1w", () => {
    expect(formatGap(604800)).toBe("+1w");
  });

  it("formats 2 weeks 4 days as +2w 4d", () => {
    // 2 weeks = 2*7*24*60*60 = 1,209,600s; 4 days = 4*24*60*60 = 345,600s; total = 1,555,200s
    expect(formatGap(1555200)).toBe("+2w 4d");
  });

  it("formats 1 week 0 days as +1w (omits zero secondary unit)", () => {
    expect(formatGap(604800)).toBe("+1w");
  });

  it("formats 1 day 0 hours as +1d (omits zero secondary unit)", () => {
    expect(formatGap(86400)).toBe("+1d");
  });

  it("formats 1 hour 0 minutes as +1h (omits zero secondary unit)", () => {
    expect(formatGap(3600)).toBe("+1h");
  });
});

describe("temporalMarkerPrefix", () => {
  it("returns null for gaps below threshold", () => {
    expect(temporalMarkerPrefix(120)).toBeNull();
  });

  it("wraps marker in HTML comment with newline", () => {
    expect(temporalMarkerPrefix(720)).toBe("<!-- +12m -->\n");
  });

  it("returns null for non-finite values", () => {
    expect(temporalMarkerPrefix(NaN)).toBeNull();
    expect(temporalMarkerPrefix(Infinity)).toBeNull();
  });

  it("returns null for negative values", () => {
    expect(temporalMarkerPrefix(-100)).toBeNull();
  });

  it("formats the full range correctly", () => {
    expect(temporalMarkerPrefix(300)).toBe("<!-- +5m -->\n");
    expect(temporalMarkerPrefix(8100)).toBe("<!-- +2h 15m -->\n");
    expect(temporalMarkerPrefix(273600)).toBe("<!-- +3d 4h -->\n");
    expect(temporalMarkerPrefix(1555200)).toBe("<!-- +2w 4d -->\n");
  });
});

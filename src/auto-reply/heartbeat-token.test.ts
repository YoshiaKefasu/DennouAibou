import { describe, expect, it } from "vitest";
import { stripHeartbeatToken } from "./heartbeat-token.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

describe("stripHeartbeatToken", () => {
  it("handles undefined and empty inputs", () => {
    expect(stripHeartbeatToken(undefined)).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: false,
    });
    expect(stripHeartbeatToken("  ")).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: false,
    });
  });

  it("strips solitary HEARTBEAT_OK", () => {
    expect(stripHeartbeatToken(HEARTBEAT_TOKEN)).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: true,
    });
  });

  it("strips HEARTBEAT_OK with surrounding whitespace or punctuation", () => {
    expect(stripHeartbeatToken(`  ${HEARTBEAT_TOKEN}  `)).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: true,
    });
    expect(stripHeartbeatToken(`${HEARTBEAT_TOKEN}.`)).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: true,
    });
    expect(stripHeartbeatToken(`${HEARTBEAT_TOKEN}!`)).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: true,
    });
  });

  it("keeps meaningful text with token stripped", () => {
    expect(stripHeartbeatToken(`Hello world ${HEARTBEAT_TOKEN}`)).toEqual({
      shouldSkip: false,
      text: "Hello world",
      didStrip: true,
    });
    expect(stripHeartbeatToken(`Hello world ${HEARTBEAT_TOKEN}.`)).toEqual({
      shouldSkip: false,
      text: "Hello world.",
      didStrip: true,
    });
    expect(stripHeartbeatToken(`Status update complete ${HEARTBEAT_TOKEN}!`)).toEqual({
      shouldSkip: false,
      text: "Status update complete!",
      didStrip: true,
    });
  });
});

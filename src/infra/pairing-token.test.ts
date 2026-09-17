import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { generatePairingToken, PAIRING_TOKEN_BYTES, verifyPairingToken } from "./pairing-token.js";

describe("generatePairingToken", () => {
  it("uses the configured byte count and returns a base64url token", () => {
    const randomBytes = vi.fn(() => Buffer.from([0xfb, 0xff, 0x00]));

    expect(generatePairingToken({ randomBytes })).toBe("-_8A");
    expect(randomBytes).toHaveBeenCalledWith(PAIRING_TOKEN_BYTES);
  });
});

describe("verifyPairingToken", () => {
  it("uses constant-time comparison semantics", () => {
    expect(verifyPairingToken("secret-token", "secret-token")).toBe(true);
    expect(verifyPairingToken("secret-token", "secret-tokEn")).toBe(false);
  });

  it("rejects blank tokens even when both sides match", () => {
    expect(verifyPairingToken("", "")).toBe(false);
    expect(verifyPairingToken("   ", "   ")).toBe(false);
  });
});

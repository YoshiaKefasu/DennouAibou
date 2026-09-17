import { randomBytes as defaultRandomBytes } from "node:crypto";
import { safeEqualSecret } from "../security/secret-equal.js";

export const PAIRING_TOKEN_BYTES = 32;

export type PairingTokenDeps = {
  randomBytes?: (size: number) => Buffer;
};

export function generatePairingToken(deps: PairingTokenDeps = {}): string {
  const randomBytes = deps.randomBytes ?? defaultRandomBytes;
  return randomBytes(PAIRING_TOKEN_BYTES).toString("base64url");
}

export function verifyPairingToken(provided: string, expected: string): boolean {
  if (provided.trim().length === 0 || expected.trim().length === 0) {
    return false;
  }
  return safeEqualSecret(provided, expected);
}

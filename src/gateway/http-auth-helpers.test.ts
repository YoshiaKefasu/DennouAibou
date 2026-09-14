import type { IncomingMessage, ServerResponse } from "node:http";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  authorizeGatewayBearerRequestOrReply,
  resolveGatewayRequestedOperatorScopes,
} from "./http-auth-helpers.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: vi.fn(),
}));

vi.mock("./http-common.js", () => ({
  sendGatewayAuthFailure: vi.fn(),
}));

vi.mock("./http-utils.js", () => ({
  getBearerToken: vi.fn(),
  getHeader: vi.fn(),
  resolveHttpBrowserOriginPolicy: vi.fn(() => ({
    requestHost: "gateway.example.com",
    origin: "https://evil.example",
    allowedOrigins: ["https://control.example.com"],
    allowHostHeaderOriginFallback: false,
  })),
}));

const { authorizeHttpGatewayConnect } = await import("./auth.js");
const { sendGatewayAuthFailure } = await import("./http-common.js");
const { getBearerToken, getHeader, resolveHttpBrowserOriginPolicy } =
  await import("./http-utils.js");

describe("authorizeGatewayBearerRequestOrReply", () => {
  const bearerAuth = {
    mode: "token",
    token: "secret",
    password: undefined,
    allowTailscale: true,
  } satisfies ResolvedGatewayAuth;

  const makeAuthorizeParams = () => ({
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    auth: bearerAuth,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables tailscale header auth for HTTP bearer checks", async () => {
    (getBearerToken as Mock).mockReturnValue(undefined);
    (authorizeHttpGatewayConnect as Mock).mockResolvedValue({
      ok: false,
      reason: "token_missing",
    });

    const ok = await authorizeGatewayBearerRequestOrReply(makeAuthorizeParams());

    expect(ok).toBe(false);
    expect(authorizeHttpGatewayConnect as Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectAuth: null,
      }),
    );
    expect(sendGatewayAuthFailure as Mock).toHaveBeenCalledTimes(1);
  });

  it("forwards bearer token and returns true on successful auth", async () => {
    (getBearerToken as Mock).mockReturnValue("abc");
    (authorizeHttpGatewayConnect as Mock).mockResolvedValue({ ok: true, method: "token" });

    const ok = await authorizeGatewayBearerRequestOrReply(makeAuthorizeParams());

    expect(ok).toBe(true);
    expect(authorizeHttpGatewayConnect as Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectAuth: { token: "abc", password: "abc" },
      }),
    );
    expect(sendGatewayAuthFailure as Mock).not.toHaveBeenCalled();
  });

  it("forwards browser-origin policy into HTTP auth", async () => {
    const params = makeAuthorizeParams();
    (getBearerToken as Mock).mockReturnValue(undefined);
    (authorizeHttpGatewayConnect as Mock).mockResolvedValue({ ok: true, method: "trusted-proxy" });

    await authorizeGatewayBearerRequestOrReply(params);

    expect(resolveHttpBrowserOriginPolicy as Mock).toHaveBeenCalledWith(params.req);
    expect(authorizeHttpGatewayConnect as Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        browserOriginPolicy: {
          requestHost: "gateway.example.com",
          origin: "https://evil.example",
          allowedOrigins: ["https://control.example.com"],
          allowHostHeaderOriginFallback: false,
        },
      }),
    );
  });
});

describe("resolveGatewayRequestedOperatorScopes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns CLI_DEFAULT_OPERATOR_SCOPES when header is absent", () => {
    (getHeader as Mock).mockReturnValue(undefined);
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual(CLI_DEFAULT_OPERATOR_SCOPES);
    // Returned array must be a copy, not the original constant.
    expect(scopes).not.toBe(CLI_DEFAULT_OPERATOR_SCOPES);
  });

  it("returns empty array when header is present but empty", () => {
    (getHeader as Mock).mockReturnValue("");
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual([]);
  });

  it("returns empty array when header is present but only whitespace", () => {
    (getHeader as Mock).mockReturnValue("   ");
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual([]);
  });

  it("parses comma-separated scopes from header", () => {
    (getHeader as Mock).mockReturnValue("operator.write,operator.read");
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual(["operator.write", "operator.read"]);
  });

  it("trims whitespace around individual scopes", () => {
    (getHeader as Mock).mockReturnValue("  operator.write , operator.read  ");
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual(["operator.write", "operator.read"]);
  });

  it("filters out empty segments from trailing commas", () => {
    (getHeader as Mock).mockReturnValue("operator.write,,operator.read,");
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual(["operator.write", "operator.read"]);
  });

  it("returns single scope when only one is declared", () => {
    (getHeader as Mock).mockReturnValue("operator.approvals");
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual(["operator.approvals"]);
  });
});

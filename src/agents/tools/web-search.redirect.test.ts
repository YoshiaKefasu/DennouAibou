import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCitationRedirectUrl } from "./web-search-citation-redirect.js";

const withStrictWebToolsEndpointMock = vi.fn();

const deps = { withStrictWebToolsEndpoint: withStrictWebToolsEndpointMock };

describe("web_search redirect resolution hardening", () => {
  beforeEach(() => {
    withStrictWebToolsEndpointMock.mockReset();
  });

  it("resolves redirects via SSRF-guarded HEAD requests", async () => {
    withStrictWebToolsEndpointMock.mockImplementation(async (_params, run) => {
      return await run({
        response: new Response(null, { status: 200 }),
        finalUrl: "https://example.com/final",
      });
    });

    const resolved = await resolveCitationRedirectUrl("https://example.com/start", deps);
    expect(resolved).toBe("https://example.com/final");
    expect(withStrictWebToolsEndpointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/start",
        timeoutMs: 5000,
        init: { method: "HEAD" },
      }),
      expect.any(Function),
    );
  });

  it("falls back to the original URL when guarded resolution fails", async () => {
    withStrictWebToolsEndpointMock.mockRejectedValue(new Error("blocked"));
    await expect(resolveCitationRedirectUrl("https://example.com/start", deps)).resolves.toBe(
      "https://example.com/start",
    );
  });
});

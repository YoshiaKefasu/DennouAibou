import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveEffectiveToolPolicy } from "./pi-tools.policy.js";
import { resolveEffectiveToolFsRootExpansionAllowed } from "./tool-fs-policy.js";
import { pickToolPolicy } from "./tool-policy-pick.js";

describe("pickToolPolicy", () => {
  it("returns undefined when neither allow nor deny is configured", () => {
    expect(pickToolPolicy({})).toBeUndefined();
  });

  it("keeps alsoAllow without allow additive", () => {
    expect(
      pickToolPolicy({
        alsoAllow: ["web_search"],
      }),
    ).toEqual({
      allow: ["*", "web_search"],
      deny: undefined,
    });
  });

  it("merges allow and alsoAllow when both are present", () => {
    expect(
      pickToolPolicy({
        allow: ["read"],
        alsoAllow: ["write"],
      }),
    ).toEqual({
      allow: ["read", "write"],
      deny: undefined,
    });
  });

  it("preserves allow-all semantics for allow: [] plus alsoAllow", () => {
    expect(
      pickToolPolicy({
        allow: [],
        alsoAllow: ["web_search"],
      }),
    ).toEqual({
      allow: ["*", "web_search"],
      deny: undefined,
    });
  });

  it("passes deny through unchanged", () => {
    expect(
      pickToolPolicy({
        deny: ["exec"],
      }),
    ).toEqual({
      allow: undefined,
      deny: ["exec"],
    });
  });

  it("keeps global alsoAllow additive in effective tool policy resolution", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "coding",
        alsoAllow: ["lobster"],
      },
    };

    const resolved = resolveEffectiveToolPolicy({ config: cfg, agentId: "main" });
    expect(resolved.globalPolicy).toEqual({ allow: ["*", "lobster"], deny: undefined });
    expect(resolved.profileAlsoAllow).toEqual(["lobster"]);
  });

  it("does not block fs root expansion when only global alsoAllow is configured", () => {
    const cfg: OpenClawConfig = {
      tools: {
        alsoAllow: ["lobster"],
      },
    };

    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "main" })).toBe(true);
  });
});

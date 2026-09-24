import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { resolveExecDefaults } from "./exec-defaults.js";

describe("resolveExecDefaults", () => {
  it("does not advertise node routing when exec host is pinned to gateway", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "gateway",
            },
          },
        },
      }).canRequestNode,
    ).toBe(false);
  });

  it("keeps node routing available when exec host is auto", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "auto",
            },
          },
        },
      }),
    ).toMatchObject({
      host: "auto",
      effectiveHost: "gateway",
      canRequestNode: true,
    });
  });

  it("honors session-level exec host overrides", () => {
    const sessionEntry = {
      execHost: "node",
    } as SessionEntry;
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "gateway",
            },
          },
        },
        sessionEntry,
      }).canRequestNode,
    ).toBe(true);
  });
});

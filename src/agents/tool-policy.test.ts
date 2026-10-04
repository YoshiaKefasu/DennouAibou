import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "../security/dangerous-tools.js";
import { isToolAllowedByPolicyName, type ToolPolicy } from "./tool-policy-match.js";
import { TOOL_POLICY_CONFORMANCE } from "./tool-policy.conformance.js";
import {
  applyOwnerOnlyToolPolicy,
  collectExplicitAllowlist,
  expandToolGroups,
  isOwnerOnlyToolName,
  normalizeToolName,
  resolveOwnerOnlyToolApprovalClass,
  resolveToolProfilePolicy,
  TOOL_GROUPS,
} from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

function isToolAllowed(policy: ToolPolicy, name: string): boolean {
  return isToolAllowedByPolicyName(name, policy);
}

function createOwnerPolicyTools() {
  return [
    {
      name: "read",
      // oxlint-disable-next-line typescript/no-explicit-any
      execute: async () => ({ content: [], details: {} }) as any,
    },
    {
      name: "cron",
      ownerOnly: true,
      // oxlint-disable-next-line typescript/no-explicit-any
      execute: async () => ({ content: [], details: {} }) as any,
    },
    {
      name: "gateway",
      ownerOnly: true,
      // oxlint-disable-next-line typescript/no-explicit-any
      execute: async () => ({ content: [], details: {} }) as any,
    },
    {
      name: "whatsapp_login",
      // oxlint-disable-next-line typescript/no-explicit-any
      execute: async () => ({ content: [], details: {} }) as any,
    },
  ] as unknown as AnyAgentTool[];
}

describe("tool-policy", () => {
  it("expands groups and normalizes aliases", () => {
    const expanded = expandToolGroups(["group:runtime", "BASH", "apply-patch", "group:fs"]);
    const set = new Set(expanded);
    expect(set.has("exec")).toBe(true);
    expect(set.has("process")).toBe(true);
    expect(set.has("bash")).toBe(false);
    expect(set.has("apply_patch")).toBe(true);
    expect(set.has("read")).toBe(true);
    expect(set.has("write")).toBe(true);
    expect(set.has("edit")).toBe(true);
  });

  it("resolves known profiles and ignores unknown ones", () => {
    const coding = resolveToolProfilePolicy("coding");
    expect(coding?.allow).toContain("read");
    expect(coding?.allow).toContain("cron");
    expect(coding?.allow).not.toContain("gateway");
    expect(resolveToolProfilePolicy("nope")).toBeUndefined();
  });

  it("includes core tool groups in group:openclaw", () => {
    const group = TOOL_GROUPS["group:openclaw"];
    expect(group).toContain("browser");
    expect(group).toContain("message");
    expect(group).toContain("subagents");
    expect(group).toContain("session_status");
  });

  it("normalizes tool names and aliases", () => {
    expect(normalizeToolName(" BASH ")).toBe("exec");
    expect(normalizeToolName("apply-patch")).toBe("apply_patch");
    expect(normalizeToolName("READ")).toBe("read");
  });

  it("identifies owner-only tools", () => {
    expect(isOwnerOnlyToolName("whatsapp_login")).toBe(true);
    expect(isOwnerOnlyToolName("cron")).toBe(true);
    expect(isOwnerOnlyToolName("gateway")).toBe(true);
    expect(isOwnerOnlyToolName("nodes")).toBe(true);
    expect(isOwnerOnlyToolName("alarm")).toBe(false);
    expect(isOwnerOnlyToolName("read")).toBe(false);
  });

  it("exposes stable approval classes for shared owner-only fallbacks", () => {
    expect(resolveOwnerOnlyToolApprovalClass("whatsapp_login")).toBe("interactive");
    expect(resolveOwnerOnlyToolApprovalClass("cron")).toBe("control_plane");
    expect(resolveOwnerOnlyToolApprovalClass("gateway")).toBe("control_plane");
    expect(resolveOwnerOnlyToolApprovalClass("nodes")).toBe("exec_capable");
    expect(resolveOwnerOnlyToolApprovalClass("alarm")).toBeUndefined();
    expect(resolveOwnerOnlyToolApprovalClass("read")).toBeUndefined();
  });

  it("keeps ACP owner-only backstops aligned with the HTTP deny list", () => {
    const sharedBackstops = DEFAULT_GATEWAY_HTTP_TOOL_DENY.flatMap((name) => {
      const approvalClass = resolveOwnerOnlyToolApprovalClass(name);
      return approvalClass ? ([[name, approvalClass]] as const) : [];
    });

    expect(Object.fromEntries(sharedBackstops)).toEqual({
      cron: "control_plane",
      gateway: "control_plane",
      nodes: "exec_capable",
      whatsapp_login: "interactive",
    });
  });

  it("keeps alarm available for non-owner senders", async () => {
    const tools = [
      {
        name: "alarm",
        // oxlint-disable-next-line typescript/no-explicit-any
        execute: async () => ({ content: [], details: {} }) as any,
      },
    ] as unknown as AnyAgentTool[];
    expect(applyOwnerOnlyToolPolicy(tools, false).map((t) => t.name)).toEqual(["alarm"]);
    expect(applyOwnerOnlyToolPolicy(tools, true).map((t) => t.name)).toEqual(["alarm"]);
  });

  it("keeps all tools for non-owner senders (no owner hiding)", async () => {
    const tools = createOwnerPolicyTools();
    const filtered = applyOwnerOnlyToolPolicy(tools, false);
    expect(filtered.map((t) => t.name)).toEqual(["read", "cron", "gateway", "whatsapp_login"]);
  });

  it("keeps owner-only tools for the owner sender", async () => {
    const tools = createOwnerPolicyTools();
    const filtered = applyOwnerOnlyToolPolicy(tools, true);
    expect(filtered.map((t) => t.name)).toEqual(["read", "cron", "gateway", "whatsapp_login"]);
  });

  it("keeps all tools regardless of ownerOnly metadata", async () => {
    const tools = [
      {
        name: "custom_admin_tool",
        ownerOnly: true,
        // oxlint-disable-next-line typescript/no-explicit-any
        execute: async () => ({ content: [], details: {} }) as any,
      },
    ] as unknown as AnyAgentTool[];
    expect(applyOwnerOnlyToolPolicy(tools, false)).toHaveLength(1);
    expect(applyOwnerOnlyToolPolicy(tools, true)).toHaveLength(1);
  });

  it("preserves explicit alsoAllow hints when allow is empty", () => {
    expect(
      collectExplicitAllowlist([
        {
          allow: ["*", "optional-demo"],
        },
      ]),
    ).toContain("optional-demo");
  });

  it("keeps nodes for non-owner senders (no fallback hiding)", () => {
    const tools = [
      {
        name: "read",
        // oxlint-disable-next-line typescript/no-explicit-any
        execute: async () => ({ content: [], details: {} }) as any,
      },
      {
        name: "nodes",
        // oxlint-disable-next-line typescript/no-explicit-any
        execute: async () => ({ content: [], details: {} }) as any,
      },
    ] as unknown as AnyAgentTool[];

    expect(applyOwnerOnlyToolPolicy(tools, false).map((tool) => tool.name)).toEqual([
      "read",
      "nodes",
    ]);
    expect(applyOwnerOnlyToolPolicy(tools, true).map((tool) => tool.name)).toEqual([
      "read",
      "nodes",
    ]);
  });
});

describe("TOOL_POLICY_CONFORMANCE", () => {
  it("matches exported TOOL_GROUPS exactly", () => {
    expect(TOOL_POLICY_CONFORMANCE.toolGroups).toEqual(TOOL_GROUPS);
  });

  it("is JSON-serializable", () => {
    expect(() => JSON.stringify(TOOL_POLICY_CONFORMANCE)).not.toThrow();
  });
});

describe("tool policy matching", () => {
  it("allows all tools with * allow", () => {
    const policy: ToolPolicy = { allow: ["*"], deny: [] };
    expect(isToolAllowed(policy, "browser")).toBe(true);
  });

  it("denies all tools with * deny", () => {
    const policy: ToolPolicy = { allow: [], deny: ["*"] };
    expect(isToolAllowed(policy, "read")).toBe(false);
  });

  it("supports wildcard patterns", () => {
    const policy: ToolPolicy = { allow: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(true);
    expect(isToolAllowed(policy, "read")).toBe(false);
  });

  it("applies deny before allow", () => {
    const policy: ToolPolicy = { allow: ["*"], deny: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(false);
    expect(isToolAllowed(policy, "read")).toBe(true);
  });

  it("treats empty allowlist as allow-all (with deny exceptions)", () => {
    const policy: ToolPolicy = { allow: [], deny: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(false);
    expect(isToolAllowed(policy, "read")).toBe(true);
  });

  it("expands tool groups + aliases in patterns", () => {
    const policy: ToolPolicy = {
      allow: ["group:fs", "BASH"],
      deny: ["apply_*"],
    };
    expect(isToolAllowed(policy, "read")).toBe(true);
    expect(isToolAllowed(policy, "exec")).toBe(true);
    expect(isToolAllowed(policy, "apply_patch")).toBe(false);
  });

  it("normalizes whitespace + case", () => {
    const policy: ToolPolicy = { allow: [" WEB_* "] };
    expect(isToolAllowed(policy, "WEB_FETCH")).toBe(true);
  });
});

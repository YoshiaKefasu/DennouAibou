import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("agent defaults schema", () => {
  it("accepts subagent archiveAfterMinutes=0 to disable archiving", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        subagents: {
          archiveAfterMinutes: 0,
        },
      }),
    ).not.toThrow();
  });

  it("accepts videoGenerationModel", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        videoGenerationModel: {
          primary: "qwen/wan2.6-t2v",
          fallbacks: ["minimax/video-01"],
        },
      }),
    ).not.toThrow();
  });

  it('accepts thinkingDefault "max" as a canonical level', () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        thinkingDefault: "max",
      }),
    ).not.toThrow();
  });

  it("rejects unknown thinkingDefault values", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        thinkingDefault: "ultra",
      }),
    ).toThrow();
  });
});

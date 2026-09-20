import { describe, expect, it, vi } from "vitest";
import { maybeRepairAllowlistPolicyAllowFrom } from "./allowlist-policy-repair.js";

describe("doctor allowlist-policy repair", () => {
  it("restores matrix dm allowFrom from the pairing store into the nested path", async () => {
    const readChannelAllowFromStore = vi.fn().mockResolvedValue(["@alice:example.org"]);

    const result = await maybeRepairAllowlistPolicyAllowFrom(
      {
        channels: {
          matrix: {
            dm: {
              policy: "allowlist",
            },
          },
        },
      },
      {
        readChannelAllowFromStore,
        resolveAllowFromMode: () => "nestedOnly",
      },
    );

    expect(result.changes).toEqual([
      '- channels.matrix.dm.allowFrom: restored 1 sender entry from pairing store (dmPolicy="allowlist").',
    ]);
    expect(result.config.channels?.matrix?.dm?.allowFrom).toEqual(["@alice:example.org"]);
    expect(result.config.channels?.matrix?.allowFrom).toBeUndefined();
  });
});

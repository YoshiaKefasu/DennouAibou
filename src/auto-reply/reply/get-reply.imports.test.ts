import { describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.ts";

describe("get-reply module imports", () => {
  it("does not load reset-model runtime on module import", async () => {
    const resetModelRuntimeLoads = vi.fn();
    const inboundMediaRuntimeLoads = vi.fn();
    vi.doMock("./session-reset-model.runtime.js", async () => {
      resetModelRuntimeLoads();
      return await import("./session-reset-model.runtime.js");
    });
    vi.doMock("./stage-inbound-media.runtime.js", async () => {
      inboundMediaRuntimeLoads();
      return await import("./stage-inbound-media.runtime.js");
    });

    await importFreshModule<typeof import("./get-reply.js")>(
      import.meta.url,
      "./get-reply.js?scope=no-runtime-imports",
    );

    expect(resetModelRuntimeLoads).not.toHaveBeenCalled();
    expect(inboundMediaRuntimeLoads).not.toHaveBeenCalled();
    vi.doUnmock("./session-reset-model.runtime.js");
    vi.doUnmock("./stage-inbound-media.runtime.js");
  });
});

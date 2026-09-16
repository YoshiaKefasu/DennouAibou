import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseModelRef } from "./model-selection.js";

const normalizeProviderModelIdWithPluginMock = vi.fn();

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithPluginMock(params),
}));

describe("model-selection plugin runtime normalization", () => {
  beforeEach(() => {
    normalizeProviderModelIdWithPluginMock.mockReset();
  });

  it("delegates provider-owned model id normalization to plugin runtime hooks", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(({ provider, context }) => {
      if (
        provider === "custom-provider" &&
        (context as { modelId?: string }).modelId === "custom-legacy-model"
      ) {
        return "custom-modern-model";
      }
      return undefined;
    });

    expect(parseModelRef("custom-legacy-model", "custom-provider")).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledWith({
      provider: "custom-provider",
      context: {
        provider: "custom-provider",
        modelId: "custom-legacy-model",
      },
    });
  });
});

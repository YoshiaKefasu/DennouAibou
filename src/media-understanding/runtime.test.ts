import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MediaAttachment, MediaUnderstandingOutput } from "../media-understanding/types.js";
import { describeImageFile, runMediaUnderstandingFile } from "./runtime.js";
import type { MediaUnderstandingRuntimeDeps } from "./runtime.js";

const cleanup = vi.fn(async () => {});

const buildProviderRegistry = vi.fn(() => new Map());
const createMediaAttachmentCache = vi.fn(() => ({ cleanup }));
const normalizeMediaAttachments = vi.fn<() => MediaAttachment[]>(() => []);
const normalizeMediaProviderId = vi.fn((provider: string) => provider.trim().toLowerCase());
const runCapability = vi.fn(async () => ({ outputs: [] as MediaUnderstandingOutput[] }));

/** Explicit seams replacing the module-level vi.mock interception. */
const runtimeDeps: MediaUnderstandingRuntimeDeps = {
  buildProviderRegistry:
    buildProviderRegistry as unknown as MediaUnderstandingRuntimeDeps["buildProviderRegistry"],
  createMediaAttachmentCache:
    createMediaAttachmentCache as unknown as MediaUnderstandingRuntimeDeps["createMediaAttachmentCache"],
  normalizeMediaAttachments:
    normalizeMediaAttachments as unknown as MediaUnderstandingRuntimeDeps["normalizeMediaAttachments"],
  normalizeMediaProviderId:
    normalizeMediaProviderId as unknown as MediaUnderstandingRuntimeDeps["normalizeMediaProviderId"],
  runCapability: runCapability as unknown as MediaUnderstandingRuntimeDeps["runCapability"],
};

describe("media-understanding runtime", () => {
  // `mockClear` (not `mockReset`) keeps each mock's default implementation, so
  // the behavior does not depend on how a runner treats mockReset.
  afterEach(() => {
    buildProviderRegistry.mockClear();
    createMediaAttachmentCache.mockClear();
    normalizeMediaAttachments.mockClear();
    normalizeMediaProviderId.mockClear();
    runCapability.mockClear();
    cleanup.mockClear();
  });

  it("returns disabled state without loading providers", async () => {
    normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.jpg", mime: "image/jpeg" },
    ]);

    await expect(
      runMediaUnderstandingFile(
        {
          capability: "image",
          filePath: "/tmp/sample.jpg",
          mime: "image/jpeg",
          cfg: {
            tools: {
              media: {
                image: {
                  enabled: false,
                },
              },
            },
          } as OpenClawConfig,
          agentDir: "/tmp/agent",
        },
        runtimeDeps,
      ),
    ).resolves.toEqual({
      text: undefined,
      provider: undefined,
      model: undefined,
      output: undefined,
    });

    expect(buildProviderRegistry).not.toHaveBeenCalled();
    expect(runCapability).not.toHaveBeenCalled();
  });

  it("returns the matching capability output", async () => {
    const output: MediaUnderstandingOutput = {
      kind: "image.description",
      attachmentIndex: 0,
      provider: "vision-plugin",
      model: "vision-v1",
      text: "image ok",
    };
    normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.jpg", mime: "image/jpeg" },
    ]);
    runCapability.mockResolvedValue({
      outputs: [output],
    });

    await expect(
      describeImageFile(
        {
          filePath: "/tmp/sample.jpg",
          mime: "image/jpeg",
          cfg: {} as OpenClawConfig,
          agentDir: "/tmp/agent",
        },
        runtimeDeps,
      ),
    ).resolves.toEqual({
      text: "image ok",
      provider: "vision-plugin",
      model: "vision-v1",
      output,
    });

    expect(runCapability).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { loadModelCatalog, ModelCatalogEntry } from "../agents/model-catalog.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withMediaFixture } from "./runner.test-utils.js";

const baseCatalog: ModelCatalogEntry[] = [
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    input: ["text", "image"],
  },
];
let catalog = [...baseCatalog];

// Call-time seam for the model catalog (replaces the former module-level mocks).
const loadModelCatalogMock = vi.fn<typeof loadModelCatalog>(async () => catalog);

const catalogDeps = { loadModelCatalog: loadModelCatalogMock };

describe("runCapability image skip", () => {
  beforeEach(() => {
    catalog = [...baseCatalog];
    loadModelCatalogMock.mockClear();
    setActivePluginRegistry(createEmptyPluginRegistry());
    restoreTestEnvs();
  });

  it("skips image understanding when the active model supports vision", async () => {
    const ctx: MsgContext = { MediaPath: "/tmp/image.png", MediaType: "image/png" };
    const media = normalizeMediaAttachments(ctx);
    const cache = createMediaAttachmentCache(media);
    const cfg = {} as OpenClawConfig;

    try {
      const result = await runCapability({
        capability: "image",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry: buildProviderRegistry(),
        activeModel: { provider: "openai", model: "gpt-4.1" },
        deps: catalogDeps,
      });

      expect(result.outputs).toHaveLength(0);
      expect(result.decision.outcome).toBe("skipped");
      expect(result.decision.attachments).toHaveLength(1);
      expect(result.decision.attachments[0]?.attachmentIndex).toBe(0);
      expect(result.decision.attachments[0]?.attempts[0]?.outcome).toBe("skipped");
      expect(result.decision.attachments[0]?.attempts[0]?.reason).toBe(
        "primary model supports vision natively",
      );
    } finally {
      await cache.cleanup();
    }
  });

  it("skips configured image providers without an auto-resolvable model", async () => {
    await withMediaFixture(
      {
        filePrefix: "openclaw-image-custom-skip",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx, media, cache }) => {
        const cfg = {
          models: {
            providers: {
              "custom-image": {
                apiKey: "test-custom-key", // pragma: allowlist secret
                models: [],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "image",
          cfg,
          ctx,
          attachments: cache,
          media,
          agentDir: "/tmp",
          providerRegistry: new Map([
            [
              "custom-image",
              {
                id: "custom-image",
                capabilities: ["image"],
                describeImage: async () => ({ text: "custom ok" }),
              },
            ],
          ]),
          deps: catalogDeps,
        });

        expect(result.outputs).toHaveLength(0);
        expect(result.decision.outcome).toBe("skipped");
        expect(result.decision.attachments).toEqual([{ attachmentIndex: 0, attempts: [] }]);
      },
    );
  });
});

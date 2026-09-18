import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleControlUiHttpRequest, type ControlUiRuntimeDeps } from "./control-ui.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const resolveControlUiRootSyncMock = vi.fn();
const isPackageProvenControlUiRootSyncMock = vi.fn().mockReturnValue(true);

function createDeps(): ControlUiRuntimeDeps {
  return {
    resolveControlUiRootSync: resolveControlUiRootSyncMock as unknown as NonNullable<
      ControlUiRuntimeDeps["resolveControlUiRootSync"]
    >,
    isPackageProvenControlUiRootSync:
      isPackageProvenControlUiRootSyncMock as unknown as NonNullable<
        ControlUiRuntimeDeps["isPackageProvenControlUiRootSync"]
      >,
  };
}

function handle(url: string) {
  const { res, end } = makeMockHttpResponse();
  const handled = handleControlUiHttpRequest({ url, method: "GET" } as IncomingMessage, res, {
    deps: createDeps(),
  });
  return { handled, res, end };
}

async function withControlUiRoot<T>(fn: (tmp: string) => Promise<T>) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-auto-root-"));
  try {
    await fs.writeFile(path.join(tmp, "index.html"), "<html>fallback</html>\n");
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

afterEach(() => {
  resolveControlUiRootSyncMock.mockReset();
  isPackageProvenControlUiRootSyncMock.mockReset();
  isPackageProvenControlUiRootSyncMock.mockReturnValue(true);
});

describe("handleControlUiHttpRequest auto-detected root", () => {
  it("serves hardlinked asset files for bundled auto-detected roots", async () => {
    await withControlUiRoot(async (tmp) => {
      const assetsDir = path.join(tmp, "assets");
      await fs.mkdir(assetsDir, { recursive: true });
      await fs.writeFile(path.join(assetsDir, "app.js"), "console.log('hi');");
      await fs.link(path.join(assetsDir, "app.js"), path.join(assetsDir, "app.hl.js"));
      resolveControlUiRootSyncMock.mockReturnValue(tmp);

      const { handled, res, end } = handle("/assets/app.hl.js");

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("console.log('hi');");
    });
  });

  it("serves hardlinked SPA fallback index.html for bundled auto-detected roots", async () => {
    await withControlUiRoot(async (tmp) => {
      const sourceIndex = path.join(tmp, "index.source.html");
      const indexPath = path.join(tmp, "index.html");
      await fs.writeFile(sourceIndex, "<html>fallback-hardlink</html>\n");
      await fs.rm(indexPath);
      await fs.link(sourceIndex, indexPath);
      resolveControlUiRootSyncMock.mockReturnValue(tmp);

      const { handled, res, end } = handle("/dashboard");

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("<html>fallback-hardlink</html>\n");
    });
  });

  it("rejects hardlinked assets for non-package-proven auto-detected roots", async () => {
    isPackageProvenControlUiRootSyncMock.mockReturnValue(false);
    await withControlUiRoot(async (tmp) => {
      const assetsDir = path.join(tmp, "assets");
      await fs.mkdir(assetsDir, { recursive: true });
      await fs.writeFile(path.join(assetsDir, "app.js"), "console.log('hi');");
      await fs.link(path.join(assetsDir, "app.js"), path.join(assetsDir, "app.hl.js"));
      resolveControlUiRootSyncMock.mockReturnValue(tmp);

      const { handled, res } = handle("/assets/app.hl.js");

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });
  });
});

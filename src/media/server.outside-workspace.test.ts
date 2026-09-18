import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fetch as realFetch } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SafeOpenError } from "../infra/fs-safe.js";
import { withEnvAsync } from "../test-utils/env.js";
import { startMediaServer, type MediaServerRuntimeDeps } from "./server.js";

const readFileWithinRoot = vi.fn<NonNullable<MediaServerRuntimeDeps["readFileWithinRoot"]>>();
const cleanOldMedia = vi.fn(async () => {});

let mediaDir = "";

const deps: MediaServerRuntimeDeps = {
  readFileWithinRoot,
  getMediaDir: () => mediaDir,
  cleanOldMedia,
};

const LOOPBACK_FETCH_ENV = {
  HTTP_PROXY: undefined,
  HTTPS_PROXY: undefined,
  ALL_PROXY: undefined,
  http_proxy: undefined,
  https_proxy: undefined,
  all_proxy: undefined,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
} as const;

async function expectOutsideWorkspaceServerResponse(url: string) {
  const response = await withEnvAsync(LOOPBACK_FETCH_ENV, () => realFetch(url));
  expect(response.status).toBe(400);
  expect(await response.text()).toBe("file is outside workspace root");
}

describe("media server outside-workspace mapping", () => {
  let server: Awaited<ReturnType<typeof startMediaServer>> | undefined;
  let listenBlocked = false;
  let port = 0;

  beforeAll(async () => {
    mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-outside-workspace-"));
    try {
      server = await startMediaServer(0, 1_000, undefined, deps);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        listenBlocked = true;
        return;
      }
      throw error;
    }
    const boundServer = server;
    if (!boundServer) {
      return;
    }
    port = (boundServer.address() as AddressInfo).port;
  });

  beforeEach(() => {
    readFileWithinRoot.mockReset();
    cleanOldMedia.mockClear();
  });

  afterAll(async () => {
    const boundServer = server;
    if (boundServer) {
      await new Promise((resolve) => boundServer.close(resolve));
    }
    await fs.rm(mediaDir, { recursive: true, force: true });
    mediaDir = "";
  });

  it("returns 400 with a specific outside-workspace message", async () => {
    if (listenBlocked) {
      return;
    }
    readFileWithinRoot.mockRejectedValueOnce(
      new SafeOpenError("outside-workspace", "file is outside workspace root"),
    );

    await expectOutsideWorkspaceServerResponse(`http://127.0.0.1:${port}/media/ok-id`);
  });
});

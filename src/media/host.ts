import fs from "node:fs/promises";
import { formatCliCommand } from "../cli/command-format.js";
import { ensurePortAvailable, PortInUseError } from "../infra/ports.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import { logInfo } from "../logger.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { startMediaServer } from "./server.js";
import { saveMediaSource } from "./store.js";

const DEFAULT_PORT = 42873;
const TTL_MS = 2 * 60 * 1000;

let mediaServer: import("http").Server | null = null;

export type HostedMedia = {
  url: string;
  id: string;
  size: number;
};

/**
 * Injectable seams for the media-store, tailnet, port, server, and logger
 * boundaries. Tests supply fixtures instead of mocking `./store.js`,
 * `../infra/tailscale.js`, `../infra/ports.js`, `./server.js`, and
 * `../logger.js` at module level.
 */
export type MediaHostDeps = {
  saveMediaSource?: typeof saveMediaSource;
  getTailnetHostname?: typeof getTailnetHostname;
  ensurePortAvailable?: typeof ensurePortAvailable;
  startMediaServer?: typeof startMediaServer;
  logInfo?: typeof logInfo;
  removeFile?: (targetPath: string) => Promise<unknown>;
};

export async function ensureMediaHosted(
  source: string,
  opts: {
    port?: number;
    startServer?: boolean;
    runtime?: RuntimeEnv;
    deps?: MediaHostDeps;
  } = {},
): Promise<HostedMedia> {
  const port = opts.port ?? DEFAULT_PORT;
  const runtime = opts.runtime ?? defaultRuntime;
  const saveMediaSourceImpl = opts.deps?.saveMediaSource ?? saveMediaSource;
  const getTailnetHostnameImpl = opts.deps?.getTailnetHostname ?? getTailnetHostname;
  const ensurePortAvailableImpl = opts.deps?.ensurePortAvailable ?? ensurePortAvailable;
  const startMediaServerImpl = opts.deps?.startMediaServer ?? startMediaServer;
  const logInfoImpl = opts.deps?.logInfo ?? logInfo;
  const removeFile = opts.deps?.removeFile ?? ((targetPath: string) => fs.rm(targetPath));

  const saved = await saveMediaSourceImpl(source);
  const hostname = await getTailnetHostnameImpl();

  // Decide whether we must start a media server.
  const needsServerStart = await isPortFree(port, ensurePortAvailableImpl);
  if (needsServerStart && !opts.startServer) {
    await removeFile(saved.path).catch(() => {});
    throw new Error(
      `Media hosting requires the webhook/Funnel server. Start \`${formatCliCommand("openclaw webhook")}\`/\`${formatCliCommand("openclaw up")}\` or re-run with --serve-media.`,
    );
  }
  if (needsServerStart && opts.startServer) {
    if (!mediaServer) {
      mediaServer = await startMediaServerImpl(port, TTL_MS, runtime);
      logInfoImpl(
        `🦞 Started temporary media host on http://localhost:${port}/media/:id (TTL ${TTL_MS / 1000}s)`,
        runtime,
      );
      mediaServer.unref?.();
    }
  }

  const url = `https://${hostname}/media/${saved.id}`;
  return { url, id: saved.id, size: saved.size };
}

async function isPortFree(port: number, ensurePortAvailableImpl: typeof ensurePortAvailable) {
  try {
    await ensurePortAvailableImpl(port);
    return true;
  } catch (err) {
    if (err instanceof PortInUseError) {
      return false;
    }
    throw err;
  }
}

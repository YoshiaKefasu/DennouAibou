import fs from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInboundMediaContexts,
  createMediaStageConfig,
  withInboundMediaTempHome,
} from "./stage-inbound-media.test-harness.js";

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await import("node:child_process");
  return {
    ...actual,
    spawn: childProcessMocks.spawn,
  };
});

import { stageInboundMedia } from "./reply/stage-inbound-media.js";

afterEach(() => {
  vi.restoreAllMocks();
  childProcessMocks.spawn.mockClear();
});

function createRemoteStageParams(home: string): {
  cfg: ReturnType<typeof createMediaStageConfig>;
  workspaceDir: string;
  sessionKey: string;
  remoteCacheDir: string;
} {
  const sessionKey = "agent:main:main";
  return {
    cfg: createMediaStageConfig(home),
    workspaceDir: join(home, "openclaw"),
    sessionKey,
    remoteCacheDir: join(home, ".openclaw", "media", "remote-cache", sessionKey),
  };
}

function createRemoteContexts(remotePath: string) {
  const { ctx, sessionCtx } = createInboundMediaContexts(remotePath);
  ctx.Provider = "imessage";
  ctx.MediaRemoteHost = "user@gateway-host";
  sessionCtx.Provider = "imessage";
  sessionCtx.MediaRemoteHost = "user@gateway-host";
  return { ctx, sessionCtx };
}

describe("stageInboundMedia scp remote paths", () => {
  it("rejects remote attachment filenames with shell metacharacters before spawning scp", async () => {
    await withInboundMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir, sessionKey, remoteCacheDir } = createRemoteStageParams(home);
      const remotePath = "/Users/demo/Library/Messages/Attachments/ab/cd/evil$(touch pwned).jpg";
      const { ctx, sessionCtx } = createRemoteContexts(remotePath);

      await stageInboundMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey,
        workspaceDir,
      });

      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
      await expect(fs.stat(join(remoteCacheDir, basename(remotePath)))).rejects.toThrow();
      expect(ctx.MediaPath).toBe(remotePath);
      expect(sessionCtx.MediaPath).toBe(remotePath);
      expect(ctx.MediaUrl).toBe(remotePath);
      expect(sessionCtx.MediaUrl).toBe(remotePath);
    });
  });
});

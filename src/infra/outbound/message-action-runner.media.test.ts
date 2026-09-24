import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadWebMedia } from "../../media/web-media.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import {
  runMessageAction as runMessageActionWithoutMediaDeps,
  setMessageActionRunnerDepsForTest,
} from "./message-action-runner.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5m8gAAAABJRU5ErkJggg==",
  "base64",
);

const channelResolutionMocks = {
  resolveOutboundChannelPlugin: vi.fn(),
  executeSendAction: vi.fn(),
  executePollAction: vi.fn(),
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveOutboundSessionRoute: vi.fn(async () => null),
  resolveAndApplyOutboundThreadId: vi.fn(),
  prepareOutboundMirrorRoute: vi.fn(),
};

function resolveThreadId(
  actionParams: Record<string, unknown>,
  context: { resolveAutoThreadId?: (params: { replyToId?: string }) => string | undefined },
) {
  const explicit = typeof actionParams.threadId === "string" ? actionParams.threadId : undefined;
  const replyToId = typeof actionParams.replyTo === "string" ? actionParams.replyTo : undefined;
  const resolved = explicit ?? context.resolveAutoThreadId?.({ replyToId });
  if (resolved && !actionParams.threadId) actionParams.threadId = resolved;
  return resolved;
}

function prepareMirrorRoute(params: {
  actionParams: Record<string, unknown>;
  resolveAutoThreadId?: (params: { replyToId?: string }) => string | undefined;
  agentId?: string;
}) {
  const resolvedThreadId = resolveThreadId(params.actionParams, params);
  if (params.agentId) params.actionParams.__agentId = params.agentId;
  return { resolvedThreadId, outboundRoute: null };
}

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

const runDrySend = (params: { cfg: OpenClawConfig; actionParams: Record<string, unknown> }) =>
  runMessageAction({
    cfg: params.cfg,
    action: "send",
    params: params.actionParams as never,
    dryRun: true,
  });

const loadWebMediaMock = vi.fn(loadWebMedia);
const runMessageAction = (params: Parameters<typeof runMessageActionWithoutMediaDeps>[0]) =>
  runMessageActionWithoutMediaDeps({
    ...params,
    deps: {
      ...params.deps,
      loadWebMedia: loadWebMediaMock,
    },
  });

const slackPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "slack",
    label: "Slack",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (cfg) => cfg.channels?.slack ?? {},
      isConfigured: async (account) =>
        typeof (account as { botToken?: unknown }).botToken === "string" &&
        (account as { botToken?: string }).botToken!.trim() !== "" &&
        typeof (account as { appToken?: unknown }).appToken === "string" &&
        (account as { appToken?: string }).appToken!.trim() !== "",
    },
  }),
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("missing target for slack"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async () => ({ channel: "slack", messageId: "msg-test" }),
    sendMedia: async () => ({ channel: "slack", messageId: "msg-test" }),
  },
};

describe("runMessageAction media behavior", () => {
  beforeEach(async () => {
    setMessageActionRunnerDepsForTest({
      resolveOutboundChannelPlugin: channelResolutionMocks.resolveOutboundChannelPlugin,
      executeSendAction: channelResolutionMocks.executeSendAction,
      executePollAction: channelResolutionMocks.executePollAction,
      ensureOutboundSessionEntry: channelResolutionMocks.ensureOutboundSessionEntry,
      resolveOutboundSessionRoute: channelResolutionMocks.resolveOutboundSessionRoute,
      resolveAndApplyOutboundThreadId: channelResolutionMocks.resolveAndApplyOutboundThreadId,
      prepareOutboundMirrorRoute: channelResolutionMocks.prepareOutboundMirrorRoute,
    });
    channelResolutionMocks.resolveAndApplyOutboundThreadId.mockImplementation(resolveThreadId);
    channelResolutionMocks.prepareOutboundMirrorRoute.mockImplementation(prepareMirrorRoute);
    vi.restoreAllMocks();
    vi.clearAllMocks();
    channelResolutionMocks.resolveOutboundChannelPlugin.mockReset();
    channelResolutionMocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel }: { channel: string }) =>
        getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
    );
    channelResolutionMocks.executeSendAction.mockReset();
    channelResolutionMocks.executeSendAction.mockImplementation(
      async ({
        ctx,
        to,
        message,
        mediaUrl,
        mediaUrls,
      }: {
        ctx: { channel: string; dryRun: boolean };
        to: string;
        message: string;
        mediaUrl?: string;
        mediaUrls?: string[];
      }) => ({
        handledBy: "core" as const,
        payload: {
          channel: ctx.channel,
          to,
          message,
          mediaUrl,
          mediaUrls,
          dryRun: ctx.dryRun,
        },
        sendResult: {
          channel: ctx.channel,
          messageId: "msg-test",
          ...(mediaUrl ? { mediaUrl } : {}),
          ...(mediaUrls ? { mediaUrls } : {}),
        },
      }),
    );
    channelResolutionMocks.executePollAction.mockReset();
    channelResolutionMocks.executePollAction.mockImplementation(async () => {
      throw new Error("executePollAction should not run in media tests");
    });
    loadWebMediaMock.mockReset();
    loadWebMediaMock.mockImplementation(loadWebMedia);
  });

  afterEach(() => {
    setMessageActionRunnerDepsForTest();
  });

  describe("sendAttachment hydration", () => {
    const cfg = {
      channels: {
        bluebubbles: {
          enabled: true,
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
      },
    } as OpenClawConfig;
    const attachmentPlugin: ChannelPlugin = {
      id: "bluebubbles",
      meta: {
        id: "bluebubbles",
        label: "BlueBubbles",
        selectionLabel: "BlueBubbles",
        docsPath: "/channels/bluebubbles",
        blurb: "BlueBubbles test plugin.",
      },
      capabilities: { chatTypes: ["direct", "group"], media: true },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["sendAttachment", "upload-file", "setGroupIcon"] }),
        supportsAction: ({ action }) =>
          action === "sendAttachment" || action === "upload-file" || action === "setGroupIcon",
        handleAction: async ({ params }) =>
          jsonResult({
            ok: true,
            buffer: params.buffer,
            filename: params.filename,
            caption: params.caption,
            contentType: params.contentType,
          }),
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "bluebubbles",
            source: "test",
            plugin: attachmentPlugin,
          },
        ]),
      );
      loadWebMediaMock.mockResolvedValue({
        buffer: Buffer.from("hello"),
        contentType: "image/png",
        kind: "image",
        fileName: "pic.png",
      });
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    async function restoreRealMediaLoader() {
      loadWebMediaMock.mockImplementation(loadWebMedia);
    }

    async function expectRejectsLocalAbsolutePath(params: {
      cfg?: OpenClawConfig;
      action: "sendAttachment" | "setGroupIcon";
      target: string;
      mediaField?: "media" | "mediaUrl" | "fileUrl";
      message?: string;
      tempPrefix: string;
    }) {
      await restoreRealMediaLoader();

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), params.tempPrefix));
      try {
        const outsidePath = path.join(tempDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");

        const actionParams: Record<string, unknown> = {
          channel: "bluebubbles",
          target: params.target,
          [params.mediaField ?? "media"]: outsidePath,
        };
        if (params.message) {
          actionParams.message = params.message;
        }

        await expect(
          runMessageAction({
            cfg: params.cfg ?? cfg,
            action: params.action,
            params: actionParams,
          }),
        ).rejects.toThrow(/allowed directory|path-not-allowed/i);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }

    it("hydrates buffer and filename from media for sendAttachment", async () => {
      const result = await runMessageAction({
        cfg,
        action: "sendAttachment",
        params: {
          channel: "bluebubbles",
          target: "+15551234567",
          media: "https://example.com/pic.png",
          message: "caption",
        },
      });

      expect(result.kind).toBe("action");
      expect(result.payload).toMatchObject({
        ok: true,
        filename: "pic.png",
        caption: "caption",
        contentType: "image/png",
      });
      expect((result.payload as { buffer?: string }).buffer).toBe(
        Buffer.from("hello").toString("base64"),
      );
      const call = loadWebMediaMock.mock.calls[0];
      expect(call?.[1]).toEqual(
        expect.objectContaining({
          localRoots: "any",
          readFile: expect.any(Function),
          hostReadCapability: true,
        }),
      );
    });

    it("allows host-local image attachment paths when fs root expansion is enabled", async () => {
      await restoreRealMediaLoader();

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-attachment-image-"));
      try {
        const outsidePath = path.join(tempDir, "photo.png");
        await fs.writeFile(outsidePath, onePixelPng);

        const result = await runMessageAction({
          cfg: {
            ...cfg,
            tools: { fs: { workspaceOnly: false } },
          },
          action: "sendAttachment",
          params: {
            channel: "bluebubbles",
            target: "+15551234567",
            media: outsidePath,
            message: "caption",
          },
        });

        expect(result.kind).toBe("action");
        expect(result.payload).toMatchObject({
          ok: true,
          filename: "photo.png",
          contentType: "image/png",
        });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects host-local text attachments even when fs root expansion is enabled", async () => {
      await restoreRealMediaLoader();

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-attachment-text-"));
      try {
        const outsidePath = path.join(tempDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");

        await expect(
          runMessageAction({
            cfg: {
              ...cfg,
              tools: { fs: { workspaceOnly: false } },
            },
            action: "sendAttachment",
            params: {
              channel: "bluebubbles",
              target: "+15551234567",
              media: outsidePath,
              message: "caption",
            },
          }),
        ).rejects.toThrow(/Host-local media sends only allow/i);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("hydrates buffer and filename from media for bluebubbles upload-file", async () => {
      const result = await runMessageAction({
        cfg,
        action: "upload-file",
        params: {
          channel: "bluebubbles",
          target: "+15551234567",
          media: "https://example.com/pic.png",
          message: "caption",
        },
      });

      expect(result.kind).toBe("action");
      expect(result.payload).toMatchObject({
        ok: true,
        filename: "pic.png",
        caption: "caption",
        contentType: "image/png",
      });
      expect((result.payload as { buffer?: string }).buffer).toBe(
        Buffer.from("hello").toString("base64"),
      );
    });
  });

  describe("media param validation", () => {
    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "slack",
            source: "test",
            plugin: slackPlugin,
          },
        ]),
      );
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
    });

    it("rejects data URLs in media params", async () => {
      await expect(
        runDrySend({
          cfg: slackConfig,
          actionParams: {
            channel: "slack",
            target: "#C12345678",
            media: "data:image/png;base64,abcd",
            message: "",
          },
        }),
      ).rejects.toThrow(/data:/i);
    });
  });
});

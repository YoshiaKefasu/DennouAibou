import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  hydrateAttachmentParamsForAction,
  normalizeMediaList,
  normalizeAttachmentMediaParams,
} from "./message-action-params.js";

const cfg = {} as OpenClawConfig;
const maybeIt = process.platform === "win32" ? it.skip : it;

describe("message action media helpers", () => {
  it("uses mediaUrl and fileUrl aliases when inferring attachment filenames", async () => {
    const mediaArgs: Record<string, unknown> = {
      mediaUrl: "https://example.com/pic.png",
    };
    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "slack",
      args: mediaArgs,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: {},
    });
    expect(mediaArgs.filename).toBe("pic.png");

    const fileArgs: Record<string, unknown> = {
      fileUrl: "https://example.com/docs/report.pdf",
    };
    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "slack",
      args: fileArgs,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: {},
    });
    expect(fileArgs.filename).toBe("report.pdf");
  });

  it("falls back to extension-based attachment names for remote-host file URLs", async () => {
    const args: Record<string, unknown> = {
      media: "file://attacker/share/photo.png",
    };

    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "slack",
      args,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: {},
    });

    expect(args.filename).toBe("attachment");
  });
});

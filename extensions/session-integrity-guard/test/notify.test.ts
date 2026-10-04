import { describe, expect, it } from "vitest";
import {
  buildNotifyDelivery,
  formatNotifyMessage,
  resolveNotifyConfig,
  type NotifyConfig,
} from "../src/notify.js";

describe("resolveNotifyConfig", () => {
  it("defaults to disabled discord", () => {
    expect(resolveNotifyConfig(undefined)).toEqual({ enabled: false, channel: "discord" });
  });

  it("accepts telegram with optional to/accountId/bestEffort", () => {
    expect(
      resolveNotifyConfig({
        enabled: true,
        channel: "telegram",
        to: "-100123",
        accountId: "ops-bot",
        bestEffort: true,
      }),
    ).toEqual({
      enabled: true,
      channel: "telegram",
      to: "-100123",
      accountId: "ops-bot",
      bestEffort: true,
    });
  });
});

describe("buildNotifyDelivery", () => {
  it("returns mode: 'none' when notify is disabled", () => {
    const cfg: NotifyConfig = { enabled: false, channel: "discord" };
    expect(buildNotifyDelivery(cfg)).toEqual({ mode: "none" });
  });

  it("returns mode: 'announce' with channel/target/accountId when enabled", () => {
    const cfg: NotifyConfig = {
      enabled: true,
      channel: "telegram",
      to: "19098680",
      accountId: "ops-bot",
      bestEffort: true,
    };
    expect(buildNotifyDelivery(cfg)).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "19098680",
      accountId: "ops-bot",
      bestEffort: true,
    });
  });
});

describe("formatNotifyMessage", () => {
  it("includes scanned/failures/auto-repair header and per-file lines", () => {
    const text = formatNotifyMessage({
      scanned: 5,
      failures: 2,
      autoRepair: true,
      files: [
        {
          file: "/var/sessions/a.jsonl",
          orphanCount: 3,
          removedCount: 3,
          backupPath: "/var/sessions/a.jsonl.bak.20260904-120000",
          status: "repaired",
        },
      ],
    });
    expect(text).toContain("session-integrity-guard");
    expect(text).toContain("scanned: 5");
    expect(text).toContain("failures: 2");
    expect(text).toContain("auto-repair: ON");
    expect(text).toContain("a.jsonl");
    expect(text).toContain("orphans=3");
    expect(text).toContain("repair: -3");
    expect(text).toContain(".bak.20260904-120000");
  });
});

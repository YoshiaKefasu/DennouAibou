/**
 * Notification primitives for the session integrity guard (Phase 3).
 *
 * Design contract (DENNOU_DOCS/SESSION_INTEGRITY_GUARD.md §4.4):
 *   - Discord / Telegram announce cron job is separate from the daily check
 *     cron so that the channel routing / announcement payload can be patched
 *     without disturbing the existing Phase 2 cron job.
 *   - The delivery config uses the SDK `delivery: { mode: "announce", ... }`
 *     shape (mirror: `extensions/memory-core/src/dreaming.ts` notify paths).
 *   - `mode: "announce"` requires at least `channel: "discord" | "telegram"`.
 *     `to` / `accountId` / `bestEffort` are optional.
 *   - The notification text is built from a `RepairSummary` so it can be
 *     surfaced to either the announce cron or a future log-only fallback.
 */

export type NotifyChannel = "discord" | "telegram";

export interface NotifyConfig {
  enabled: boolean;
  channel: NotifyChannel;
  /** Per-channel target (chat id, channel id, room name). */
  to?: string;
  /** Account id used by the channel bot. */
  accountId?: string;
  /** Mark the announce delivery as best-effort (no retry). */
  bestEffort?: boolean;
}

export type NotifyDelivery =
  | { mode: "none" }
  | {
      mode: "announce";
      channel: NotifyChannel;
      to?: string;
      accountId?: string;
      bestEffort?: boolean;
    };

/**
 * Resolve the notify config from raw plugin config. The default is `enabled:
 * false` (Phase 3 ships behind a config flag; auto-on would surprise existing
 * deployments).
 */
export function resolveNotifyConfig(raw: unknown): NotifyConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { enabled: false, channel: "discord" };
  }
  const record = raw as Record<string, unknown>;
  const enabled = record.enabled === true;
  const channelRaw = typeof record.channel === "string" ? record.channel.toLowerCase() : "discord";
  const channel: NotifyChannel = channelRaw === "telegram" ? "telegram" : "discord";
  const to =
    typeof record.to === "string" && record.to.trim().length > 0 ? record.to.trim() : undefined;
  const accountId =
    typeof record.accountId === "string" && record.accountId.trim().length > 0
      ? record.accountId.trim()
      : undefined;
  const bestEffort = record.bestEffort === true;
  const config: NotifyConfig = { enabled, channel };
  if (to) {
    config.to = to;
  }
  if (accountId) {
    config.accountId = accountId;
  }
  if (bestEffort) {
    config.bestEffort = true;
  }
  return config;
}

/**
 * Convert a resolved notify config into a cron-job `delivery` patch.
 *
 * When the notify config is disabled, returns `{ mode: "none" }` so the
 * announce cron stays in the store but produces no outbound traffic.
 */
export function buildNotifyDelivery(config: NotifyConfig): NotifyDelivery {
  if (!config.enabled) {
    return { mode: "none" };
  }
  const delivery: Extract<NotifyDelivery, { mode: "announce" }> = {
    mode: "announce",
    channel: config.channel,
  };
  if (config.to) {
    delivery.to = config.to;
  }
  if (config.accountId) {
    delivery.accountId = config.accountId;
  }
  if (config.bestEffort === true) {
    delivery.bestEffort = true;
  }
  return delivery;
}

export interface NotifyFileSummary {
  file: string;
  orphanCount: number;
  removedCount: number | null;
  backupPath: string | null;
  status: string;
}

export interface NotifyPayload {
  scanned: number;
  failures: number;
  autoRepair: boolean;
  files: NotifyFileSummary[];
}

/**
 * Render the notification text. Mirrors the format from the design doc §4.4.
 *
 * Note: We always emit a plain-text representation so Discord / Telegram both
 * render it without markdown surprises. Channel prefixes (`<#…>` for Discord,
 * plain ids for Telegram) are intentionally omitted — `accountId` already
 * disambiguates the bot.
 */
export function formatNotifyMessage(payload: NotifyPayload): string {
  const lines: string[] = [];
  lines.push("⚠️ [session-integrity-guard] 異常検知");
  lines.push(
    `- scanned: ${payload.scanned} 件 / failures: ${payload.failures} 件 / auto-repair: ${payload.autoRepair ? "ON" : "OFF"}`,
  );
  if (payload.files.length === 0) {
    lines.push("- 該当セッションなし");
    return lines.join("\n");
  }
  for (const file of payload.files) {
    const basename = file.file.split(/[\\/]/u).pop() ?? file.file;
    const removedFragment =
      file.removedCount === null ? "repair: pending" : `repair: -${file.removedCount}`;
    const backupFragment = file.backupPath ? `backup: ${file.backupPath}` : "backup: n/a";
    lines.push(
      `- ${basename}: orphans=${file.orphanCount} / ${removedFragment} / ${backupFragment} / status=${file.status}`,
    );
  }
  return lines.join("\n");
}

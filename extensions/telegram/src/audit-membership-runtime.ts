import { isRecord, fetchWithTimeout } from "openclaw/plugin-sdk/text-runtime";
import type {
  AuditTelegramGroupMembershipParams,
  TelegramGroupMembershipAudit,
  TelegramGroupMembershipAuditEntry,
  TelegramGroupMembershipAuditDeps,
} from "./audit.js";
import { resolveTelegramApiBase, resolveTelegramFetch } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";

type TelegramApiOk<T> = { ok: true; result: T };
type TelegramApiErr = { ok: false; description?: string };
type TelegramGroupMembershipAuditData = Omit<TelegramGroupMembershipAudit, "elapsedMs">;
type TelegramChatMemberResult = { status?: string };

export async function auditTelegramGroupMembershipImpl(
  params: AuditTelegramGroupMembershipParams,
  deps: TelegramGroupMembershipAuditDeps = {},
): Promise<TelegramGroupMembershipAuditData> {
  const fetchWithTimeoutImpl = deps.fetchWithTimeout ?? fetchWithTimeout;
  const isRecordImpl = deps.isRecord ?? isRecord;
  const resolveTelegramFetchImpl = deps.resolveTelegramFetch ?? resolveTelegramFetch;
  const resolveTelegramApiBaseImpl = deps.resolveTelegramApiBase ?? resolveTelegramApiBase;
  const proxyFetch = params.proxyUrl ? makeProxyFetch(params.proxyUrl) : undefined;
  const fetcher = resolveTelegramFetchImpl(proxyFetch, {
    network: params.network,
  });
  const apiBase = resolveTelegramApiBaseImpl(params.apiRoot);
  const base = `${apiBase}/bot${params.token}`;
  const groups: TelegramGroupMembershipAuditEntry[] = [];

  for (const chatId of params.groupIds) {
    try {
      const url = `${base}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(String(params.botId))}`;
      const res = await fetchWithTimeoutImpl(url, {}, params.timeoutMs, fetcher);
      const json = (await res.json()) as TelegramApiOk<TelegramChatMemberResult> | TelegramApiErr;
      if (!res.ok || !isRecordImpl(json) || !json.ok) {
        const desc =
          isRecordImpl(json) && !json.ok && typeof json.description === "string"
            ? json.description
            : `getChatMember failed (${res.status})`;
        groups.push({
          chatId,
          ok: false,
          status: null,
          error: desc,
          matchKey: chatId,
          matchSource: "id",
        });
        continue;
      }
      const status =
        isRecordImpl(json.result) && typeof json.result.status === "string"
          ? json.result.status
          : null;
      const ok = status === "creator" || status === "administrator" || status === "member";
      groups.push({
        chatId,
        ok,
        status,
        error: ok ? null : "bot not in group",
        matchKey: chatId,
        matchSource: "id",
      });
    } catch (err) {
      groups.push({
        chatId,
        ok: false,
        status: null,
        error: err instanceof Error ? err.message : String(err),
        matchKey: chatId,
        matchSource: "id",
      });
    }
  }

  return {
    ok: groups.every((g) => g.ok),
    checkedGroups: groups.length,
    unresolvedGroups: 0,
    hasWildcardUnmentionedGroups: false,
    groups,
  };
}

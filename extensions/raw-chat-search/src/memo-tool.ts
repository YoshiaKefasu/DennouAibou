import { Type } from "typebox";
import { stringEnum } from "../../../src/agents/schema/typebox.js";
import { textResult, ToolInputError } from "../../../src/agents/tools/common.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { readSnakeCaseParamRaw } from "../../../src/param-key.js";
import { getRawChatDatabase, type RawChatDatabase } from "./database.js";
import {
  DEFAULT_MEMO_TTL_DAYS,
  archiveMemo,
  getActiveMemosForPrompt,
  normalizeMemoCategory,
  readMemos,
  removeMemo,
  updateMemo,
  validateMemoDays,
  writeMemo,
  MEMO_CONTENT_MAX_LENGTH,
} from "./memo-db.js";
import type { AnyAgentTool } from "./runtime-core.local.js";
import { readNumberParam, readStringParam, resolveSessionAgentId } from "./runtime-core.local.js";

export const MEMO_ACTIONS = ["write", "read", "update", "archive", "remove"] as const;
export type MemoAction = (typeof MEMO_ACTIONS)[number];

export const MEMO_TOOL_DESCRIPTION = [
  "重要な能動記憶・約束・メモを管理するツールです。",
  "",
  "⚠️ 【最重要ルール】:",
  "デフォルトでは 3 日間（72時間）で自動的に消去（期限切れ）されます！",
  "ユーザーとの重要な約束、プロジェクトの恒久的な掟、忘れてはならない個人情報を記録する場合は、",
  "必ず `forever: true`（無限保持）を指定するか、長めの日数（例: days: 30）を指定してください。",
  "",
  '- action="write": メモを記録する（category, content 必須。1件最大2,000文字。重要なら forever: true）。',
  '- action="read": 有効なメモを一覧表示または検索する（query や category で絞り込み可能）。',
  '- action="update": 既存メモの内容・期限・カテゴリを更新する（id 必須）。days 指定時は更新日時を起点に再計算。',
  "- action=\"archive\": メモをアーカイブする（id 必須。status='archived' へ。read の includeArchived=true で再表示できる）。",
  "- action=\"remove\": メモを削除する（id 必須。status='dismissed' へ論理削除。再表示されない）。",
].join("\n");

export const MemoToolSchema = Type.Object({
  action: stringEnum(["write", "read", "update", "archive", "remove"], {
    description:
      "操作: write=新規記録, read=一覧/検索, update=更新, archive=アーカイブ, remove=削除",
  }),
  category: Type.Optional(
    stringEnum(["User", "Project", "AgentHabits", "etc"], {
      description:
        "カテゴリ: User(ユーザー情報), Project(仕様/ルール), AgentHabits(自身の習慣/口調), etc(その他)",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description: "メモ本文（最大2,000文字）。write/update で必須。",
    }),
  ),
  id: Type.Optional(
    Type.Number({
      description: "操作対象のメモID。update/archive/remove で必須。",
    }),
  ),
  days: Type.Optional(
    Type.Number({
      description:
        "覚えている期間（日数、正の整数）。デフォルトは 3 日間。forever=true の場合は無視されます。",
    }),
  ),
  forever: Type.Optional(
    Type.Boolean({
      description: "無限に覚えたい場合は true。デフォルトは false（3日間で自動消去）。",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: "read 時のキーワード検索・絞り込み文字列（部分一致）。",
    }),
  ),
  includeArchived: Type.Optional(
    Type.Boolean({
      description: "read 時に期限切れ/アーカイブされたメモも含めるか（デフォルト false）。",
    }),
  ),
});

function readBooleanParam(params: unknown, key: string): boolean | undefined {
  const raw = readSnakeCaseParamRaw(params, key);
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const lowered = raw.trim().toLowerCase();
    if (lowered === "true" || lowered === "1") {
      return true;
    }
    if (lowered === "false" || lowered === "0") {
      return false;
    }
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw !== 0;
  }
  throw new ToolInputError(`${key} must be a boolean`);
}

function readMemoId(params: unknown): number {
  const id = readNumberParam(params, "id", { integer: true });
  if (id === undefined || !Number.isInteger(id) || id <= 0) {
    throw new ToolInputError("id required: update/archive/remove needs a memo id");
  }
  return id;
}

export function createMemoTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  db?: RawChatDatabase;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "Memo",
    name: "memo",
    description: MEMO_TOOL_DESCRIPTION,
    parameters: MemoToolSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });
      if (!MEMO_ACTIONS.includes(action as MemoAction)) {
        throw new ToolInputError(
          `invalid action "${action}": expected one of write, read, update, archive, remove`,
        );
      }

      const db = options.db ?? getRawChatDatabase(agentId);

      switch (action as MemoAction) {
        case "write": {
          try {
            const rawCategory = readStringParam(params, "category");
            const category = normalizeMemoCategory(rawCategory);
            if (!category) {
              throw new ToolInputError(
                "category required: expected one of User, Project, AgentHabits, etc",
              );
            }
            const content = readStringParam(params, "content", { allowEmpty: true });
            if (!content) {
              throw new ToolInputError("content required");
            }
            if (content.length > MEMO_CONTENT_MAX_LENGTH) {
              throw new ToolInputError(
                `content exceeds maximum length of ${MEMO_CONTENT_MAX_LENGTH.toLocaleString("en-US")} characters`,
              );
            }
            const rawDays = readNumberParam(params, "days");
            const days = rawDays === undefined ? DEFAULT_MEMO_TTL_DAYS : validateMemoDays(rawDays);
            const forever = readBooleanParam(params, "forever") ?? false;
            const memo = writeMemo(db, { category, content, days, forever });
            return textResult(JSON.stringify(memo, null, 2), undefined);
          } catch (error) {
            throw new ToolInputError(error instanceof Error ? error.message : String(error));
          }
        }
        case "read": {
          const query = readStringParam(params, "query") ?? undefined;
          const rawCategory = readStringParam(params, "category");
          if (rawCategory !== undefined && !normalizeMemoCategory(rawCategory)) {
            throw new ToolInputError(
              "invalid category: expected one of User, Project, AgentHabits, etc",
            );
          }
          const includeArchived = readBooleanParam(params, "includeArchived") ?? false;
          const memos = readMemos(db, {
            ...(query ? { query } : {}),
            ...(rawCategory ? { category: rawCategory } : {}),
            includeArchived,
          });
          return textResult(JSON.stringify({ memos, count: memos.length }, null, 2), undefined);
        }
        case "update": {
          try {
            const id = readMemoId(params);
            const rawCategory = readStringParam(params, "category");
            if (rawCategory !== undefined && !normalizeMemoCategory(rawCategory)) {
              throw new ToolInputError(
                "invalid category: expected one of User, Project, AgentHabits, etc",
              );
            }
            const content = readStringParam(params, "content", { allowEmpty: true });
            if (content !== undefined && content.length > MEMO_CONTENT_MAX_LENGTH) {
              throw new ToolInputError(
                `content exceeds maximum length of ${MEMO_CONTENT_MAX_LENGTH.toLocaleString("en-US")} characters`,
              );
            }
            const rawDays = readNumberParam(params, "days");
            if (rawDays !== undefined) {
              validateMemoDays(rawDays);
            }
            const forever = readBooleanParam(params, "forever");
            const memo = updateMemo(db, id, {
              ...(rawCategory !== undefined ? { category: rawCategory } : {}),
              ...(content !== undefined ? { content } : {}),
              ...(rawDays !== undefined ? { days: Math.floor(rawDays) } : {}),
              ...(forever !== undefined ? { forever } : {}),
            });
            return textResult(JSON.stringify(memo, null, 2), undefined);
          } catch (error) {
            throw new ToolInputError(error instanceof Error ? error.message : String(error));
          }
        }
        case "archive": {
          const id = readMemoId(params);
          try {
            const archived = archiveMemo(db, id);
            if (!archived) {
              const row = db.getRawDb().prepare("SELECT status FROM memos WHERE id = ?").get(id) as
                | { status: string }
                | undefined;
              if (!row) {
                throw new Error(`memo #${id} not found`);
              }
              throw new Error(`memo #${id} is already ${row.status}`);
            }
            return textResult(JSON.stringify({ archived: id }, null, 2), undefined);
          } catch (error) {
            throw new ToolInputError(error instanceof Error ? error.message : String(error));
          }
        }
        case "remove": {
          const id = readMemoId(params);
          try {
            const removed = removeMemo(db, id);
            if (!removed) {
              throw new Error(`memo #${id} not found`);
            }
            return textResult(JSON.stringify({ removed: id }, null, 2), undefined);
          } catch (error) {
            throw new ToolInputError(error instanceof Error ? error.message : String(error));
          }
        }
        default: {
          throw new ToolInputError(
            `invalid action "${action}": expected one of write, read, update, archive, remove`,
          );
        }
      }
    },
  };
}

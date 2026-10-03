# 電脳神経 memo ＆ Dream 設計書 (DENNOU_SHINKEI_MEMO.md)

## 1. 背景と目的

現在、電脳神経（`extensions/raw-chat-search`）は過去の全会話ログをベクトル化し、関連する記憶を想起する「受動的長期記憶（`rawchatdb`）」を提供している。
これに加え、Kasou（AI）が能動的に「ユーザーとの約束」「プロジェクトの掟」「自分自身の行動習慣」を記憶・管理し、常に意識しながら対話できるようにする「常時能動記憶（`memo`）」および「自律整理機能（`dream`）」を電脳神経傘下に統合新設する。

人間の自然な記憶・忘却リズムをモデル化し：

- **短期の約束や予定は数日（デフォルト3日）で自然に忘れる（消える）**
- **重要なルールや絶対の掟は明示的に「無限（forever）」に固定して永遠に忘れない**
- **有効なメモは常に頭の中（プロンプト枠、デフォルト4,000トークン）に広げて意識する**
- **夜間（Cron指定時）に「Dream（夢）」を見て記憶の矛盾解消・重複統合・期限切れ整理を自律で行う**

---

## 2. 全体アーキテクチャ

```text
                       電脳神経 (Raw Chat Search)
                      /                         \
            rawchatdb (受動的長期記憶)             memo (能動的常時記憶)
            - 過去会話の全ログ保存                  /                   \
            - Gemini Embedding 2想起   Category 分類             Dream 機能 (自律整理)
            - 必要時にヒント/全文注入    - "User"                  - Cron形式で定期実行
                                       - "Project"               - モデル個別指定可能
                                       - "AgentHabits"           - 単発構造化JSON補完
                                       - "etc"                   - 重複統合・ブラッシュアップ
                                          |                             |
                                          v                             v
                                  write|read|update|remove       プロンプト常時注入
                                  - デフォルト有効期限: 3日間      - デフォルト上限 4,000トークン
                                  - 指定日数単位で延長可能        - <active-memos> タグ
                                  - forever: true (無限保持)      - 決定論的ソート (Prompt Cache安定)
```

---

## 3. データモデル (SQLite: `raw-chat.sqlite`)

電脳神経が既存で管理している SQLite データベース（`resolveRawChatDbPath()`: `~/.openclaw/agents/<agentId>/raw-chat.sqlite`）内に、新テーブル `memos` を追加する。外部DBを新設せず、既存の一元化された接続・WALモード・トランザクションを活用する（ルール #2033 準拠）。

### 3.1 `memos` テーブル定義

```sql
CREATE TABLE IF NOT EXISTS memos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK(category IN ('User', 'Project', 'AgentHabits', 'etc')),
  content TEXT NOT NULL,
  days INTEGER DEFAULT 3,
  forever INTEGER NOT NULL DEFAULT 0,  -- 0: 期限あり, 1: 無限保持
  created_at INTEGER NOT NULL,          -- 作成日時 (epoch ms)
  updated_at INTEGER NOT NULL,          -- 更新日時 (epoch ms)
  expires_at INTEGER,                   -- 有効期限 (epoch ms, forever=1 の場合は NULL)
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'dismissed')),
  tags_json TEXT DEFAULT '[]',           -- タグ一覧 (JSON配列、例: '["DennouAibou","アイデア"]')
  metadata_json TEXT                    -- 将来の拡張用メタデータ (JSON文字列)
);

CREATE INDEX IF NOT EXISTS idx_memos_status_expires
  ON memos(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_memos_category
  ON memos(category, status);
```

- 既存 DB への移行: 初期化時に `ALTER TABLE memos ADD COLUMN tags_json TEXT DEFAULT '[]';` を try/catch で実行（既存カラムがある場合は無視）。
- `MemoRecord.tags: string[]` としてシリアライズ/デシリアライズして保持する。

- スキーマバージョン管理: `database.ts` の `SCHEMA_VERSION` を `"2"` へバンプし、テーブル自動生成・安全な移行を行う。

---

## 4. ツール仕様 (`memo` ツール)

単一の `memo` ツールを提供し、サブアクション（`write`, `read`, `update`, `archive`, `remove`）で操作する。
TypeBox 規約（`stringEnum` によるフラット文字列 enum、`typebox` パッケージからのインポート、ルール #1893/#1894）に準拠し、LLM の認知負荷を最小化する。

### 4.1 パラメータ定義

```ts
import { Type } from "typebox";
import { stringEnum } from "../../../src/agents/schema/typebox.js";

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
  tags: Type.Optional(
    Type.Union([Type.Array(Type.String()), Type.String()], {
      description:
        'write/update 時のタグ一覧（例: ["DennouAibou", "アイデア"]）。カンマ区切り文字列も可。',
    }),
  ),
  tag: Type.Optional(
    Type.String({
      description: "read 時のタグ絞り込み（大文字小文字を区別しない部分一致）。",
    }),
  ),
  includeArchived: Type.Optional(
    Type.Boolean({
      description: "read 時に期限切れ/アーカイブされたメモも含めるか（デフォルト false）。",
    }),
  ),
});
```

### 4.2 ツール説明文 (プロンプト明記要件)

```text
重要な能動記憶・約束・メモを管理するツールです。

⚠️ 【最重要ルール】:
デフォルトでは 3 日間（72時間）で自動的に消去（期限切れ）されます！
ユーザーとの重要な約束、プロジェクトの恒久的な掟、忘れてはならない個人情報を記録する場合は、
必ず `forever: true`（無限保持）を指定するか、長めの日数（例: days: 30）を指定してください。

- action="write": メモを記録する（category, content 必須。1件最大2,000文字。重要なら forever: true）。tags でタグ付け可（例: tags: ["DennouAibou", "アイデア"]、カンマ区切り文字列も可）。
- action="read": 有効なメモを一覧表示または検索する（query や category や tag で絞り込み可能。tag は大文字小文字を区別しない部分一致）。
- action="update": 既存メモの内容・期限・カテゴリ・タグを更新する（id 必須。tags 指定で上書き）。days 指定時は更新日時を起点に再計算。
- action="archive": メモをアーカイブする（id 必須。status='archived' へ。read の includeArchived=true で再表示できる）。
- action="remove": メモを削除する（id 必須。status='dismissed' へ論理削除。再表示されない）。
```

### 4.3 入力検証 ＆ 相関バリデーション

- `content`: 最大 2,000 文字制限（ルール #1575 準拠）。超過時は `content exceeds maximum length of 2,000 characters` で即時エラー。
- `category`: 大文字小文字を吸収（`user` → `User`, `project` → `Project`, `agenthabits` → `AgentHabits`, `etc` → `etc`）。
- `days`: 正の整数（`Math.floor(days) > 0`）を検証。
- `action="write"`: `category` および `content` が必須。
- `action="update"`: `id` が必須。指定されたフィールドのみ部分更新。
  - `days` が渡された場合は現在時刻を起点に `expires_at = now + days * 86400000` を再計算。
  - `forever: true` に更新された場合は `expires_at = NULL, forever = 1` に設定。
  - `forever: false` に更新された場合は、同時に `days`（またはデフォルト3日）に基づき `expires_at = now + days * 86400000` を再計算。
- `action="remove"`: `id` が必須。論理削除（`status='dismissed'`）としてマーク。

### 4.4 タグ仕様 (`tags` / `tag`)

- `write` / `update`: `tags?: string[]` を受け取る（例: `tags: ["DennouAibou", "アイデア"]`）。カンマ区切り文字列も許容し、正規化（トリム、空要素除外、重複排除）して `tags_json` に保存する。`update` では指定時に上書き（空配列でクリア可）。
- `read`: `tag?: string` を受け取り、指定タグ付きメモのみに絞り込む（大文字小文字を区別しない部分一致）。`query` / `category` と併用可。
- `normalizeMemoTags()`: `string[]` / カンマ区切り `string` を正規化する単一の真実源。配列要素内のカンマも分割する。
- 表示: プロンプト常時表示 (`getActiveMemosForPrompt`) と Dream (`buildDreamPrompt`) でタグを表示する。
- Dream 統合 (`applyDreamConsolidation`): `archiveIds` のタグを `keepId` にマージ（重複排除）して保持する。

---

## 5. 常時コンテキスト固定 (システムプロンプト自動注入)

電脳神経プラグインの既存フック `before_prompt_build` を拡張し、毎ターンのプロンプト構築時に有効なメモを取得してシステムコンテキストへ自動注入する。
ベクトル想起のバイパス環境変数（`DENNOU_SKIP_VECTOR_RECALL`）や外部 API 障害から完全に独立して動作する。

### 5.1 遅延期限切れ（Lazy Expiry）

プロンプト注入時および `read` 実行時に、`status = 'active' AND forever = 0 AND expires_at < now` のレコードを自動的に `status = 'archived'` へ更新（自己修復）。Dream が動いていなくても期限切れメモが漏洩しない。

### 5.2 注入先とフォーマット (Prompt Cache 安定性最優先)

- **注入先**: `appendSystemContext`（システムプロンプト末尾）。ユーザー発言枠を一切汚さない。
- **タグ形式**: `<active-memos>`（動的属性は一切排除し、KV キャッシュを保護）。
- **決定論的ソート**: `ORDER BY forever DESC, category ASC, id ASC` で固定。
- **日付表記**: 動的な相対表記（「残り○日」）を避け、静的な日付 `(期限: YYYY-MM-DD)` または `(期限: 無限)` で固定。タイムゾーン（`userTimezone` / ホストTZ）を適用して日付のズレを防ぐ。
- **フォーマット例**:

  ```xml
  <active-memos>
  [User]
  - #12 [DennouAibou, アイデア] (期限: 無限): ユーザーは端的な会話調を好み、長文や定型文を嫌う。
  - #18 (期限: 2026-10-05): 来週月曜日にJLPT過去問の進捗を聞くこと。

  [Project]
  - #3 [DennouAibou] (期限: 無限): KASOU デプロイ時は Git for Windows の tar パスを使うこと。

  [AgentHabits]
  - #5 (期限: 無限): 親友のような温かいトーンで話し、敬語やロボット語を避ける。
  </active-memos>
  ```

  - タグがある場合のみメモ行に `[タグ1, タグ2]` を表示（タグが無い場合は従来通り）。
  - Dream プロンプト (`buildDreamPrompt`) では `#ID [Category] [tags: タグ1, タグ2] (expires: ...): 本文` 形式で表示する。

- **配置順序**: Standing Rules である `<active-memos>` を先頭に配置し、エピソード想起の `<recalled-memory>` をその後に連結する。

### 5.3 トークン予算ガード (動的スケーリング方式)

- `before_prompt_build` でプラグインが安全に扱える予算上限 `maxTokens` を適用。デフォルトは固定値ではなく、メインセッションが使っているモデルの `contextWindow` の **5%**（`max(4,000, floor(contextWindow * 0.05))`）とする。
  - 1M モデル (1,048,576): 約 52,428 トークン (~50K)
  - 500K モデル (524,288): 約 26,214 トークン (~25K)
  - 200K モデル (200,000): 10,000 トークン (10K)
  - 不明・小さい場合: 下限 4,000 トークン
- 明示的に `config.memo.maxTokens` が設定された場合はそちらを優先する（`resolveMemoMaxTokens(pluginConfig, modelContextWindow)`）。
- モデルのコンテキストサイズは `PluginHookAgentContext.modelContextWindow`（`model.contextWindow ?? model.maxTokens`）経由でフックに渡される。
- トークン推定には `src/plugin-sdk/cjk-chars.ts` の `estimateStringChars` および `estimateTokensFromChars`（CJK 1文字 ≈ 1トークン規約）を使用し、文字数とトークン数の換算ズレを防ぐ。
- 予算超過時は `forever = 1`（重要ルール）を最優先で残し、期限付きメモは新しいものから順に枠内に収める。

---

## 6. Dream 機能 (夜間の自律整理)

夜間や指定された Cron スケジュール（デフォルト: 毎日午前3時）に、裏方で単発の構造化 LLM 補完（JSON 出力）を実行し、記憶の自律整理を行う。
フルエージェントセッション（`api.runtime.subagent.run`）を起動せず、直接プロバイダを単発呼び出しするため、不要なセッションファイルの肥大化や無限ループのリスクがない（ルール #2032/#2041 遵守）。

### 6.1 設定スキーマ (`openclaw.plugin.json` ＆ `dennou-aibou.json`)

`extensions/raw-chat-search/openclaw.plugin.json` の `configSchema.properties` に以下を追加し、`bun run config:schema:gen`（ルール #1962）で型・generated スキーマを同期する。

```json
{
  "memo": {
    "type": "object",
    "properties": {
      "maxTokens": {
        "type": "number",
        "default": 4000,
        "description": "System prompt memo token limit"
      }
    }
  },
  "dream": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true },
      "schedule": { "type": "string", "default": "0 3 * * *" },
      "model": { "type": "string" },
      "timezone": { "type": "string" }
    }
  }
}
```

ユーザー設定ファイル（`dennou-aibou.json`）の記述例：

```json
{
  "plugins": {
    "entries": {
      "raw-chat-search": {
        "enabled": true,
        "memo": {
          "maxTokens": 4000
        },
        "dream": {
          "enabled": true,
          "schedule": "0 3 * * *",
          "model": "cli-router/cline-muse-spark-1.3",
          "timezone": "Asia/Jakarta",
          "language": "ja"
        }
      }
    }
  }
}
```

- タイムゾーン解決: `dream.timezone` → `cfg.agents?.defaults?.userTimezone` → ホスト TZ の順に安全解決。

### 6.2 整理タスクの内容

1. **スキップ判定**: 有効なアクティブメモが 0〜1 件の場合は LLM 呼び出しを行わず即時終了（リソース節約）。
2. **単発構造化 LLM 呼び出し**:
   - プロンプトに全アクティブメモを渡し、以下の指示を与える：
     - 重複・類似メモの特定
     - 矛盾するメモの解消（新しい情報を優先）
     - 複数メモの統合（1つの整理されたテキストへ）
   - JSON スキーマレスポンス（`{ consolidations: [{ keepId, updateContent, archiveIds }] }`）を取得。
3. **アトミック更新**:
   - SQLite の `BEGIN IMMEDIATE` トランザクション内で、`updateContent` の適用と `archiveIds` の `status = 'archived'` への一括更新を実行。
4. **ログ記録**:
   - `api.logger.info` で実行サマリ（統合件数、アーカイブ件数）を記録。

---

## 7. 実装ロードマップ

### Phase 1: memo サブシステム基本実装

- [ ] `openclaw.plugin.json` スキーマ拡張 ＆ `bun run config:schema:gen` 再生成
- [ ] SQLite `memos` テーブル追加（`SCHEMA_VERSION = "2"`、インデックス整備）
- [ ] `memo-db.ts`: CRUD ＋ Lazy Expiry ＋ 4,000トークン予算クランプ
- [ ] `memo-tool.ts`: `memo` ツール定義（相関バリデーション、2,000文字上限、3日忘却注意書き）
- [ ] `index.ts`: `before_prompt_build` フックでの `<active-memos>` 注入（Prompt Cache 安定設計、ベクトル想起との完全分離）
- [ ] 単体・統合テスト（CRUD、TTL判定、forever保持、4,000トークンガード、部分一致検索）

### Phase 2: Dream 機能実装

- [x] Croner による定期スケジュールタスク登録
- [x] 単発構造化 LLM 補完による重複統合・精緻化ロジック
- [x] トランザクション更新 ＆ ログ記録
- [x] 統合テスト ＆ 実機検証

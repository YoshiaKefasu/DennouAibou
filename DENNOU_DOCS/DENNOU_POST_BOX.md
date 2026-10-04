# 電脳私書箱 (Dennou PostBox MCP) 設計書

> **状態**: 設計中（改訂版 / レビュー指摘反映済み）  
> **対象**: Kuraudo（Windows 側作業セッション群） ↔ Kasou（KASOU 側マスターセッション）  
> **関連ドキュメント**: `DENNOU_DOCS/DENNOU_SHINKEI_MEMO.md`, `DENNOU_DOCS/DENNOU_ALARM.md`, `DENNOU_DOCS/PHASE_F_SLIM_KERNEL.md`

---

## 1. 背景と目的

- **即時割り込み（Steer）と非同期郵便（Inbox）の棲み分け**:
  - 作業中のリアルタイムな指示・中断は「即時 Steer（`activeSession.steer`）」が担う。
  - 一方で、「今日の実装まとめ」「深夜の日報」「後で読んでほしいアイデア」は、会話を遮ることなく非同期に郵便ポスト（Inbox）へ届けるのが自然である。
- **マルチセッション・プロジェクト別の往復文通**:
  - クライアント側（Kuraudo / 作業環境）には複数のプロジェクトセッション（例: `DennouAibou`, `GoRakuDo`, `DailyTask` など）が存在する。
  - 送信元がどのセッションかを明示（`from_session`）し、Kasou から返信するときもそのセッション宛て（`to_session`）に手紙を返せる **往復書簡（スレッド返信）** を実現する。
- **段ボール設計（MCP deferred）によるプロンプト保護**:
  - Pi SDK 1.0.0 のネイティブ MCP 統合および `deferred` 機構を活用。
  - 普段のプロンプト消費はシステムプロンプト内のサーバー名一行ラベルのみ（ツールの巨大な JSON スキーマはプロンプトに一切載らない）。
  - 手紙を確認・送信したい時だけ `tool_search("postbox")` で段ボールからツールを取り出して使う。

---

## 2. システムアーキテクチャ ＆ プロトコル

Pi SDK 1.0.0（および DennouAibou の MCP クライアント）はレガシーな SSE トランスポートを廃止し、最新の **Streamable HTTP** を標準採用している。
そのため、PostBox サーバーは MCP SDK 1.29.0+ の **`StreamableHTTPServerTransport`** を使用して `/mcp` エンドポイントで待ち受ける。

```
+-----------------------------------------------------------------------------------+
|  [Windows PC (作業環境)]                                                           |
|  Pi Agent / Kuraudo 各セッション                                                 |
|  - セッション "DennouAibou"  ---+                                                 |
|  - セッション "GoRakuDo"     ---+---> [send_letter] 投函                         |
|                                 |                                                 |
+---------------------------------|-------------------------------------------------+
                                  | Streamable HTTP (LAN: http://192.168.100.46:8320/mcp)
                                  | Header: Authorization: Bearer <POSTBOX_TOKEN>
+---------------------------------v-------------------------------------------------+
|  [KASOU サーバー (Linux)]                                                         |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  |  電脳私書箱 MCP サーバー (Dennou PostBox MCP Server)                        |  |
|  |  - ランタイム: Bun 1.4+ (単一プロセス, 軽量)                                 |  |
|  |  - エンドポイント: `POST /mcp` (StreamableHTTPServerTransport)                |  |
|  |  - 認証: 共有 Bearer トークン認証 (`Authorization: Bearer ...`)                |  |
|  |  - DB: `~/.openclaw/postbox/letters.sqlite` (SQLite WALモード)               |  |
|  |  - 待ち受け: 0.0.0.0:8320                                                    |  |
|  +-----------------------------------------------------------------------------+  |
|                                 ^                                                 |
|                                 | Streamable HTTP (http://127.0.0.1:8320/mcp)     |
|                                 | Header: Authorization: Bearer <POSTBOX_TOKEN>   |
|                                 | exposure: "deferred" (段ボール待機)             |
|  +------------------------------v----------------------------------------------+  |
|  |  DennouAibou (Kasou マスターセッション)                                      |  |
|  |  - 普段: ツールスキーマ消費 0 トークン (mcp_servers 一行ラベルのみ)            |  |
|  |  - 確認時: アラームや自律タイミングで tool_search("postbox") して読む         |  |
|  |  - 返信時: 送信元セッションへ send_letter で返信                            |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

---

## 3. データモデル (SQLite)

保存先: `~/.openclaw/postbox/letters.sqlite`

### 3.1 接続時 PRAGMA

接続オープン毎に必ず実行する：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

### 3.2 テーブル定義

#### ① 手紙本体テーブル (`letters`)

```sql
CREATE TABLE IF NOT EXISTS letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session TEXT NOT NULL,           -- 差出人セッション名 (例: "DennouAibou", "GoRakuDo", "Kasou")
  to_session TEXT NOT NULL,             -- 宛先セッション名 (例: "Kasou", "DennouAibou", "all")
  title TEXT NOT NULL,                  -- 件名 (最大 100 文字)
  content TEXT NOT NULL,                -- 本文 (Markdown、最大 6,000 文字)
  reply_to_id INTEGER REFERENCES letters(id) ON DELETE SET NULL, -- 返信元手紙ID
  created_at INTEGER NOT NULL           -- 作成日時 (epoch ms)
);

CREATE INDEX IF NOT EXISTS idx_letters_to_id ON letters(to_session, id DESC);
CREATE INDEX IF NOT EXISTS idx_letters_from ON letters(from_session);
CREATE INDEX IF NOT EXISTS idx_letters_reply_to ON letters(reply_to_id);
```

#### ② セッション別既読・アーカイブテーブル (`letter_states`)

※ 全体宛て手紙（`to_session: "all"`）でも各セッションが独立して未読・既読・アーカイブを管理できるよう、セッション別に保持する。

```sql
CREATE TABLE IF NOT EXISTS letter_states (
  letter_id INTEGER NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  session TEXT NOT NULL,                -- 対象セッション名
  read_at INTEGER,                      -- 開封日時 (epoch ms、未読時は NULL)
  archived_at INTEGER,                  -- アーカイブ日時 (epoch ms、未アーカイブ時は NULL)
  PRIMARY KEY (letter_id, session)
);

CREATE INDEX IF NOT EXISTS idx_letter_states_session ON letter_states(session, archived_at, read_at);
```

---

## 4. MCP ツール仕様 (`post_box` MCP サーバー)

### 4.1 `send_letter` (手紙の投函・返信)

手紙を投函する。特定のセッション宛て、または全体（`"all"`）宛てに送信可能。

- **パラメータ**:
  - `from_session` (string, 必須): 自分のセッション名（例: `"DennouAibou"`, `"Kasou"`）
  - `to_session` (string, 必須): 宛先のセッション名（例: `"Kasou"`, `"DennouAibou"`, `"all"`）
  - `title` (string, 必須): 手紙の件名（最大 100 文字）
  - `content` (string, 必須): 手紙の本文（Markdown、最大 6,000 文字。Pi の 20KB 結果中央切り抜きを確実に回避）
  - `reply_to_id` (number, 任意): 返信元の手紙 ID（返信の場合に指定）
- **戻り値**:
  作成された手紙の ID、宛先、作成日時の JSON。

### 4.2 `check_inbox` (私書箱の一覧確認)

指定したセッション宛ての手紙一覧（サマリー）を確認する。既定ではアーカイブ済み（`letter_states.archived_at IS NOT NULL`）の手紙は除外される。

- **パラメータ**:
  - `session` (string, 必須): 自分のセッション名（このセッション宛て、および `"all"` 宛ての手紙を取得）
  - `unread_only` (boolean, 任意, 既定: `true`): 未読（`read_at IS NULL`）のみを取得するかどうか
  - `include_archived` (boolean, 任意, 既定: `false`): アーカイブ済みの手紙も含めるかどうか
  - `before_id` (number, 任意): この ID より古い手紙を取得（ページネーション用カーソル）
  - `limit` (number, 任意, 既定: `20`, 最大: `50`): 取得最大件数
- **戻り値**:
  手紙のサマリー一覧（ID、差出人、宛先、件名、送信日時、返信元ID、既読状態、アーカイブ状態）。

### 4.3 `read_letter` (手紙の開封・本文閲覧)

指定した手紙の本文を開封して読む。呼び出し元のセッション名に対して `letter_states` を upsert し、既読化する。初回開封日時を保持するため、既に `read_at` が記録されている場合は上書きせず保持（`read_at = COALESCE(read_at, now)`）する。

- **パラメータ**:
  - `id` (number, 必須): 開封する手紙の ID
  - `reader_session` (string, 必須): 開封するエージェントのセッション名（既読記録用。宛先が自分または `"all"`、または差出人本人であることのバリデーションを実施）
- **戻り値**:
  手紙の全容（ID、差出人、宛先、件名、本文、送信日時、スレッド情報）。

### 4.4 `archive_letter` (手紙の保管・アーカイブ)

読み終えた手紙を自分のセッションにおいてアーカイブ済みに移動する（`letter_states.archived_at = Date.now()`）。全体手紙（`"all"`）の場合も、操作したセッションのみでアーカイブされる。

- **パラメータ**:
  - `id` (number, 必須): 対象手紙の ID
  - `session` (string, 必須): 操作を行うセッション名（宛先または差出人のみ許可）

---

## 5. セキュリティ ＆ 耐障害性設計

1. **認証（Bearer トークン）**:
   - MCP サーバー起動時に環境変数 `POSTBOX_TOKEN`（未設定時は `~/.openclaw/postbox/token` をパーミッション `0600` で自動生成）を要求。
   - すべての HTTP リクエストで `Authorization: Bearer <POSTBOX_TOKEN>` を検証。未認証は 401 を即時返却。
   - 設定ファイル（`mcp.json` / `dennou-aibou.json`）もパーミッション `0600` で保護し、Pi 側は環境変数展開（`Bearer ${POSTBOX_TOKEN}`）を利用可能。
2. **アクセス制御 ＆ 信頼モデル**:
   - 自宅ローカルネットワーク（LAN）内での単一ユーザー運用を前提とし、共有 Bearer トークンを所持するクライアントからのセッション名申告は信頼する。
   - `read_letter` / `archive_letter` は `reader_session` が宛先（`to_session` または `"all"`）または差出人本人である場合のみ許可。
   - `send_letter` の `reply_to_id` 指定時、返信元手紙が存在し、かつ自分がその宛先または差出人であることを検証（他スレッドの不正傍受防止）。
3. **文字数・サイズ上限（DoS ガード）**:
   - タイトル最大 100 文字、本文最大 6,000 文字（UTF-8 で約 18KB 以内）。Pi のテキスト結果中央切り抜きバグ（20KB 超過時）を構造的に回避。
4. **自動プルーニング（DB 無限成長防止）**:
   - 日次スケジュール（起動時フォールバック）で古い手紙を自動削除（カスケードで `letter_states` も削除）：
     - **個別宛て手紙 (`to_session != 'all'`)**: 宛先セッションにおいて `archived_at` から 30 日以上経過したものを削除。
     - **全体宛て手紙 (`to_session = 'all'`)**: 作成から 60 日以上経過したもの、または登録された全 `letter_states` がアーカイブ済みとなりその最大日時から 30 日以上経過したものを削除。
     - 未アーカイブの手紙は勝手に消えない。

---

## 6. 各エージェントでの運用と連携フロー

### 6.1 Kuraudo (Windows 側作業セッション) からの送信

1. 作業終了時、Yosia が「今日の作業まとめを Kasou に送って」と指示。
2. Kuraudo は今日の git コミット履歴や実装ログを 6,000 文字以内で綺麗にまとめる。
3. `send_letter` を呼び出し：
   ```json
   {
     "from_session": "DennouAibou",
     "to_session": "Kasou",
     "title": "本日(10/4)の実装日報: 即時Steer & メモタグ機能完了",
     "content": "Kasou、今日もお疲れ様！今日の実装内容をまとめたよ：\n- 即時Steerの改善\n- メモ機能へのtags追加\n..."
   }
   ```
4. 投函完了を Yosia に報告（Kasou を即時起動して邪魔することはない）。

### 6.2 Kasou (KASOU 側マスターセッション) での確認と返信

1. **確認の契機**:
   - 朝や深夜の電脳アラーム（`dennou-alarm`）、または Kasou 自身の自律タイミングで「私書箱に手紙届いてるかな？」とチェック。
2. **ツールの取り出し**:
   - `tool_search("postbox")` で段ボールから `check_inbox` を取り出して実行。
   - `check_inbox(session="Kasou")` で `DennouAibou` からの手紙を発見。
3. **開封**:
   - `read_letter(id=1, reader_session="Kasou")` で本文を読み込み、今日の実装内容を把握（自動既読）。
4. **返信**:
   - `send_letter` を呼び出し、宛先を元の差出人にして返信：
     ```json
     {
       "from_session": "Kasou",
       "to_session": "DennouAibou",
       "title": "Re: 本日(10/4)の実装日報",
       "reply_to_id": 1,
       "content": "日報ありがとう！バッチリ読んだよ。メモのタグ機能、すごく便利そうだね！..."
     }
     ```
   - （※電脳アラーム経由のターンの場合、この返信発言は直通配送で Telegram にもそのまま届く）

### 6.3 翌日以降の Kuraudo 側での確認

1. 次の作業開始時、Kuraudo が `check_inbox(session="DennouAibou")` を確認。
2. Kasou からの返信（手紙 #2）を読み込み、前回の作業へのリアクションを受け取って作業を再開。

---

## 7. 設定ファイル構成

### KASOU 側設定 (`~/.openclaw/mcp.json` 形式)

```json
{
  "mcpServers": {
    "postbox": {
      "url": "http://127.0.0.1:8320/mcp",
      "headers": {
        "Authorization": "Bearer ${POSTBOX_TOKEN}"
      },
      "exposure": "deferred"
    }
  }
}
```

### KASOU 側設定 (`dennou-aibou.json` 形式)

```json
{
  "mcp": {
    "servers": {
      "postbox": {
        "url": "http://127.0.0.1:8320/mcp",
        "headers": {
          "Authorization": "Bearer ${POSTBOX_TOKEN}"
        },
        "exposure": "deferred"
      }
    }
  }
}
```

### Windows 側 (Pi Agent 設定: `~/.pi/agent/mcp.json`)

```json
{
  "mcpServers": {
    "postbox": {
      "url": "http://192.168.100.46:8320/mcp",
      "headers": {
        "Authorization": "Bearer ${POSTBOX_TOKEN}"
      },
      "exposure": "deferred"
    }
  }
}
```

---

## 8. 実装ロードマップ

- [ ] **Phase 1: PostBox MCP サーバーの実装**
  - ディレクトリ: `packages/postbox-mcp/` (Bun + `@modelcontextprotocol/sdk` + SQLite)
  - `server.ts`: `StreamableHTTPServerTransport` による `POST /mcp` 実装 ＆ Bearer トークン認証
  - 4 つのツール (`send_letter`, `check_inbox`, `read_letter`, `archive_letter`) の実装
  - ユニットテスト (`packages/postbox-mcp/test/postbox.test.ts`): 往復投函・セッション別既読・認証ガード・プルーニング検証
- [ ] **Phase 2: KASOU への常駐デプロイ**
  - KASOU サーバー上に `openclaw-postbox.service` (systemd ユニット) を作成して自動起動
  - ポート `8320` での待ち受けとローカルネットワーク疎通確認 (Windows 側から curl で確認)
- [ ] **Phase 3: 各環境への設定配線 ＆ E2E 往復文通テスト**
  - Windows 側 Pi Agent と KASOU 側 DennouAibou の双方で `postbox` を登録
  - Kuraudo から投函 → Kasou が確認・返信 → Kuraudo が受信、の一連の往復サイクルを実証

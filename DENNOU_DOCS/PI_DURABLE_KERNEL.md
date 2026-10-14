# DennouAibou 次世代スリムカーネル設計書: `pi-durable` 移行仕様

> **Status:** Draft / Proposed (Branch: `feature/pi-durable-kernel`)  
> **Author:** Kuraudo & Yosia  
> **Date:** 2026-10-14

---

## 1. 目的と背景

### 1.1 Phase F（スリムカーネル化）の核心課題

DennouAibou はこれまで上流の `pi-coding-agent`（および `pi-agent-core`）をベースにエージェント実行基盤を構築してきた。しかし以下の構造的課題を抱えている：

1. **巨大なブラックボックス依存**:
   `pi-coding-agent` は CLI ツールや対話型 coding agent 向けの肥大化したパッケージであり、Kasou が必要としないサブエージェント管理、マルチエージェントオーケストレーション、旧来のセッション v3/v4 管理などを大量に内包している。
2. **JSONL セッションの脆さ**:
   テキスト追記型の JSONL セッションは、突発的な電源断やクラッシュ時に親子リンク（`parentId`）の欠落や孤児ノード（Orphan）を生みやすく、過去何度も複雑な修復スクリプトや門番（Gatekeeper）を必要としてきた。
3. **再起動時の耐障害性の限界**:
   ツール実行中や長考中にプロセスが再起動した場合、中断された処理をクリーンに復旧する仕組みが弱く、セッション破損や未完了タスクの滞留が発生しやすかった。

### 1.2 `@earendil-works/pi-durable`（v1.2.0）の採用

2026年10月にリリースされた `@earendil-works/pi-durable`（v1.2.0）は、以下の特徴を持つ耐障害性エージェントハーネスである：

- **Chord トランザクションストレージ**: すべての会話、モデルターン、ツール呼び出しがコミットとして SQLite に事前記録される（物理的破損の排除）。
- **クラッシュ復旧の自動化 (`harness.resume()`)**: プロセスが途中で死んでも、再起動時に中断直前の状態から寸分狂わずタスクが再開される。
- **マルチモーダル画像対応**: v1.2.0 より `read` ツールおよびユーザー入力での `ImageContent`（PNG/JPEG/WebP/GIF）が正式サポート。
- **純粋な自律ループ**: `pi-ai` 上に構築された最小限のタスクマシンであり、余計な遺産コードを一切持たない。

本設計書は、DennouAibou のカーネル（`src/agents/pi-embedded-runner/`）を `pi-durable` ベースへと段階的・安全に刷新し、究極にスリムで絶対に壊れないマスターセッションを実現するための仕様を定める。

---

## 2. アーキテクチャ比較とマッピング

| コンポーネント       | 現行カーネル (`pi-coding-agent`)                       | 次世代スリムカーネル (`pi-durable`)                                      |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| **コア基盤**         | `pi-coding-agent` + `pi-agent-core` (推定数十万行)     | `@earendil-works/pi-durable` + `@earendil-works/pi-ai` (最小限)          |
| **セッション管理**   | `SessionManager` (`*.jsonl` 追記型ファイル)            | `Harness` + `openNodeSqliteStorage` (`session.sqlite`)                   |
| **整合性保証**       | JSONL 手動パース + `session-integrity-guard`           | SQLite WAL + ACID トランザクション（破損不可能）                         |
| **実行と中断復旧**   | `AgentSession.prompt()` (中断時はエラー・手動再送)     | `root.submit()` + `submission.wait()` / `harness.resume()` で自動続行    |
| **ツール機構**       | `createOpenClawTools()` 配列渡し                       | `defineTool` + `defineExtension` (レジストリ登録)                        |
| **コード実行**       | `tools/codemode` (独自実装)                            | `@earendil-works/pi-durable/codemode` (公式統合)                         |
| **記憶想起**         | `raw-chat-search` (RawChatDB / SQLite FTS5 + ベクトル) | `raw-chat-search` (**100% 同一仕様で完全温存・共存**)                    |
| **コンテキスト仮眠** | `dennou-nap` / `context-pruner`                        | `dennou-nap` を `pi-durable` のプロンプト前段または Extension として接続 |

---

## 3. 単一不滅マスターセッションの設計

### 3.1 `session.sqlite` による不滅化

- Kasou のマスターセッション（`agent:main:main`）は、`~/.openclaw/agents/main/session.sqlite` として単一の SQLite ファイルで管理される。
- **会話の作成と取得**:
  ```ts
  const storage = await openNodeSqliteStorage(sessionDbPath);
  const harness = await Harness.open(storage, { models, registry, env }, context);
  const root = await harness.root(context, {
    agent: {
      model: { provider: primaryProvider, modelId: primaryModelId },
      instructions: systemPromptText,
    },
  });
  ```
- **クラッシュ耐性**:
  Gateway 起動時、必ず `harness.resume()` を呼び出す。もし前回の稼働中にツール実行中や思考中でプロセスが停止していた場合、未完了のタスクが自動的に復元・再実行される。

### 3.2 RawChatDB（電脳神経）との共存

- **机と本棚の完全分離**:
  - `session.sqlite`: 今話している会話の厳密な実行・永続化ノート（旧 `.jsonl` の完全代替）。
  - `raw-chat.sqlite`（RawChatDB）: 過去ログの全文検索・ベクトル想起用本棚。
- 会話が 1 ターンコミットされるたびに、RawChatDB のインデクサーが SQLite のコミットを検知してベクトル化（FTS5 + Gemini Embedding 2）を行う。

---

## 4. プラグイン・ツールエコシステムの接続

### 4.1 プラグインツールのブリッジ

DennouAibou のプラグイン（`api.registerTool`）で登録されるツール群を、`pi-durable` の `defineTool` 形式へ透過的にブリッジする：

- `read` ツール: `@earendil-works/pi-durable/tools` の `createCodingTools`（`NodeExecutionEnv` + 画像 `ImageContent` 対応）を基盤とし、PDF 抽出や音声判定を内包。
- `dennou-websearch`: 要約段落 ＋ `Reference:` リンク集を返すツールをそのまま `defineTool` として登録。
- `dennou-alarm`: アラーム登録・確認ツールを `defineTool` として登録。
- `memo`: RawChatDB のメモ CRUD ツールをそのまま登録。
- `postbox`: 電脳私書箱 MCP ツールをそのまま接続。

### 4.2 コンテキスト圧縮（`dennou-nap`）の接続

- `pi-durable` の `root.submit()` 前段、またはプロンプト組み立てセクションにおいて、`dennou-nap` の `nap()` / `compressToTarget()` を呼び出す。
- **直近 250 章保護 ＋ 25% 生維持上限 ＋ Laya（15ms）直感仕分け** により、モデル入力が 85% に達した際に安全にインメモリ圧縮を行う。

---

## 5. 移行戦略（安全な 3 段階ロードマップ）

### フェーズ 1: スパイクプロトタイプ検証（完了 ✅）

- `spikes/pi-durable/`: 会話往復、SQLite 中断再開、カスタムツール実行、`ImageContent` 画像入出力を実証完了（5 pass / 0 fail）。

### フェーズ 2: カーネルアダプター実装 (`feature/pi-durable-kernel`)

- `src/kernel/durable/` を新設し、`pi-durable` を用いて Gateway から呼び出せる薄い実行アダプター（`DurableKernel`）を実装する。
- 既存の `pi-embedded-runner` と並行稼働可能なインターフェースを定義し、設定フラグ（`kernel: "durable" | "legacy"`）で切り替え可能にする。

### フェーズ 3: プラグイン・ツール全結合と E2E 検証

- Telegram / Discord からのメッセージ受信 ➡️ `DurableKernel` ➡️ Laya / Jev ➡️ 返信送信までの E2E を検証。
- 安定稼働が実証された後、旧来の `pi-coding-agent` 関連ファイル（約 25 ファイル）を完全撤去（DEBLOAT）し、`main` ブランチへ PR を作成・マージする。

---

## 6. 検証ゲート

| ゲート                              | 判定基準                     |
| ----------------------------------- | ---------------------------- |
| `bun --check` / `bun run typecheck` | **0 errors（型検査全合格）** |
| `bun fmt --check`                   | **pass**                     |
| `bun run config:schema:gen --check` | **pass（生成差分なし）**     |
| `bun test spikes/pi-durable`        | **全 pass（5/5）**           |
| `bun test` 関連テスト               | **既存テスト破損なし**       |
| `bun run ui:build`                  | **pass**                     |

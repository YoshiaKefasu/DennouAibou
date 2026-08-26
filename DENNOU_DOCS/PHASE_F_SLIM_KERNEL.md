# Phase F: Slim Kernel — カーネル境界定義と抽出計画

> **目標**: DennouAibou を「Slim カーネル + 全部プラグイン化」構成へ再編する。
> **状態**: F-1 境界定義確定（2026-08-25 ユーザー裁定込み）。F-2 抽出波は未実施。
> **前提**: Phase D（PI SDK 0.84.2 移行）完了済み。棚卸し根拠は explorer 調査（全項目ファイル+行番号裏付け、HEAD `a1c6c99d181`）。

---

## 1. カーネル契約（残すもの）

| # | カーネル機能 | 内容 |
| --- | --- | --- |
| K1 | セッション管理 | SessionManager v3 経路、マスターセッション保護（削除/リセット不可・compaction は許可） |
| K2 | モデル transport | **OpenAI-compatible `/v1/chat/completions` のみ**（DEBLOAT.md ch.18.2 確定） |
| K3 | イベントポンプ | wake 層（`src/infra/heartbeat-wake.ts`）+ システムイベント消化 — 旧 heartbeat から昇格（§3 裁定） |
| K4 | 通知ディスパッチャ + 受信箱/send ツール口 | 将来のマスターセッション中継（「Yosiaから1件届いた!」→ inbox ツール読み → send ツール返信）の土台 |
| K5 | プラグイン基盤 | plugin slots/facade/hooks、動的ローダー（将来ホットスワップ） |

---

## 2. 裁定事項（2026-08-25 ユーザー確定）

| 対象 | 裁定 | 主要根拠（証拠） |
| --- | --- | --- |
| heartbeat 機能（interval tick / HEARTBEAT.md 実行） | **完全撤去** | KASOU 未使用 |
| イベントポンプ（wake 層 + システムイベント消化） | **カーネルへ昇格・改名温存** | **7系統の消費者**が `requestHeartbeatNow` に直接依存（cron timer / gateway hooks / 通知ディスパッチャ / exec-runtime / ACP / task registry / restart-sentinel）＋プラグイン公開面の再エクスポート（`plugins/runtime/runtime-system.ts:20`）。cron 配信（`enqueueSystemEvent` → heartbeat-runner 内処理）とマスターセッション中継の双方の土台 |
| Cron | **カーネル残留**（今後使う） | `CronService` インターフェース疎結合、`cfg.cron.enabled` / `DENNOU_SKIP_CRON` kill switch 存在 |
| ClawHub / 更新チェック | **撤去** | エージェント側の結合はシステムプロンプト静的文言1行（`agents/system-prompt.ts:256`）のみ。更新チェック自体は gateway 起動時タイマーとして別途稼働（`server.impl.ts:1425`、停止フック :837）。`src/infra/clawhub.ts`(673行) + skill/plugin install UI 群 |
| memory-core extension | **プラグイン抽出**（実態は既にプラグイン形状） | slots/facade/hooks 疎結合済み。**注意**: `src/plugin-sdk/memory-core*.ts` 13ファイル（うち host-* 11ファイル）は raw-chat 側（`dennou-soul/raw-chat/tool.ts`）が汎用ヘルパーとして消費 → カーネル側に保持 |
| Go sidecar（raw chat index/search） | **撤去〜縮小候補** | 提供機能は `raw_chat.index_session/search/backfill` ＋ `ping`（名前空間なし）のみ。prune エンジン（ツール結果 placeholder 化、`dennou-soul/prune-engine.ts`）は**純粋 TS** であり巻き込まない。`chat_search` はクライアント不在時 graceful null（`tool.ts:40-48`、kill switch も同範囲）。TS 置換前例: memory-core の node:sqlite+FTS |
| モデルプロバイダー | `/v1/chat/completions` 一本化 | DEBLOAT.md ch.18.2。OpenAI native auth + Codex OAuth も撤去 |

**訂正記録**: 「ツール結果 placeholder 化は Go」という当初認識は誤り。prune エンジンは TS 実装。Go sidecar の責務は raw chat 索引/検索に限定される。

---

## 3. イベントポンプ昇格の詳細（K3）

旧構造: `heartbeat-runner.ts`(1,382行) が interval tick + watchdog + HEARTBEAT.md 実行 + **システムイベント消化**（cron の `isCronSystemEvent` / `buildCronEventPrompt` 処理、`:541,585`）を担っていた。

新構造:
1. interval tick / HEARTBEAT.md 実行 / `resolveHeartbeatIntervalMs` 系設定 → **削除**
2. `heartbeat-wake.ts`（coalesce/priority キー付き wake）+ システムイベントキュー消化 → **カーネル機能として改名・昇格**（仮称 `event-pump`）
3. cron のメインセッション配信はイベントポンプ経由に接続し直し（挙動維持、名称だけ変わる）
4. `types.agent-defaults.ts:163` の虚偽 JSDoc（「default: 30m」、実際はデフォルト無効）はこの際に修正

**挙動変化（意図的）**:
- wake 優先度マップを整理: `cron:*` は DEFAULT から ACTION へ昇格、`notifications-event` を新規 ACTION として追加、定期巡回専用だった INTERVAL tier は廃止。システムイベント契機の wake が高優先度で即座に消化される設計へ統一。

---

## 4. F-2 抽出波（実施順・各波=段階コミット+code-reviewer レビュー）

> NOTE: DEBLOAT.md ch.18.2 の「第2抽出波」表記は初期案。本書の Wave 定義が優先される。

| 波 | 内容 | 状態 |
| --- | --- | --- |
| **Wave 1** | プロバイダー `/v1/chat/completions` 一本化（§5 詳細） | **着手指示済み** |
| Wave 2 | ClawHub / 更新チェック撤去 | 未着手 |
| Wave 3 | heartbeat 機能撤去 + イベントポンプ昇格改名（cron 配信接続替え、restart-sentinel の wake 経路接続替え、plugin facade `runtime-system.ts:20` の接続替えを含む） | 未着手 |
| Wave 4 | memory-core 抽出（SDK ファサード13ファイルはカーネル保持） | 未着手 |
| Wave 5 | Go sidecar 解体 + `chat_search` の TS 化判断（graceful null は現状維持可） | 未着手 |

共通ゲート（各波とも）: `tsgo --noEmit` エラーゼロ / contracts 新規失敗ゼロ（既知 pre-existing 以外）/ plugin-activation-boundary 全pass / oxfmt pass / stash A/B で pre-existing 失敗数不変の証明。

---

## 5. Wave 1 詳細スコープ: プロバイダー一本化

### 削除対象
- `src/agents/anthropic-transport-stream.ts`（direct Anthropic、xhigh effort マッピング含む — 役目終了）
- `src/agents/anthropic-vertex-stream.ts`
- google 系残存 transport（ch.15-16 で大部分廃止済みの残り）
- openai-responses API 経路
- openai-codex OAuth（ChatGPT backend）+ OpenAI 固有 auth 機構
- 上記に付随する compat 正規化層・テスト

### 残留対象
- openai-completions transport（`/v1/chat/completions`）
- モデルレジストリ / models.json discovery（`pi-model-discovery.ts` の openai-completions compat デフォルト統合含む）
- 手動 OpenAI-compatible 入力（custom-api-registry）
- session-compat / kasou-session-compat / activation-boundary 等のランタイム中立テスト

### テスト方針
- 撤去プロバイダー固有の live/モデルテスト（minimax.live、google-gemini-switch.live、anthropic.setup-token.live、openai.live 等）は削除
- 生きるテストが参照を失って落ちる場合は、ソース側削除に合わせて該当テストも削除（期待値の改ざんはしない）
- stash A/B で「削除前後で既知 pre-existing 失敗数不変」を証明

### KASOU 影響（別途対応）
- Google 系ルーティング / Codex OAuth Track B は引退。KASOU 側は `/v1/chat/completions` 互換エンドポイントへ移行する必要がある（デプロイは後続フェーズ、要ユーザー承認）

---

## 6. 今後の拡張ビジョン（本フェーズスコープ外・方向性記録）

- メッセージAPIプラグイン（owner マーカー付きフル流入 / 非ownerは「×件」通知+1時間蓄積ダイジェスト）— `@line/bot-sdk` 温存はこの候補のため（DEBLOAT.md ch.18.2）
- Bun 単一バイナリ配布 — スリム化完了後のトラック（互換性スパイク→段階移行）

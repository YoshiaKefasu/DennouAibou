# Changelog

DennouAibou は OpenClaw v2026.4.5 をベースとしたフォークです。
上流の変更履歴は https://github.com/openclaw/openclaw を参照してください。

## dennou-v0.6.0 (2026-05-18)

### 上流パッチ適用 (cherry-pick from v2026.4.5 → v2026.4.8)

- **heartbeat / セッション安定性**
  - fix(agents): heartbeat always targets main session — prevent routing to active subagent sessions
  - fix(heartbeat): add subagent guard to resolveHeartbeatSession production code
  - fix: respect disabled heartbeat guidance — disabled heartbeat に system prompt を注入しない
  - fix: tighten TUI phase handling and heartbeat session guards
- **SSE 履歴の競合修正**
  - fix(gateway): eliminate SSE history double-read race — 単一スナップショットから sanitized/raw を派生
  - fix: seed SSE history state from one snapshot
  - fix(gateway): seq-based cursor pagination + sanitize SSE fast path
- **ログ・セキュリティ・パフォーマンス**
  - fix(logging): correct levelToMinLevel mapping for tslog v4
  - fix(agents): replace `.*` with `\S*` in interpreter heuristic to prevent ReDoS
  - fix: approval boundary bypass
  - fix: multiple dangerous build tool environment variables leak
- **Pi Embedded Runner**
  - fix: compaction after tool use abortion cause agent infinite loop calls
  - fix(agents): backfill missing sessionKey in embedded PI runner — model selection / live-switch の undefined key 防止

### DennouAibou 独自機能

- **イベントループ死活監視 (Liveness Watchdog)**
  - `src/dennou-soul/liveness-watchdog.ts` を新規追加
  - 5分周期の setInterval で自己発火監視 (process.hrtime.bigint)
  - タイマー飢餓検出時 → systemctl --user restart で自動復旧
  - KASOU cron watchdog (systemd timer, 5分周期, ログファイルmtime監視) と二重化
- **heartbeat-runner watchdog バックポート**
  - 上流 PR #31226 と同じ修正を適用: `.unref()` 削除 + setInterval watchdog
  - watchdog 発火時は `reason: "watchdog"` でログ区別可能

### セッション・設定

- Session reset `off` 対応 — resetByType / resetByChannel も含めて完全無効化
- DennouAibou 設定UIの追加 (Config → DennouAibou タブ)
  - 3層 prune 設定: shared toolsPrune / closed-session sessionToolsPrune / active-session activeSessionToolsPrune
  - 英語ヘルプコピー追加
- 設定反映のビルド順序修正: `pnpm build` → `pnpm ui:build` を強制
- ベーススキーマ生成スクリプト修正: `schema-base.ts` の import パス修正

### Prune 機能

- ドライランのログ flood 抑制: ファイルレベルの集計のみ出力
- セッションパスの二重化バグ修正 (sessions/sessions → sessions)
- ワークスペースパス保護の強化: JSONL生テキストも保護対象に追加

### デプロイ・ビルド

- ビルド時に A2UI ソース欠落で prebuilt bundle を使う設定
- `dennou-v0.5.1` GitHub Release (source tarball)
- KASOU への全 deploy 手順確立: stop → overlay dist → restart → HTTP確認

## dennou-v0.5.1 (2026-04-30)

### 上流パッチバックポート

- **ログローテーション修正** (`[FIX-UPSTREAM]`)
  - resolveActiveLogFile() で日付跨ぎのファイル切り替えを保証
  - config 更新時も新しい日付ファイルを生成
- **Discord stale-socket 誤検出修正** (`[FIX-UPSTREAM]`)
  - lastTransportActivityAt でトランスポートレベルの活動を分離計測
  - Carbon gateway に60秒ポーリングの isConnected 監視を追加
  - Slack stale-socket テストのスナップショット修正
  - readiness.test.ts の stale-socket → ready 状態遷移テスト復旧

### DennouAibou 独自機能

- **Config UI: DennouAibou 設定タブ**
  - `/config` ページのカテゴリタブに DennouAibou 設定を追加
  - 設定項目: dennou.toolsPrune.*, dennou.sessionToolsPrune.*, dennou.activeSessionToolsPrune.*, dennou.pruneProtection.*
  - ウェブソケット経由のランタイムスキーマ配信に対応

### ビルド・デプロイ

- pnpm locked gitnexus@1.6.3 (RCバージョンの回避)
- デプロイチェックリスト確立: schema.dennou の有無確認 → Control UI アセット確認
- KASOU へのデプロイ手順文書化

## dennou-v0.4.30 (2026-04-30)

ベース: OpenClaw v2026.4.5

### DennouAibou 初期機能

- **Session prune Dennou 管理機能**
  - 3層 prune 設定フレームワーク: toolsPrune (共通) / sessionToolsPrune (closed) / activeSessionToolsPrune (active)
  - minPrunableToolChars, keepLastTools, dryRun の各設定
  - ワークスペースパス保護による会話コンテキスト保持
  - アクティブセッション: 30分 idle 検出、直近10ツール保持
  - Closed セッション: dryRun モード (デフォルト)
- **Pi compaction 設定カスタマイズ**
  - timeout compaction threshold を設定から変更可能 (`resolveTimeoutCompactionPromptUsageThreshold`)
  - reserveTokens の尊重
  - safeguard summary cap の keepRecentTokens 準拠
- **[DEBLOAT]** 不要バンドルの削除
  - Bedrock, Swift 関連
  - 未使用プラグインの facade type shim
  - テスト・ドキュメントの整合性調整

### 開発基盤

- DENNOU_RULES.md 確立 (commit tag taxonomy, deploy手順, ドキュメント規則)
- DENNOU_DOCS/ アーカイブ開始
- graphify + codesight インデックス
- 古い README の整理

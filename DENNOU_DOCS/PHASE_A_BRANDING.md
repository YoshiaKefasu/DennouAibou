# Phase A: Branding — OpenClaw → DennouAibou

> **目標**: リポジトリ全体の "OpenClaw" ブランディングを "DennouAibou" へ全面置換
> **工数目安**: 1-2日
> **前提**: Provider Debloat (41 extension 削除) は完了済み

---

## 1. 置換スコープ

### 1.1 パッケージレベル (package.json)

| 項目             | 現在                                           | 変更後                                                |
| ---------------- | ---------------------------------------------- | ----------------------------------------------------- |
| `name`           | `"openclaw"`                                   | `"dennou-aibou"`                                      |
| `homepage`       | `https://github.com/openclaw/openclaw#readme`  | `https://github.com/YoshiaKefasu/DennouAibou#readme`  |
| `bugs.url`       | `https://github.com/openclaw/openclaw/issues`  | `https://github.com/YoshiaKefasu/DennouAibou/issues`  |
| `repository.url` | `git+https://github.com/openclaw/openclaw.git` | `git+https://github.com/YoshiaKefasu/DennouAibou.git` |
| `bin.openclaw`   | `"openclaw": "openclaw.mjs"`                   | `"dennou-aibou": "openclaw.mjs"`                      |

**注意**: `name` 変更は `require("openclaw")` / import パスに波及する可能性がある。`src/plugin-sdk/` の import は `@openclaw/*` を維持するが、パッケージ名変更後にモジュール解決が壊れないことをビルドで確認する。

### 1.2 環境変数プレフィックス

| 現在         | 変更後     | 影響範囲                 |
| ------------ | ---------- | ------------------------ |
| `OPENCLAW_*` | `DENNOU_*` | スクリプト、設定、テスト |

**変更対象の主要環境変数（網羅リスト）**:

| 環境変数                     | 使用箇所           |
| ---------------------------- | ------------------ |
| `OPENCLAW_SKIP_CHANNELS`     | テスト・開発       |
| `OPENCLAW_LIVE_TEST`         | ライブテスト       |
| `OPENCLAW_LIVE_ANDROID_NODE` | Android テスト     |
| `OPENCLAW_E2E_*`             | E2E テスト         |
| `OPENCLAW_VITEST_*`          | テスト設定         |
| `OPENCLAW_PROFILE`           | TUI プロファイル   |
| `OPENCLAW_SKIP_DOCKER_BUILD` | Docker テスト      |
| `OPENCLAW_HOME`              | ホームディレクトリ |
| `OPENCLAW_CONFIG_PATH`       | 設定ファイルパス   |
| `OPENCLAW_GATEWAY_TOKEN`     | 認証トークン       |
| `OPENCLAW_GATEWAY_PORT`      | ゲートウェイポート |
| `OPENCLAW_HOME_VOLUME`       | Docker ボリューム  |

**判断ポイント**: 環境変数は外部依存（CI、デプロイスクリプト、ユーザー設定）にも影響。変更する場合は：

1. 旧 `OPENCLAW_*` との互換性を maintain する（新しい方を優先、旧方を fallback）
2. または完全に置換し、全ファイルを grep して残りゼロにする

### 1.3 CLIコマンド / スクリプト名

package.json のスクリプト名に `openclaw` が含まれるもの：

| スクリプト                 | 内容                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `"openclaw"`               | `node scripts/run-node.mjs`                                        |
| `"openclaw:rpc"`           | `node scripts/run-node.mjs agent --mode rpc --json`                |
| `"gateway:dev"`            | `OPENCLAW_SKIP_CHANNELS=1 node scripts/run-node.mjs --dev gateway` |
| `"release:openclaw:npm:*"` | npm リリース関連                                                   |
| `"qa:lab:ui"`              | `pnpm openclaw qa ui`                                              |

### 1.4 ワークスペース内スクリプトファイル名

| ファイル                                     | 内容                 |
| -------------------------------------------- | -------------------- |
| `openclaw.mjs`                               | CLI エントリポイント |
| `scripts/openclaw-prepack.ts`                | prepack スクリプト   |
| `scripts/openclaw-npm-release-check.ts`      | リリースチェック     |
| `scripts/openclaw-npm-postpublish-verify.ts` | リリース後検証       |

**推奨**: ファイル名は変更せず、中身の文字列のみ置換（ファイル名変更は import path に波及）。

### 1.5 ソースコード内の文字列

| 場所               | 種類                       | 数     |
| ------------------ | -------------------------- | ------ |
| `src/config/*.ts`  | 設定キー、フォルダパス     | 多数   |
| `src/gateway/*.ts` | ヘッダー名、ログメッセージ | 多数   |
| `src/agents/*.ts`  | アシスタント名、ツール名   | 中程度 |
| `docs/**/*.md`     | ドキュメント文字列         | 大量   |

**主要な wire-protocol 識別子**:

- `x-openclaw-*` ヘッダー（HTTP/WS通信）
- `~/.openclaw/` ファイルシステムパス
- `Symbol.for("openclaw.*")` グローバルシンボル
- `openclaw/plugin-sdk/*` インポートパス
- `openclaw-control-ui` センダーID（`src/auto-reply/command-control.test.ts:227` 等）
- Canvas host URL パス: `/__openclaw__/a2ui`, `/__openclaw__/canvas`, `/__openclaw__/ws`
- `window.__openclaw` グローバル（`ui/src/ui/views/chat.ts` 等）

### 1.6 UI i18n ロケールファイル

`ui/src/i18n/locales/` 配下のロケールファイル（ja-JP.ts 等 11 locales）に `"openclaw.json"` 文字列が埋まっている。UI のローカライズ文字列も置換対象に含める。

### 1.7 Dockerfile / CI

- `Dockerfile`:64 に `pnpm-workspace.yaml` 等が COPY され、ビルド内で `OPENCLAW_*` env var が参照される
- `.github/workflows/*`: CI ワークフローで `OPENCLAW_*` env var が使用される
- `scripts/install.sh`, `scripts/pr-lib/merge.sh`: インストール・マージスクリプトで `openclaw` 参照

### 1.8 GitHub リポジトリ参照

| 参照先       | 現在                | 変更後                                |
| ------------ | ------------------- | ------------------------------------- |
| リポジトリ   | `openclaw/openclaw` | `YoshiaKefasu/DennouAibou`            |
| upstream追跡 | `origin/main`       | `upstream/main` (OpenClaw本家) に分離 |

---

## 2. 置換戦略

### 2.1 段階的アプローチ

1. **Phase 1: 非破壊的な表示名のみ置換**
   - README.md, CHANGELOG.md, ドキュメント内の "OpenClaw" → "DennouAibou"
   - package.json の `description`, `homepage`, `bugs`, `repository`
   - **bin エントリは一旦両方残す** (`"openclaw"` + `"dennou-aibou"`)

2. **Phase 2: 設定・環境変数の置換**
   - 環境変数プレフィックスの移行（旧→新 fallback 付き）
   - 設定ファイルのフォルダパス (`~/.openclaw/` → `~/.dennou-aibou/` or `~/.dennou/`)
   - **⚠️ KASOUとの互換性を必ず確認**

3. **Phase 3: CLIコマンド名の置換**
   - bin エントリの `dennou-aibou` を主に、`openclaw` をエイリアスとして維持
   - スクリプト名の整理

4. **Phase 4: wire-protocol の置換**
   - ヘッダー名 (`x-openclaw-*` → `x-dennou-*`)
   - シンボル名
   - Canvas host URL パス
   - **⚠️ プラグイン互換性に影響。episodic-claw 等の既存プラグインとの整合を確認**

### 2.2 置換しないもの（互換性維持）

| 項目                                    | 理由                                                           |
| --------------------------------------- | -------------------------------------------------------------- |
| `@openclaw/plugin-sdk/*` インポートパス | プラグインエコシステム互換。ClawHub プラグインがこのパスを参照 |
| upstream git リファレンス               | マージ・cherry-pick 時に上游を追跡するため                     |
| テスト内のモックデータ                  | モックは文字列なので実機能に影響なし（必要に応じて後回し）     |

### 2.3 KASOU 固有の変更点チェックリスト

置換時に個別対応が必要な KASOU 固有パス:

| パス                                              | 内容             | 対応                |
| ------------------------------------------------- | ---------------- | ------------------- |
| `~/.openclaw/openclaw.json`                       | gateway 設定     | パス変更 or symlink |
| `~/.openclaw/.env`                                | API キー         | パス変更 or symlink |
| `~/.openclaw/extensions/`                         | プラグイン配置   | パス変更 or symlink |
| `~/.config/systemd/user/openclaw-gateway.service` | systemd unit     | unit 名変更         |
| `/tmp/openclaw/`                                  | ログディレクトリ | パス変更            |

---

## 3. リスクと対策

| リスク                                                          | 対策                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------- |
| KASOU の `~/.openclaw/` パスが変わると gateway 起動不可         | Phase 2 で旧パスからの symlink か fallback を設ける   |
| プラグインが `@openclaw/plugin-sdk/*` を参照                    | インポートパスは維持（`src/plugin-sdk/` はそのまま）  |
| 環境変数が CI/CD で使われている                                 | 旧→新 fallback を実装し、移行期間を設ける             |
| bin 名が変わると `openclaw gateway start` 等が動かなくなる      | `openclaw` をエイリアスとして維持                     |
| `openclaw.json` 設定ファイル名が変わると設定が読めなくなる      | 設定ファイル名は `dennou-aibou.json` に変更 or 両対応 |
| Canvas host URL 変更で UI アクセスが壊れる                      | URL パスも同時に置換                                  |
| episodic-claw の config path が変わるとプラグインが動かなくなる | Phase 4 前に episodic-claw のパス設定を更新           |

---

## 4. 検証基準

- [ ] `pnpm build` が通る
- [ ] `pnpm test` が通る（既存失敗が増えない）
- [ ] `grep -ri "openclaw" src/` の結果が意図的な残存のみ
- [ ] **意図的残存の定義**: `@openclaw/plugin-sdk/*` インポート、upstream git ref、テストモック文字列
- [ ] `grep -ri "openclaw" package.json` の結果が bin エイリアスと upstream 参照のみ
- [ ] README.md が "DennouAibou" として統一されている
- [ ] KASOU デプロイ後、gateway が `/` `/logs` で HTTP 200 を返す
- [ ] `dennou-aibou` コマンド（または `openclaw` エイリアス）で gateway 起動可能
- [ ] Canvas UI (`/__openclaw__/a2ui`) が正常に動作

---

## 5. コミットタグ

この作業で使用するタグ: `[BRAND]`

```
[BRAND] Replace OpenClaw branding with DennouAibou
```

DENNOU_RULES.md の既存タグ taxonomy に追加:

| タグ             | 用途                       |
| ---------------- | -------------------------- |
| `[SOUL]`         | DennouAibou オリジナル機能 |
| `[FIX-SOUL]`     | DennouAibou オリジナル修正 |
| `[DEBLOAT]`      | 未使用 upstream 削除       |
| `[FIX-UPSTREAM]` | 上流へのパッチ             |
| `[SYNC]`         | 上流からの直接 import      |
| **`[BRAND]`**    | **ブランディング変更**     |

---

## 6. 実施記録

| 日付 | 内容 | 状態 |
| ---- | ---- | ---- |
|      |      |      |

---

## 7. 判断待ち項目

1. **bin エントリ名**: `"dennou-aibou"` のみ？ それとも `"openclaw"` エイリアスも維持？
2. **環境変数プレフィックス**: `DENNOU_*`？ または `OPENCLAW_*` を維持？
3. **設定フォルダパス**: `~/.dennou-aibou/`？ または `~/.openclaw/` を維持？
4. **wire-protocol ヘッダー**: `x-dennou-*`？ または `x-openclaw-*` を維持（プラグイン互換）？
5. **episodic-claw のパス設定**: プラグイン配置パスの変更は必要か？

---

## 8. 参考

- 既存 DEBLOAT.md: Provider 削除の詳細な実施記録
- DENNOU_RULES.md: `[SOUL]`, `[DEBLOAT]` タグの使い方
- CONTEXT_MEMORY.md: KASOU デプロイ手順、設定パス
- docs/pi.md: PI SDK 統合アーキテクチャ

# Phase D: PI SDK Update — PI SDK（`@mariozechner/*` → `@earendil-works/*`）アップデート

> **目標**: DennouAibou のコアエンジンである PI SDK を `@mariozechner/*` v0.65.2 → `@earendil-works/*` v0.84.2 へ完全更新・互換性実証
> **工数目安**: 1-2日（互換性テスト含む）
> **状態**: ✅ D0〜D5 全ステップ完了（2026-08-25）

---

## 1. 現状（移行完了後）

| 項目 | 移行前 (D0開始時) | 移行後 (D5完了時) |
| -------------------- | ------------------------------- | -------------------------------- |
| **パッケージスコープ** | `@mariozechner/*` | `@earendil-works/*` |
| **SDK バージョン** | `0.65.2` | `0.84.2` |
| **SessionManager バージョン** | `CURRENT_SESSION_VERSION = 3` | `CURRENT_SESSION_VERSION = 3` (維持・互換立証) |
| **import 箇所** | ソースコード内 68箇所 | スコープ移管リネームによりソース全域 338ファイル更新完了 |

### 同期パッケージ

| パッケージ | 移行前 | 移行後 | 備考 |
| ----------------------------- | ------ | ------ | ------------------ |
| `@earendil-works/pi-agent-core` | 0.65.2 | 0.84.2 | エージェントループ |
| `@earendil-works/pi-ai` | 0.65.2 | 0.84.2 | LLM抽象化 (/compat 経由) |
| `@earendil-works/pi-tui` | 0.65.2 | 0.84.2 | TUIコンポーネント (TuiMainScreen) |
| `@earendil-works/pi-coding-agent` | 0.65.2 | 0.84.2 | コーディングエージェント本体 |

---

## 2. PI SDK と DennouAibou の関係

### アーキテクチャ

```
┌─────────────────────────────────────────────────┐
│  DennouAibou Gateway (port 18789)               │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │  @earendil-works/pi-coding-agent (SDK)  │    │
│  │  ├─ createAgentSession()                │    │
│  │  ├─ SessionManager (v3)                 │    │
│  │  ├─ ModelRegistry / CredentialStore     │    │
│  │  └─ Built-in Tools (read/bash/edit...)  │    │
│  └─────────────────────────────────────────┘    │
│           ↑ embed (not subprocess)              │
│  ┌─────────────────────────────────────────┐    │
│  │  Pi Embedded Runner                     │    │
│  │  ├─ run/attempt.ts                      │    │
│  │  ├─ stream-resolution.ts                │    │
│  │  └─ session lifecycle management        │    │
│  └─────────────────────────────────────────┘    │
│           ↓                                     │
│  ┌─────────────────────────────────────────┐    │
│  │  Telegram / Discord / LINE              │    │
│  │  (メッセージルーティング)                │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

**重要**: PI SDK は DennouAibou の**コアエンジン**。サブプロセスや RPC ではなく、直接 `createAgentSession()` をインポートして使用している。

### 主要な使用箇所

| ファイル群 | 用途 |
| ------------------------------------ | -------------------------------- |
| `src/agents/pi-embedded-runner/` | エージェント実行のメインエントリ |
| `src/gateway/server-methods/chat.ts` | チャットメッセージ処理 |
| `src/agents/compaction.ts` | セッション圧縮 |
| `src/config/sessions/` | セッション管理 |
| `src/agents/command/` | コマンド実行 |

---

## 3. 更新の理由

1. **セキュリティ**: 0.65.2 → 0.84.2 の間に適用されたセキュリティ修正を取り込み
2. **バグ修正**: 上流のバグ修正およびプロバイダー API 追従を反映
3. **新機能**: 新しいプロバイダー対応、ツール拡張、CredentialStore パターンへの移行
4. **依存関係**: 同期パッケージ（pi-agent-core, pi-ai, pi-tui, pi-coding-agent）の整合性維持と新スコープ（`@earendil-works`）への移管追従

---

## 4. 更新手順

### Step 1: 変更内容の確認

```bash
# CHANGELOG を確認
# https://github.com/earendil-works/pi-mono
# 現在の依存関係を確認
cd "D:\GitHub\OpenClaw Related Repos\DennouAibou"
cat package.json | grep -A2 "pi-agent-core\|pi-ai\|pi-coding-agent\|pi-tui"
```

### Step 2: バージョン更新（ホップ実行）

```bash
# 4パッケージを同時に更新（バージョン整合性維持）
# D1: @mariozechner/*@0.73.1
# D2: @earendil-works/*@0.74.2
# D3: @earendil-works/*@0.84.2
pnpm add @earendil-works/pi-agent-core@0.84.2 @earendil-works/pi-ai@0.84.2 @earendil-works/pi-coding-agent@0.84.2 @earendil-works/pi-tui@0.84.2
```

**注意**: 4パッケージは同じバージョンに揃えること。バージョンが混在するとビルドエラーになる。

### Step 3: 型エラー修正・移行対応

- `createAgentSession()` のシグネチャ変更 (`noTools: "builtin"`)
- `pi-ai` ルートインポートの `/compat` サブパス移行
- `AuthStorage` → `CredentialStore` アダプタ構築
- `ModelRegistry` コンストラクタ引数および `ModelRuntime.create` 経由の非同期 `discoverModels` 化
- `streamFn` → `streamFunction` リネーム
- `ThinkingLevel` effort マッピング復元

### Step 4: ビルド・型チェック確認

```bash
pnpm exec tsgo --noEmit --singleThreaded --checkers 1
```

### Step 5: テスト確認

```bash
# 互換性テスト・契約テスト・ユニットテスト
pnpm test:contracts
pnpm vitest run src/agents/pi-embedded-runner/session-compatibility.test.ts
pnpm vitest run src/agents/pi-embedded-runner/kasou-session-compat.test.ts
```

### Step 6: KASOU での検証（Phase E）

```bash
# ビルド → デプロイ → gateway 起動 → Telegram 応答確認
```

---

## 5. 破壊的変更への対応

### 5.1 確認・吸収した主な破壊的変更

| バージョン範囲 | 破壊的変更内容 | DennouAibou での対応 |
| --------------- | --------------------------------------- | ------------------------------------ |
| 0.65.x → 0.68.x | `codingTools`/`readTool` 事前エクスポート廃止 | `createCodingTools(cwd)` ファクトリ方式へ移行 |
| 0.68.x | `createAgentSession` の `tools` が allow-list 化 | `noTools: "builtin"` を導入し旧 builtInTools セマンティクス復元 |
| 0.69.x | TypeBox 移行 (`@sinclair/typebox` → `typebox`) | 77ファイルの import 置換、`asSchemaJson()` 導入、Static ナローイング対応 |
| 0.73.x → 0.74.x | パッケージスコープ移管 | `@mariozechner/*` → `@earendil-works/*` へ全域リネーム |
| 0.74.x → 0.84.x | `pi-ai` ルートエクスポート廃止 | `@earendil-works/pi-ai/compat` サブパスへ移行 |
| 0.74.x → 0.84.x | `AuthStorage` 廃止、`CredentialStore` 導入 | `auth-storage-adapter.ts` 新設、非同期事前投入ミラーパターン |
| 0.74.x → 0.84.x | `ModelRegistry` の非同期化 | `await ModelRuntime.create()` 経由で `discoverModels` 非同期化 |
| 0.74.x → 0.84.x | Agent の `streamFn` リネーム | `streamFunction` へ全域リネーム |
| 0.74.x → 0.84.x | TUI クラス名変更 | `TUI` → `TuiMainScreen`、`clearApiProviders` → `resetApiProviders` |

### 5.2 回退戦略

```bash
# 更新が壊れた場合、元のバージョンに戻す（D1 ホップ内での安全弁）
# NOTE: D2 以降（スコープ移行後）は旧スコープへのバージョン戻しではコンパイル不可。
# スコープ移行後の回退は各ホップコミットの git revert を使用すること。
pnpm add @mariozechner/pi-agent-core@0.65.2 @mariozechner/pi-ai@0.65.2 @mariozechner/pi-coding-agent@0.65.2 @mariozechner/pi-tui@0.65.2
```

---

## 6. 検証基準

- [x] `tsgo --noEmit` が型エラー 0 件で通る
- [x] セッション互換性テスト (`session-compatibility.test.ts` / `kasou-session-compat.test.ts`) 全パス
- [x] プラグインアクティベーション境界テスト (`plugin-activation-boundary.test.ts`) 全パス
- [x] channels contracts テスト (`src/channels/plugins/contracts/`) 37 files / 129 tests 全パス（plugins 側 `src/plugins/contracts/` 40 files は Phase D ゲート対象外・未測定）
- [x] モデルプロファイル・ストリーム系テスト (`model.test.ts`, `btw.test.ts`, `vertex-stream.test.ts` 等) 全パス
- [x] Pre-existing failures 以外の新規テスト失敗がない（stash A/B 実証済み）
- [ ] KASOU 本番デプロイ後、gateway が起動し `/` `/logs` で HTTP 200（Phase E 実施）
- [ ] Telegram 応答が正常（Phase E 実施）

---

## 7. リスクと検証結果

| リスク | 想定された対策 | 実際の検証結果 |
| -------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| PI SDK の API 変更でコンパイルエラー | CHANGELOG で事前確認、型エラーを個別修正 | D1〜D3 で段階的に吸収。`tsgo` 0 errors を全ホップで維持 ✅ |
| セッション形式の変更で既存セッションが読めなくなる | 更新前にバックアップ、形式変更の有無を確認 | `SessionManager` は v3 を維持。自動マイグレーション+破損行スキップにより完全な互換性を立証（D4） ✅ |
| プロバイダー互換性の問題 | Google Gemini / OpenAI 動作を重点テスト | `/compat` 移行 + `ThinkingLevel` effort マッピング復元により正常動作確認 ✅ |
| 同期パッケージのバージョン不整合 | 4パッケージを同時に更新 | 4パッケージすべて `@earendil-works/* 0.84.2` に統一 ✅ |

---

## 8. 段階的実行 (D0-D5)

### D0: 基盤固定 ✅ 完了

**ベースライン記録** (2026-08-23, SDK 0.65.2 確認):

| チェック | 結果 |
| --- | --- |
| `tsgo --noEmit --singleThreaded --checkers 1` | **0 errors** ✅ |
| channels contracts (`vitest.contracts.config.ts` / `src/channels/plugins/contracts/`) | **37 files / 129 tests — all green** ✅（plugins 側 `src/plugins/contracts/` 40 files はゲート対象外） |
| followup-runner (`vitest.auto-reply.config.ts` / `followup-runner.test.ts`) | **1 file / 28 tests — all green** ✅ |
| plugin-activation-boundary (`vitest.unit.config.ts` / `plugin-activation-boundary.test.ts`) | **1 file / 7 tests — all green** ✅ |

**セッション互換テスト**: `src/agents/pi-embedded-runner/session-compatibility.test.ts` を新規作成。
- 方法: SDK 0.65.2 の CURRENT_SESSION_VERSION (=3) で書いた最小 JSONL (header + user + assistant) を `SessionManager.open()` で開き、header/entries/branch/buildSessionContext が正しく読めることを検証。
- 4 テスト: 古いセッション読み込み / バージョン定数安定性 / 旧JSONLへのappend / in-memory session append。
- D1-D4 の各ゲートでこのテストを再実行し、互換性を監視。

**D0 実施記録**:
- `pnpm install` 変更なし（D0 は基盤確認のみ）。
- テスト環境: Kasou mount 上の session lock が一時的に warning を発したが、テスト結果には影響なし。

---

### D1: @mariozechner/* 0.65.2 → 0.73.1 ✅ 完了

- **コミット**: `0f15c7bac76` `[SYNC] PI SDK D1: @mariozechner/* 0.65.2 -> 0.73.1` (日付: 2026-08-24)
- **主要変更点**:
  - `0.68`: `codingTools`/`readTool` の事前エクスポート廃止 → `createCodingTools(cwd)` ファクトリ方式へ移行 (`src/agents/pi-tools.ts`)
  - `0.68`: `createAgentSession` の `tools` 引数が allow-list 化（空配列 `[]` でカスタムツール含む全ツールが無効化される仕様に変更）されたため、`noTools: "builtin"` を導入して旧 `builtInTools: []` セマンティクス（ビルトイン無効、カスタム/拡張ツール維持）を復元
  - `0.69`: TypeBox 移行 — 77ファイルで `@sinclair/typebox` → `typebox` (`^1.1.24`) に切り替え、TSchema → Record 拡幅用 `asSchemaJson()` ヘルパー新設 (`src/agents/schema/typebox.ts`)
  - TypeBox 1.x の `Static<TObject>` が index signature を持たない問題への対処: `readParamRaw`/`readSnakeCaseParamRaw` を `unknown` 受容 + 内部ナローイングへ変更 (`raw-chat`, `memory-core`, `web-search`)
  - Gateway プロトコルプリミティブ: `GatewayClientId`/`Mode` ユニオンを literal tuple 表記に変更 (TypeBox 1.x で mapped union が Static=never に潰れる問題を防止)
  - `Model.compat`: 新設の "deepseek" thinking format を除外リストに追加、openai local compat 構造体を unknown に拡幅
  - zai live test モデル ID をカタログ名 `glm-5-turbo` に更新
- **検証ゲート**:
  - `tsgo --noEmit`: 0 errors
  - channels contracts (`src/channels/plugins/contracts/`): 37 files / 129 tests (all green; plugins 側 40 files は対象外)
  - followup-runner: 28/28 tests pass
  - plugin-activation-boundary: 7/7 tests pass
  - session-compatibility: 4/4 tests pass
  - oxfmt: pass

---

### D2: スコープ移行 @mariozechner/* → @earendil-works/* 0.74.2 ✅ 完了

- **コミット**:
  - `aa92cc17dee` `[SYNC] PI SDK D2: scope migration @mariozechner/* -> @earendil-works/* 0.74.2` (日付: 2026-08-24)
  - `6c4c8c1abf8` `[SYNC] PI SDK D2 follow-up: fix stale node_modules path references` (日付: 2026-08-24)
- **主要変更点**:
  - 旧 `@mariozechner` スコープは 0.73.1 で凍結。0.74.0 よりリポジトリ移管先の `@earendil-works` スコープへ継続。破壊的挙動変更なしの純粋なスコープ名リネーム。
  - `package.json` の PI SDK 4パッケージを `@earendil-works/*@0.74.2` に更新
  - ソースコード全域（`src/`, `extensions/`, `ui/`, `scripts/`）の import specifier を置換（338ファイル）
  - 旧 `@mariozechner/pi-coding-agent` 向け `packageExtensions`（`strip-ansi` シム）を削除（0.74.x では不要）
  - フォローアップ (`6c4c8c1abf8`): `scripts/control-ui-i18n.ts` および `scripts/docs-i18n/pi_command.go` 内の `@mariozechner` への `node_modules` パス結合参照を `@earendil-works` に修正
- **検証ゲート**:
  - `tsgo --noEmit`: 0 errors
  - channels contracts (`src/channels/plugins/contracts/`): 37 files / 129 tests (all green; plugins 側 40 files は対象外)
  - followup-runner: 28/28 tests pass
  - plugin-activation-boundary: 7/7 tests pass
  - session-compatibility: 4/4 tests pass
  - oxfmt: pass

---

### D3: 0.74.2 → 0.84.2 (@earendil-works) ✅ 完了

- **コミット**: `cd30fe9dda9` `[SYNC] PI SDK D3: migrate @mariozechner/* 0.65.2 -> @earendil-works/* 0.84.2` (日付: 2026-08-25, 97 files +1132/-796)
- **主要変更点**:
  - パッケージ更新: `pi-agent-core`, `pi-ai`, `pi-tui`, `pi-coding-agent` → 0.84.2、推移的依存関係（`pi-client`, `pi-protocol`, `pi-telemetry`）を含む `pnpm-lock.yaml` 再生成
  - `/compat` import 移行: `pi-ai` ルートインポートを `/compat` サブパスへ移行 (`streamSimple`, `complete`, `getModel`, `getEnvApiKey`, `getApiProvider`, `registerApiProvider`, `streamAnthropic` 等)
  - `AuthStorage` → `CredentialStore` アダプタ: `src/agents/pi-embedded-runner/auth-storage-adapter.ts` 新設（非同期ミラーの事前投入）、`readStoredCredential` + `ModelRuntime` パターンへ移行
  - `ModelRegistry` & 非同期 `discoverModels`: `ModelRegistry` コンストラクタが `ModelRuntime` を受け取る仕様に変更。`await ModelRuntime.create({credentials, modelsPath})` 経由で `discoverModels` を非同期化。同期 `resolveModel` フォールバックを廃止し、`tools-effective-inventory` を `resolveModelAsync` に移行
  - `streamFn` → `streamFunction`: Agent プロパティ名の変更を runner / harness / tests 全域でリネーム
  - `ThinkingLevel` effort マッピング復元: upstream `c73a6d2f689` parity を **direct トランスポート**で復元（`xhigh` → `opus4.7:"xhigh"` / `opus4.6:"max"` / その他 "high"）。vertex トランスポートは D3 では現状維持（`xhigh` → `opus4.6:"max"` / それ以外 "high"、opus-4.7 は budget-based フォールバック） — 意図的な保持であり、vertex 側の opus-4.7 adaptive 対応は必要なら後続フェーズ
  - `normalizeRegistryModel`: `openai-completions` モデルに対して `detectOpenAICompletionsCompat` のデフォルトを統合（明示的な値が優先）
  - OpenAI Codex OAuth: `openaiCodexOAuth.toAuth()` / `refresh()` を利用した Codex OAuth 移行（ディープな `node_modules` インポートには `TODO(pi-sdk)` マーカー付与）
  - TUI / API プロバイダー / zod スキーマ: `TUI` → `TuiMainScreen`、`clearApiProviders` → `resetApiProviders`、zod スキーマ `thinkingFormat` を SDK `SupportedThinkingFormat` に拡充
  - テストモック `/compat` 対応: `vi.mock("@earendil-works/pi-ai/compat")` をルートモックと併せて追加
  - `piSdkMock` ブリッジ復元: `src/gateway/test-helpers.mocks.ts` で `discoverModels` レイヤーのブリッジを復元（廃止された `MockModelRegistry` オーバーライドを置換）
- **レビュー経過**:
  - 合計 3 ラウンドのレビューを実施。
  - **Round 2**: Major 3件（非同期 `discoverModels` タイミング、thinking level `xhigh` の effort マッピング欠落、OpenAI Codex OAuth リフレッシュ処理）を検出 → 修正反映。
  - **Round 3**: `test-helpers.mocks.ts` 内の `piSdkMock` 孤児ブリッジを検出 → 修正し、差分再判定にて **APPROVE**。
- **検証ゲート**:
  - `tsgo --noEmit`: 0 errors
  - session-compat: 4/4 tests pass
  - activation-boundary: 7/7 tests pass
  - model.test: 38/38 tests pass
  - followup-runner: 27/28 tests pass (1件は Windows 固有のタイムアウト)
  - btw: 13/13 tests pass
  - vertex-stream: 11/11 tests pass
  - voicewake: 11/11 tests pass
  - sessions-a: 47/47 tests pass
  - contracts: 差分ゼロ
  - **Pre-existing failures**: image / zai / workspace-only スイート、auth.test mistral env gap、upstream openrouter/xai プラグインフック3件、followup timeout は SDK アップデート前からの既存問題であることを stash A/B 検証にて確認（SDK 更新による退行なし）。

---

### D4: KASOU 形状セッション互換性テスト・フィクスチャ追加 ✅ 完了

- **コミット**: `33b461a1195` `[SOUL] PI SDK D4: add KASOU-shaped session compatibility tests and fixtures` (日付: 2026-08-25, +514 lines)
- **目的**: 旧バージョン (0.65.2, v2/v3 ツリー形式) で書き出された実運用相当の session JSONL が `@earendil-works/* 0.84.2` で安全に読み込み・追記・修復できるかを検証
- **新規テスト & フィクスチャ**:
  - `src/agents/pi-embedded-runner/kasou-session-compat.test.ts` (7テストケース)
    1. 通常の親チェーン構造の復元 (Plain parent chains)
    2. カスタムメタデータ混在エントリーの透過 (Custom-entry passthrough: model-snapshot, thinking/model 変更)
    3. 孤立行・末尾破損行への耐性 (Orphan & torn-line resilience)
    4. session-file-repair との協調動作 (`droppedLines=2` + `.bak` 生成)
    5. `updateLastRoute` / `readSessionUpdatedAt` / エンベロープコンテキストの往復
    6. 追加書き込み + 再読み込み時の非破壊性 (append + reload non-destructiveness)
    7. v2 `hookMessage` の v3 自動マイグレーション
  - `src/agents/pi-embedded-runner/__fixtures__/kasou-sessions/`
    - `pattern-a-plain-chain.jsonl`: プレーンな会話チェーン
    - `pattern-b-custom-mixed.jsonl`: カスタムメタデータ混交
    - `pattern-c-corrupted.jsonl`: 破損・孤立・末尾分断
- **重要な発見 (Key Finding)**:
  - **`SessionManager` は `CURRENT_SESSION_VERSION = 3` を維持**:
    調査の結果、`@earendil-works/pi-coding-agent` の `SessionManager` は依然としてバージョン 3 で動作していることが判明。v4 lane-based モデルは `pi-agent-core` の harness 層のみに存在し、DennouAibou ランタイムでは一切使用されていない。
  - **自動マイグレーション & 破損耐性**:
    SDK 内部に v1 → v2 → v3 の自動マイグレーション機構および不正行/破損行のスキップ処理が標準装備されているため、既存 KASOU セッション JSONL は読み書きともに完全に安全（確信度 99.9%、SDK dist コード行で実証）。
  - **総括**: 当初想定された「v4 への全面書き換えに伴うセッション互換性喪失リスク」は過大評価であったと素直に記録。
- **レビュー経過**:
  - 正式 code-reviewer により **APPROVE** (Major 0件)。
  - レビューで指摘された Nit 5件（provenance コメント追記、persist 挙動の注記、toolName/timestamp アサーション強化、route 読み戻しアサーション追加、torn-tail 改行除去）をすべて反映・polish 完了。
- **検証ゲート**:
  - vitest: `kasou-session-compat.test.ts` 7/7 pass, `session-compatibility.test.ts` 4/4 pass
  - tsgo: 0 errors
  - oxfmt: pass
  - フィクスチャ SHA256 安定性確認済み

---

### D5: ドキュメント更新・総括 ✅ 完了

- **日付**: 2026-08-25
- **内容**: 本ドキュメント (`DENNOU_DOCS/PHASE_D_PI_SDK_UPDATE.md`) の更新および Phase D の全行程総括。
- **実施事項**:
  - D1〜D4 のコミット SHA、日付、詳細な変更点、レビュー経過の反映
  - SessionManager v3 維持に関する事実および確信度の明記
  - 既知の残項目（未プッシュ状態、フィクスチャのプレースホルダ、既存タイムアウト等）の整理
  - 参考資料リンクの `@earendil-works` への更新

---

## 9. 既知の残項目

後続作業および Phase E（デプロイ）に向けて留意すべき事項：

1. **リモートプッシュの保留**:
   - `feature/pi-sdk-update` ブランチのコミット群（D1〜D5）はリモートへのプッシュを一括保留中（ユーザーからの明示合図待ち）。
2. **フィクスチャの `agent-boundary` customType**:
   - `kasou-sessions` フィクスチャ内の `agent-boundary` `customType` は合成プレースホルダ（実機サンプル未収録）。
   - 後続フェーズにて、KASOU 実機由来の 1 行サンプルを取り込み推奨（テストヘッダーに TODO 記録済み）。
3. **Gateway hook タイムアウト (180s)**:
   - `test-helpers.server.ts:445` の `cleanupGatewayTestHome` における `fs.rm` 滞留によるタイムアウトは既存問題（pre-existing）。
   - D3 の SDK 更新とは無関係（stash A/B テストにて立証済み）。
4. **run-tsgo.mjs の Windows パス空白問題**:
   - リポジトリパスに空白が含まれる環境（例: `OpenClaw Related Repos`）で `run-tsgo.mjs` が引数解釈に失敗する場合がある。
   - `node_modules/.bin/tsgo` 直呼び、または `npx tsgo` の使用を推奨。
5. **KASOU 本番デプロイ（Phase E 相当）**:
   - KASOU 本番環境への反映は後続フェーズにて実施。
   - デプロイ手順: `systemctl --user stop openclaw-gateway.service` → `dist` オーバーレイ → `systemctl --user start openclaw-gateway.service` → HTTP 200 (`/` および `/logs`) & Telegram 疎通確認 (#1112)。

---

## 10. 実施記録

| 日付 | コミット | 内容 | 状態 |
| ---- | -------- | ---- | ---- |
| 2026-08-23 | - | D0: 基盤固定。ベースライン全green確認、セッション互換テスト新規作成(4/4 pass) | ✅ 完了 |
| 2026-08-24 | `0f15c7bac76` | D1: @mariozechner/* 0.65.2 → 0.73.1 (TypeBox移行、noTools対応、互換テスト新設) | ✅ 完了 |
| 2026-08-24 | `aa92cc17dee`<br>`6c4c8c1abf8` | D2: スコープ移行 @mariozechner/* → @earendil-works/* 0.74.2 (import 一括置換、node_modules 参照修正) | ✅ 完了 |
| 2026-08-25 | `cd30fe9dda9` | D3: @earendil-works/* 0.84.2 へ移行 (97 files, /compat 移行, CredentialStore アダプタ, ModelRuntime 非同期化, streamFunction, xhigh 復元, Codex OAuth) | ✅ 完了 |
| 2026-08-25 | `33b461a1195` | D4: KASOU 形状セッション互換性テスト・フィクスチャ追加 (7/7 pass, SessionManager v3 維持の立証) | ✅ 完了 |
| 2026-08-25 | - | D5: Phase D ドキュメント更新・総括・残項目整理 | ✅ 完了 |

---

## 11. 参考資料

- PI SDK ドキュメント: `docs/pi.md`（プロジェクト内）
- PI SDK GitHub: `https://github.com/earendil-works/pi-mono`
- npm packages:
  - `@earendil-works/pi-agent-core`: `https://www.npmjs.com/package/@earendil-works/pi-agent-core`
  - `@earendil-works/pi-ai`: `https://www.npmjs.com/package/@earendil-works/pi-ai`
  - `@earendil-works/pi-coding-agent`: `https://www.npmjs.com/package/@earendil-works/pi-coding-agent`
  - `@earendil-works/pi-tui`: `https://www.npmjs.com/package/@earendil-works/pi-tui`

# Phase D: PI SDK Update — @mariozechner/pi-coding-agent アップデート

> **目標**: DennouAibou のコアエンジンである `@mariozechner/pi-coding-agent` を v0.65.2 → 最新版へ更新
> **工数目安**: 1-2日（互換性テスト含む）
> **前提**: Phase A-C 完了後（または並行可能）

---

## 1. 現状

| 項目 | 値 |
|---|---|
| **パッケージ名** | `@mariozechner/pi-coding-agent` |
| **現在のバージョン** | `0.65.2` |
| **最新版（npm）** | `0.73.1` |
| **差分** | minor version にわたる変更 |
| **import 数** | ソースコード内 **68箇所** |

### 同期パッケージ

| パッケージ | 現在 | 備考 |
|---|---|---|
| `@mariozechner/pi-agent-core` | 0.65.2 | エージェントループ |
| `@mariozechner/pi-ai` | 0.65.2 | LLM抽象化 |
| `@mariozechner/pi-tui` | 0.65.2 | TUIコンポーネント |

---

## 2. PI SDK と DennouAibou の関係

### アーキテクチャ

```
┌─────────────────────────────────────────────────┐
│  DennouAibou Gateway (port 18789)               │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │  @mariozechner/pi-coding-agent (SDK)    │    │
│  │  ├─ createAgentSession()                │    │
│  │  ├─ SessionManager                      │    │
│  │  ├─ ModelRegistry / AuthStorage         │    │
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
|---|---|
| `src/agents/pi-embedded-runner/` | エージェント実行のメインエントリ |
| `src/gateway/server-methods/chat.ts` | チャットメッセージ処理 |
| `src/agents/compaction.ts` | セッション圧縮 |
| `src/config/sessions/` | セッション管理 |
| `src/agents/command/` | コマンド実行 |

---

## 3. 更新の理由

1. **セキュリティ**: 0.65.2 → 0.73.1 の間にセキュリティ修正が含まれる可能性
2. **バグ修正**: 上流のバグ修正を適用
3. **新機能**: 新しいプロバイダー対応、ツール追加等
4. **依存関係**: 同期パッケージ（pi-agent-core, pi-ai, pi-tui）の整合性維持

---

## 4. 更新手順

### Step 1: 変更内容の確認

```bash
# CHANGELOG を確認
# https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent
# の CHANGELOG.md を参照

# 現在の依存関係を確認
cd "D:\GitHub\OpenClaw Related Repos\DennouAibou"
cat package.json | grep -A2 "pi-agent-core\|pi-ai\|pi-coding-agent\|pi-tui"
```

### Step 2: バージョン更新

```bash
# 4パッケージを同時に更新（バージョン整合性維持）
pnpm add @mariozechner/pi-agent-core@latest @mariozechner/pi-ai@latest @mariozechner/pi-coding-agent@latest @mariozechner/pi-tui@latest
```

**注意**: 4パッケージは同じバージョンに揃えること。バージョンが混在するとビルドエラーになる可能性あり。

### Step 3: ビルド確認

```bash
pnpm build 2>&1 | tee build-after-update.log
```

### Step 4: 型エラー修正

更新後に型エラーが出る可能性がある。主なチェックポイント：

- `createAgentSession()` のシグネチャ変更
- `SessionManager` のメソッド名変更
- `Model` / `ModelRuntime` の型定義変更
- インポートパスの変更

### Step 5: テスト確認

```bash
pnpm test 2>&1 | tee test-after-update.log
```

### Step 6: KASOU での検証

```bash
# ビルド → デプロイ → gateway 起動 → Telegram 応答確認
```

---

## 5. 破壊的変更への対応

### 5.1 確認すべき CHANGELOG エントリ

v0.65.2 以降の変更で確認が必要なもの：

| バージョン範囲 | 確認事項 |
|---|---|
| 0.65.x → 0.66.x | `createAgentSession()` のオプション変更 |
| 0.66.x → 0.68.x | `SessionManager` のAPI変更 |
| 0.68.x → 0.70.x | `Model` / `ModelRuntime` の型変更 |
| 0.70.x → 0.73.x | インポートパスの変更、新機能 |

### 5.2 回退戦略

```bash
# 更新が壊れた場合、元のバージョンに戻す
pnpm add @mariozechner/pi-agent-core@0.65.2 @mariozechner/pi-ai@0.65.2 @mariozechner/pi-coding-agent@0.65.2 @mariozechner/pi-tui@0.65.2
```

---

## 6. 検証基準

- [ ] `pnpm build` がエラーなしで通る
- [ ] `pnpm test` が通る（既存失敗が増えない）
- [ ] TypeScript strict mode でエラーなし
- [ ] KASOU デプロイ後、gateway が起動し `/` `/logs` で HTTP 200
- [ ] Telegram 応答が正常
- [ ] セッション管理（/new, /reset, /sessions）が正常
- [ ] プロバイダー切り替え（/model）が正常

---

## 7. リスク

| リスク | 対策 |
|---|---|
| PI SDK の API 変更でコンパイルエラー | CHANGELOG で事前確認、型エラーを個別修正 |
| セッション形式の変更で既存セッションが読めなくなる | 更新前にバックアップ、形式変更の有無を確認 |
| プロバイダー互換性の問題 | Google Gemini の動作を重点的にテスト |
| 同期パッケージのバージョン不整合 | 4パッケージを同時に更新 |

---

## 8. 実施記録

| 日付 | 内容 | 状態 |
|---|---|---|
| | | |

---

## 9. 参考資料

- PI SDK ドキュメント: `docs/pi.md`（プロジェクト内）
- PI SDK GitHub: `https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent`
- npm: `https://www.npmjs.com/package/@mariozechner/pi-coding-agent`

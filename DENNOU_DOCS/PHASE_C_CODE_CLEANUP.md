# Phase C: Code Cleanup — コードクリーンアップ

> **目標**: 型エラー修正、dead code 除去、テスト整理、コード品質向上
> **工数目安**: 1-2日
> **前提**: Phase A (Branding) と Phase B (Debloat) 完了後

---

## 1. 対象エリア

### 1.1 型エラー修正

#### @line/bot-sdk TS2305 問題

- **原因**: debloat 後の `pnpm install` で `@line/bot-sdk` が ^11.0.0 → 11.2.0 に更新され、型定義が不整合
- **影響**: `pnpm build:plugin-sdk:dts` が `extensions/line` の型エラーで失敗
- **対策**:
  - **Option A**: `@line/bot-sdk` を pin 戻し（`pnpm add @line/bot-sdk@10.6.0`）→ **注意**: メジャーバージョンダウン（11→10）。v10 と v11 の API 差分を確認し、line extension が v11 の機能を使っていないか検証が必要
  - **Option B**: line extension の型修正（`@line/bot-sdk` の型定義を更新）
  - **Option C**: line extension を削除（KASOU で未使用なら）→ **前提**: KASOU で line チャンネルが使用されていないことを確認

#### その他の型エラー

- `pnpm build` 実行で特定
- TypeScript strict mode でのエラーを修正

### 1.2 Dead Code 除去

#### 未使用ファイル（実在確認済み）

| ファイル | 状態 | 対策 |
|---|---|---|
| `src/agents/byteplus-models.ts` | **実在**（import元なし） | 削除 |
| `src/agents/chutes-oauth.ts` | **実在**（chutes extension 削除後） | 削除 |
| `src/agents/chutes-oauth.test.ts` | **実在**（孤児テスト） | 削除 |
| `src/agents/chutes-oauth.flow.test.ts` | **実在**（孤児テスト） | 削除 |
| `tmp-generated-schema.ts` | ビルド一時ファイル | 削除 |
| `tmp-rendered-schema.ts` | ビルド一時ファイル | 削除 |
| `InstallationLog.txt` | インストールログ | 削除 |
| `filter-*.jq` | デバッグ用スクリプト | 削除 |

#### Dead Code 検出手順

```bash
# 1. TypeScript の未使用インポート検出
pnpm exec tsc --noEmit 2>&1 | grep "is declared but"

# 2. ESLint で未使用変数検出
pnpm exec eslint src/ --rule '{"no-unused-vars": "error"}'

# 3. 削除済み extension を参照する import を検出
rg "from.*extensions/(chutes|byteplus|kilocode|opencode-zen)" src/ --type ts
```

### 1.3 テスト整理

#### 孤児テスト（実在確認済み）

| テストファイル | 参照先 | 状態 | 対策 |
|---|---|---|---|
| `src/agents/chutes-oauth.test.ts` | `chutes-oauth.ts` | **実在** | 削除 |
| `src/agents/chutes-oauth.flow.test.ts` | `chutes-oauth.ts` | **実在** | 削除 |

**注意**: Phase B で `byteplus-models.ts` を削除した場合、関連テストも削除対象になる可能性あり。

#### テスト fixture の整理

- `provider-runtime-contract.ts`: kept (google/openai) のみに整理済み
- `registry.retry.test.ts`: neutral id に書き換え済み
- 残りの削除済みプロバイダー参照を確認

### 1.4 コードスタイル統一

- `prettier` でフォーマット統一（`pnpm format`）
- 未使用の `// @ts-ignore` / `// @ts-expect-error` を除去
- 不要な `console.log` / `debugger` 文を除去

---

## 2. 実施手順

### Step 1: ビルドエラーの特定

```bash
pnpm build 2>&1 | tee build-errors.log
```

### Step 2: テストエラーの特定

```bash
pnpm test 2>&1 | tee test-errors.log
```

### Step 3: 型エラー修正

1. `@line/bot-sdk` 問題の解決（上記 Option A/B/C から選択）
2. 残りの型エラーを個別修正

### Step 4: Dead Code 除去

1. 上記リストの未使用ファイルを削除
2. 未使用インポートの除去（ESLint / tsc で検出）
3. テストの整理

### Step 5: フォーマット統一

```bash
pnpm format
```

### Step 6: 最終テスト

```bash
pnpm build && pnpm test
```

---

## 3. 検証基準

- [ ] `pnpm build` がエラーなしで通る
- [ ] `pnpm build:plugin-sdk:dts` が通る
- [ ] `pnpm test` が通る（既存失敗が増えない）
- [ ] `pnpm test:contracts` の pre-existing 失敗が減る（増えない）
- [ ] TypeScript strict mode でエラーなし
- [ ] ESLint / Prettier で警告なし
- [ ] KASOU デプロイ後、全機能が正常動作

---

## 4. リスク

| リスク | 対策 |
|---|---|
| dead code 削除で依存コードが壊れる | grep で使用箇所を確認してから削除 |
| テスト削除でカバレッジが下がる | 削除対象は孤児テストのみ（本番コードを参照しないことを確認済み） |
| 型修正で既存機能に影響 | 修正後に全テストを実行 |

---

## 5. 実施記録

| 日付 | 内容 | 状態 |
|---|---|---|
| | | |

---

## 6. 判断待ち項目

1. **@line/bot-sdk**: pin 戻し（v10）？ 型修正？ 削除？（line extension の KASOU 使用有無を確認要）

# 2026-04-23 実装コミット詳細レポート（Compaction系）

## 0. 対象範囲

- Repository: `DennouAibou`
- Branch: `main`
- 対象コミット:
  1. `04c82dcf2b` — `[SYNC] Reapply Pi compaction settings after loader reload and cap reserve floor`
  2. `e0328bc259` — `[FIX-UPSTREAM] Align safeguard summary cap with keepRecentTokens`
  3. `bc5963c41b` — `[FIX] Respect configured reserveTokens for timeout compaction threshold`

---

## 1. 何を解決したか（要点）

### 問題A: `resourceLoader.reload()` 後に compaction 設定が落ちる

- `DefaultResourceLoader.reload()` 後に、先に適用した compaction override が消える経路があった。
- 対応として、reload 後に `applyPiCompactionSettingsFromConfig(...)` を再適用するように統一。

### 問題B: small-context モデルで reserve floor が強すぎる

- context window が小さい時、固定 floor が prompt 余地を圧迫する。
- `contextTokenBudget` を受け取り、`MIN_PROMPT_BUDGET_RATIO` / `MIN_PROMPT_BUDGET_TOKENS` で安全上限をかける方式へ。

### 問題C: safeguard summary cap が固定 16k 相当で `keepRecentTokens` と連動しない

- summary cap を `keepRecentTokens` 連動の可変値に変更。
- 過大化防止の上限（dynamic hard max）も維持。

### 問題D: timeout-compaction が固定 65% 判定で、ユーザー設定 reserveTokens と乖離

- 旧実装は `tokenUsedRatio > 0.65` で compaction へ進む。
- 新実装は `reserveTokens` から閾値を計算し、設定優先で timeout-compaction を判定。

---

## 2. コミット別の実装詳細

## 2.1 `04c82dcf2b` `[SYNC]`

### 変更ファイル

- `src/agents/pi-compaction-constants.ts`（新規）
- `src/agents/pi-embedded-runner/compact.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-project-settings.ts`
- `src/agents/pi-settings.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-embedded-runner/run/attempt.spawn-workspace.test-support.ts`

### 実装ポイント

1. **compaction予算定数を共通化**
   - `src/agents/pi-compaction-constants.ts:6-12`
   - `MIN_PROMPT_BUDGET_TOKENS=8000`, `MIN_PROMPT_BUDGET_RATIO=0.5` を導入。

2. **small-context向けの reserve floor cap**
   - `src/agents/pi-settings.ts:79-89`
   - `contextTokenBudget` を使って `maxReserve = ctxBudget - minPromptBudget` を計算し、floor を cap。

3. **`resourceLoader.reload()` 後の再適用（compaction設定落ち防止）**
   - `src/agents/pi-embedded-runner/compact.ts:756-763`
   - `src/agents/pi-embedded-runner/run/attempt.ts:848-855`
   - どちらの経路でも reload 後に `applyPiCompactionSettingsFromConfig(...)` を実行。

4. **run経路から budget を attempt 側へ確実に伝搬**
   - `src/agents/pi-embedded-runner/run.ts:564`
   - `src/agents/pi-embedded-runner/run/attempt.spawn-workspace.test-support.ts:807`

5. **テスト拡張**
   - `src/agents/pi-settings.test.ts:186-233`, `261-307`
   - small-context時の cap / uncapped 条件 / fallback の振る舞いを追加検証。

---

## 2.2 `e0328bc259` `[FIX-UPSTREAM]`

### 変更ファイル

- `src/agents/pi-embedded-runner/extensions.ts`
- `src/agents/pi-hooks/compaction-safeguard-runtime.ts`
- `src/agents/pi-hooks/compaction-safeguard.ts`
- `src/agents/pi-hooks/compaction-safeguard.test.ts`

### 実装ポイント

1. **runtime に `keepRecentTokens` を通す**
   - `src/agents/pi-embedded-runner/extensions.ts:100-103`
   - safeguard runtime へ `keepRecentTokens` を注入。

2. **runtime 型の受け口追加**
   - `src/agents/pi-hooks/compaction-safeguard-runtime.ts:17-19`
   - `keepRecentTokens?: number` を明示。

3. **summary cap を keepRecent 連動へ**
   - `src/agents/pi-hooks/compaction-safeguard.ts:296-307`
   - `resolveCompactionSummaryMaxChars(keepRecentTokens)` で動的決定。
   - 実適用は `src/agents/pi-hooks/compaction-safeguard.ts:698`。

4. **テスト追加**
   - `src/agents/pi-hooks/compaction-safeguard.test.ts:292-304`（budget解決ロジック）
   - `src/agents/pi-hooks/compaction-safeguard.test.ts:620-623`（runtime注入確認）

---

## 2.3 `bc5963c41b` `[FIX]`

### 変更ファイル

- `src/agents/pi-settings.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-embedded-runner/run.timeout-triggered-compaction.test.ts`

### 実装ポイント

1. **新関数追加: timeout判定閾値を reserveTokens 由来で計算**
   - `src/agents/pi-settings.ts:125-163`
   - `resolveTimeoutCompactionPromptUsageThreshold(...)` を追加。
   - `reserveTokens` 未設定時のみ fallback `0.65` を使う。

2. **run経路で新閾値を利用**
   - `src/agents/pi-embedded-runner/run.ts:225-230`
   - `src/agents/pi-embedded-runner/run.ts:711-716`
   - 判定を `tokenUsedRatio > timeoutCompactionPromptUsageThreshold` へ変更し、ログに実閾値を出力。

3. **テスト拡張**
   - `src/agents/pi-settings.test.ts:329-371`
     - fallback 0.65
     - 1M/128k → 0.872
     - floor 優先ケース
   - `src/agents/pi-embedded-runner/run.timeout-triggered-compaction.test.ts:200-231`
     - 70% timeout でも reserveTokens=128k なら compaction しないことを検証。

---

## 3. 検証ログ（当日実行）

1. **対象テスト実行**
   - Command:
     - `bun scripts/run-vitest.mjs run --config vitest.config.ts src/agents/pi-settings.test.ts src/agents/pi-embedded-runner/run.timeout-triggered-compaction.test.ts`
   - Result:
     - `Test Files 2 passed`
     - `Tests 34 passed`

2. **コードレビュー（subagent）**
   - `code-reviewer` で差分レビュー実施。
   - Findings: blocker/high/medium/low なし（Approve）。

---

## 4. デプロイ実施メモ（時間短縮のための事前処理）

> 本項は「コミット実装そのもの」ではなく、同日デプロイ運用の記録。

- ローカルPC側で tgz を事前作成し、Kasou 側の重い build を省略する方式を採用。
- Kasou では tgz をグローバル install。
- その後、user systemd の unit が旧 `.npm-global` パスを保持していたため、
  - `openclaw node install --force`
  - `openclaw gateway install --force`
  で unit を再生成して整合。
- 最終的に `openclaw-node.service` / `openclaw-gateway.service` は `active` を確認。

---

## 5. 既知の残課題（今回スコープ外）

- `episodic-claw` の依存欠落（`stopwords-iso`）によりプラグインロード警告が残る。
- これは今回の compaction 閾値修正とは別の運用課題。

---

## 6. まとめ

- `04c82dcf2b` で **reload 後設定落ち + small-context floor問題** を修正。
- `e0328bc259` で **safeguard summary cap を keepRecentTokens 連動化**。
- `bc5963c41b` で **timeout-compaction 判定を固定65%から reserveTokens 優先へ移行**。

結果として、`contextTokens=1,000,000` / `reserveTokens=128,000` の設定意図（約87.2%付近まで保持）に沿った挙動へ近づけた。

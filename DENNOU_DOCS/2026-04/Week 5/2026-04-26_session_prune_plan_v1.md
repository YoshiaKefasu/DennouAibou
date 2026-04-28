# 2026-04-26 Session File Auto-Prune Plan

## 0. 目的

- DennouAibouのエージェントセッションJSONLファイルが、ツール出力の蓄積により肥大化する問題を解決する。
- ただし、アクティブセッションの破損リスクを実用レベルまで下げた安全な方法で行う。
- `contextPruning` の設定ロジックを流用し、ディスク上のJSONLにも自動Pruneを適用する。

---

## 1. 現状分析

### 証拠1: JSONLファイルの肥大化実態

`Y:\kasou_yoshia\.openclaw\agents\main\sessions` 配下のファイルを見ると：

- `2f65d209-....jsonl.deleted.*` → **223KB**（閉じたセッション）
- ツール出力がそのまま残り続け、削除されたファイルでもディスクを占有する

### 証拠2: ランタイムPruningはディスク保存に影響しない

`openclaw.json:120-129` の `contextPruning` 設定は、LLMにプロンプトを送る直前のフィルタリングのみを制御する。ディスク上のJSONLは無傷のまま。

### 証拠3: 既存の類似パターン（WAL rotate）

`episodic-claw` のWAL rotateパターン（rotate → copy → delete）は、ファイルを直接書き換えずに安全にデータを整理する実績がある。

---

## 2. 設計方針

### 2.1 アーキテクチャ原則

- **DennouAibou独自機能**：OpenClaw本体には影響させない。`src/dennou-soul/` 以下に隔離（Rule 1: Encapsulation）。
- **設定はcontextPruningと独立**：ランタイムの `contextPruning` 設定を継承するのではなく、専用の設定キー `pruneSessionToolOutputs` を新設する。
- **不可逆操作を前提**：JSONLから消したツール出力は二度と戻せない。プレースホルダ行を残す。

### 2.2 安全機構（5層防御）

| # | 機構 | 説明 | 危険度低減効果 |
|---|---|---|---|
| 1 | **Idle Time Guard** | ファイルの最終更新時刻から `idleThresholdMinutes` 経過していないセッションは絶対に触らない | 書き込み中のファイル破損を防止 |
| 2 | **Copy-on-Rotate** | 直接編集せず、リネーム → 読み取り → 新ファイル書き出し → 旧ファイル削除の順で処理 | 書き込み中プロセスに影響しない |
| 3 | **Keep Last Entries** | セッション末尾の最新Nエントリは絶対にPruneしない | 直近の重要な文脈を保護 |
| 4 | **Lock / 排他制御** | `state.db` もしくは専用 `.prune.lock` で二重起動防止 | 同時実行による競合を防止 |
| 5 | **Dry-Run 段階的導入** | 初期は `dryRun: true` でログ出力のみ、実際の削除は行わない | 誤動作を事前に検出できる |

---

## 3. 設定スキーマ

```typescript
// src/types.ts または src/dennou-soul/types.ts に追加
export interface DennouSessionPruneConfig {
  enabled: boolean;
  /** Prune対象とするファイルのパターン */
  targetFiles: "all" | "closed-only" | "closed-and-idle";
  /** アイドル判定の閾値（分）。最終更新からこの時間が経過していないファイルは触らない */
  idleThresholdMinutes: number;
  /** Prune間隔（分）。定期実行のインターバル */
  intervalMinutes: number;
  /** ツール出力のTTL（分）。この時間より古い出力はPrune対象 */
  ttlMinutes: number;
  /** この文字数未満のツール出力は絶対にPruneしない */
  minPrunableToolChars: number;
  /** セッション末尾から保護するエントリ数 */
  keepLastEntries: number;
  /** Prune後のプレースホルダテキスト */
  placeholder: string;
  /** Dry-runモード。trueの場合、実際の削除は行わずログに出力するのみ */
  dryRun: boolean;
}
```

### デフォルト値

```json
{
  "pruneSessionToolOutputs": {
    "enabled": false,
    "targetFiles": "closed-and-idle",
    "idleThresholdMinutes": 15,
    "intervalMinutes": 60,
    "ttlMinutes": 5,
    "minPrunableToolChars": 1200,
    "keepLastEntries": 5,
    "placeholder": "[Session file pruned — tool output removed by DennouAibou auto-prune]",
    "dryRun": true
  }
}
```

---

## 4. 対象ファイルとPrune条件

### 対象ファイル

```
~/.openclaw/agents/{agentId}/sessions/*.jsonl
~/.openclaw/agents/{agentId}/sessions/*.jsonl.deleted.*
~/.openclaw/agents/{agentId}/sessions/*.jsonl.reset.*
```

### Prune条件

1. `targetFiles` に応じて対象をフィルタ
   - `closed-only`: `*.deleted.*` と `*.reset.*` のみ
   - `closed-and-idle`: 上記＋アイドル状態のアクティブセッション（`.jsonl`）
   - `all`: アイドル状態を無視して全ファイル（非推奨）
2. ファイルの最終更新時刻が `idleThresholdMinutes` より新しい場合はスキップ
3. JSONLの各行を解析し、以下の条件をすべて満たすエントリをPrune
   - Tool CallまたはTool Resultエントリである
   - 作成時刻が `ttlMinutes` より古い
   - 文字数が `minPrunableToolChars` 以上
   - セッション末尾から `keepLastEntries` 以内でない
4. Pruneされた行はプレースホルダ行に置き換える

### 安全な処理手順（Copy-on-Rotate）

```
1. 対象JSONLの存在確認
2. 最終更新時刻チェック（idleThresholdMinutes）
3. Lock取得（state.db または .prune.lock）
4. 元ファイルをリネーム: xxx.jsonl → xxx.jsonl.pruning
5. リネーム後のファイルを1行ずつ読み取り
   - Prune条件に合致 → プレースホルダ行を書き出し or スキップ
   - 条件に合致しない → そのまま書き出し
6. 新しいファイルを元のパスに書き出し: xxx.jsonl
7. xxx.jsonl.pruning を削除
8. Lock解放
```

---

## 5. 実装フェーズ

### Phase 1: 設定＋型定義（見積：小）

- `src/types.ts` に `DennouSessionPruneConfig` 追加（DennouAibou独自のため隔離）
- `src/config.ts` にデフォルト値と設定読み込み追加
- `src/dennou-soul/prune-sessions.ts` 作成

### Phase 2: Pruneエンジン本体（見積：中）

- `pruneSessionFile()` 関数の実装
  - JSONLのパース（各行をJSONパースして種別判定）
  - 時刻比較によるTTL判定
  - 文字数比較
  - Copy-on-Rotate処理
- `pruneAllSessions()` 関数：全エージェントの全セッションに対して繰り返し

### Phase 3: 定期実行スケジューラ（見積：中）

- `startSessionPruneScheduler()` 関数
- `setInterval` で `intervalMinutes` ごとに `pruneAllSessions()` を呼ぶ
- エラー発生時は次回実行を待つ（リトライしない）
- `stopSessionPruneScheduler()` で停止可能

### Phase 4: Dry-Run → 本番切替

- `dryRun: true` で1週間運用
- ログを確認して誤検知がないことを確認
- `dryRun: false` に切り替えて本番運用開始

---

## 6. ロールバック計画

- **設定のみ**: `enabled: false` で機能停止。既存データには影響しない。
- **実装全体**: `src/dennou-soul/prune-sessions.ts` を削除。設定キーごと削除。
- **Prune済みファイルの復元**: **不可逆**。バックアップ戦略が必要な場合は事前に別途検討。

---

## 7. 未確定事項（要議論）

1. **バックアップ戦略**: Prune前のファイルを `.pruned-backup/` に退避するか？
2. **設定の保存場所**: `openclaw.json` にDennouAibou独自キーを追加するか、別ファイルにするか？
3. **OpenClawアップストリーム同期との関係**: この機能は常にDennouAibou独自のまま。Rule 1（Encapsulation）に従い、コアファイルには触れない。

---

## 8. 参考

- `contextPruning` 設定: `openclaw.json:120-129`
- WAL rotateパターン: `episodic-claw/src/storage/wal/` のrotate/deleteパターン
- DENNOU_RULES.md Rule 1（Encapsulation）、Rule 2（Smart Debloating）

---

## 🔧 Pro Engineer Review — 2026-04-28
> Perspective: Google / IBM Production Engineering
> Principles applied: YAGNI · KISS · DRY · SOLID
> Source code verified: ✅ (as of 2026-04-28)

### 📍 Current Reality (Source Code vs. Document)

**読み込んだファイル：**
- `src/agents/pi-hooks/context-pruning/pruner.ts` (382行) — ランタイムContextPruning実装
- `src/infra/heartbeat-runner.ts` L303-353 — `pruneHeartbeatTranscript()` / `captureTranscriptState()`
- `src/infra/heartbeat-runner.transcript-prune.test.ts` (114行)
- `src/config/sessions/store.pruning.integration.test.ts` (411行)
- `src/config/sessions/store-maintenance.ts` — `pruneStaleEntries`, `pruneAfterMs`, `maxDiskBytes`
- `src/config/sessions/disk-budget.ts` — ディスクバジェット oldest-first cleanup
- `src/cron/session-reaper.ts` — cron run session 自動reap
- `src/sessions/` ディレクトリ構造 (17ファイル, `dennou-soul/` は不在)
- `DENNOU_RULES.md`
- `episodic-claw/src/segmenter.ts` — WAL rotate の実装箇所

**乖離一覧：**

- ⚠️ **重大: 上流に既にセッション管理機構が存在** — プランの証拠2は「ディスク上のJSONLは無傷のまま」と主張するが、実際には上流が以下の4つのディスクレベルpruning機構を持つ:
  1. `store-maintenance.ts` — `pruneAfter` (時間ベース), `maxEntries` (数ベース) でstaleセッションを自動削除し `.deleted.*` にアーカイブ
  2. `disk-budget.ts` — `maxDiskBytes` / `highWaterBytes` によるoldest-first eviction
  3. `session-reaper.ts` — cron run sessionの自動sweep/prune
  4. `heartbeat-runner.ts` L308-325 — HEARTBEAT_OK時に `fs.truncate()` でtranscriptをpre-heartbeatサイズに切り詰め

  **プランの「ディスクは無傷」は行レベルのツール出力pruningに限っては正しいが、セッションファイル全体のライフサイクル管理は既に上流が積極的に行っている。** この事実を無視するとCopy-on-Rotateと上流archivingの同時実行で競合→データロスのリスクがある。

- ⚠️ **`src/dennou-soul/` ディレクトリは存在しない** — `list_dir` で確認済み。Phase 1で「`src/dennou-soul/prune-sessions.ts` 作成」とあるが、ディレクトリごと新規作成が必要。DENNOU_RULES.md Rule 1は推奨するが、DennouAibou全体でまだ一度もこのパターンが使われていない点に注意。

- ⚠️ **WAL rotateの参照パスが誤り** — プランは `episodic-claw/src/storage/wal/` を参照するが、実際のrotateロジックは `episodic-claw/src/segmenter.ts` の `walRotateForFlush()` メソッド (L168-210)。

- ⚠️ **`contextPruning` の参照行番号が古い可能性** — プランの `openclaw.json:120-129` は実際のJSON設定ファイルの行番号だが、contextPruning の設定スキーマは `src/config/types.agent-defaults.ts` L24-106 と `src/config/defaults.ts` L337 に定義されている。ランタイム実装は `src/agents/pi-hooks/context-pruning/pruner.ts`。

- ✅ Document matches code: JSONLの行構造（role, content, toolName等）はセッションtranscriptの実際のフォーマットと一致
- ✅ Document matches code: Rule 1 Encapsulation方針はDENNOU_RULES.mdと整合

### 🎯 Core Problem (1 sentence)
> セッションJSONLの**行レベルのツール出力肥大化**を安全にpruneしたいが、上流が既に持つ4つのセッション管理機構との競合を考慮せずに独自Copy-on-Rotateを導入すると、設計の重複と実行時の競合リスクを生む。

### 🔍 Principle Filter
| Check | Result | Note |
|-------|--------|------|
| YAGNI — Is this actually needed now? | ⚠️ 部分的にYes | 行レベルpruneは上流にない。ただし `targetFiles: "all"` モードや独自スケジューラは過剰 |
| KISS — Is there a simpler solution? | ⚠️ Simpler exists | 閉じたセッション限定なら上流との競合ゼロ。スケジューラも不要にできる |
| DRY — Any duplication to eliminate? | ⚠️ Found | `minPrunableToolChars`, `placeholder` は上流 `EffectiveContextPruningSettings` の `minPrunableToolChars`, `hardClear.placeholder` と概念重複。設定の二重管理が発生する |
| SOLID — Any violation causing real problems? | ✅ None | `pruneSessionFile()` と `pruneAllSessions()` の責務分離は適切 |

### 🛤️ Solution Options

#### Option A — Closed-Only Minimal *(推奨)*
**Approach**: pruneを `*.deleted.*` と `*.reset.*`（閉じたセッション）に限定する。アクティブ `.jsonl` には一切触れない。スケジューラを廃止し、上流の `saveSessionStore()` 実行後のpost-hookとして便乗実行する。

**Implementation cost**: Low (1日以内)
**Risk**: Low (閉じたファイルしか触らないため上流と100%競合しない)
**Why recommended**:
1. **アクティブセッション破損リスクが完全にゼロ** — Idle Time Guard、Lock、Copy-on-Rotateの5層防御のうち3層が不要になる（設計が5→2層に単純化）
2. **上流との競合がゼロ** — `store-maintenance.ts` のarchiving後のファイルだけが対象なので、同時実行問題が発生しない
3. **`setInterval` スケジューラが不要** — 上流の `saveSessionStore()` が既に定期的にmaintenance走査を行うので、そのタイミングに便乗すれば独自タイマーを持つ必要がない（KISS）
4. **設定フィールドが5つ以下に削減** — `enabled`, `minPrunableToolChars`, `keepLastEntries`, `placeholder`, `dryRun` だけで十分

**Concrete steps**:
1. `src/dennou-soul/` ディレクトリを新規作成
2. `src/dennou-soul/prune-closed-sessions.ts` — `pruneClosedSessionFile(filePath)` を実装（JSONLの行レベルpruning、ツール出力をplaceholderに置換）
3. 上流 `store-maintenance.ts` の archive 完了後に呼び出すフックを `src/dennou-soul/session-maintenance-hook.ts` に配置
4. 設定を `dennou-config.json`（独自ファイル）に分離し、`openclaw.json` を汚さない
5. `dryRun: true` で1週間観察 → `false` に切り替え

#### Option B — Full Plan（プラン通り + 競合対策追加）
**Approach**: プランの設計をベースに、上流競合対策としてファイルロックの統合と `store-maintenance.ts` の実行タイミング検知を追加。

**Implementation cost**: Medium〜High (3-5日)
**Risk**: Medium (アクティブセッションを触るため、Idle Time Guardの閾値ミスで破損リスクあり)
**When to choose this instead**: セッションが数時間〜数日の長期稼働で、ツール出力がGB級に膨張する環境が現実に発生している場合のみ。

**Concrete steps**:
1. プランのPhase 1-4をそのまま実装
2. **追加**: `store-maintenance.ts` の `saveSessionStore()` 実行中フラグを検知し、同時実行を回避するmutex層を追加
3. **追加**: `ttlMinutes` のデフォルトを `5` → `30` に変更（5分は攻撃的すぎる — 会話中の5分休憩は日常的）
4. **追加**: `targetFiles: "all"` オプションを削除（YAGNI — 非推奨なら実装しない）
5. テストで上流archiving → 独自prune → 上流cleanup の3段パイプラインを検証

### ✅ Pro Recommendation
> **Choose Option A because**: 223KBの閉じたセッション（`.deleted.*`）こそが「ディスクを占有する」主犯であり、アクティブセッションのpruneは現時点で実証された必要性がない（YAGNI）。閉じたファイル限定ならIdle Guard/Lock/Copy-on-Rotateの重装備が不要で、上流との競合もゼロ。最小限のコードで最大の効果が得られる。
>
> Estimated implementation: 0.5〜1日
> Rollback plan: `enabled: false` で即停止。閉じたファイルのpruneなので復元不要（元々削除予定のデータ）。

### ⚡ Quick Wins (implement regardless of option chosen)
- [ ] `ttlMinutes` デフォルトを `5` → `30` に変更（5分は日常的な休憩で誤prune発生）
- [ ] `targetFiles: "all"` オプションを設計から削除（YAGNI — 非推奨なものを実装しない）
- [ ] WAL rotate参照パスを `episodic-claw/src/segmenter.ts` L168-210 に修正
- [ ] プランの証拠2に上流maintenance機構の存在を追記（意思決定の前提を正確にする）
- [ ] 設定ファイルの保存場所を `dennou-config.json`（独自ファイル）に決定（Rule 2: Smart Debloating — `openclaw.json` を汚さない）

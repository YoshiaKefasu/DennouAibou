# 2026-04-26 Session File Auto-Prune Plan (v2 — Closed-Only Minimal)

> **v1 からの変更点**: Pro Engineer Review (2026-04-28) の結果に基づき、Option A（Closed-Only Minimal）で全面再設計。
> v1 原本と監査記録は `2026-04-26_session_prune_plan_v1.md` を参照。

---

## 0. 目的

- DennouAibouのエージェントセッションJSONLファイルが、ツール出力の蓄積により肥大化する問題を解決する。
- **スコープを「閉じたセッション」に限定**し、アクティブセッションの破損リスクを完全に排除する。
- 上流OpenClawが既に持つセッション管理機構（`store-maintenance`, `disk-budget`, `session-reaper`, heartbeat transcript truncation）と**競合しない**設計とする。
- `src/dennou-soul/` に隔離し、DENNOU_RULES.md Rule 1（Encapsulation）を厳守する。

---

## 1. 現状分析

### 証拠1: JSONLファイルの肥大化実態

`Y:\kasou_yoshia\.openclaw\agents\main\sessions` 配下のファイルを見ると：

- `2f65d209-....jsonl.deleted.*` → **223KB**（閉じたセッション）
- ツール出力がそのまま残り続け、削除されたファイルでもディスクを占有する

### 証拠2: ランタイムPruningはディスク保存に影響しない（行レベル限定）

`contextPruning` 設定（`src/config/types.agent-defaults.ts` L24-106, 実装: `src/agents/pi-hooks/context-pruning/pruner.ts`）は、LLMにプロンプトを送る直前のフィルタリングのみを制御する。ディスク上のJSONLの**行レベルのツール出力**は無傷のまま。

### 証拠3: 上流にセッション全体のライフサイクル管理は存在する

上流OpenClawは以下の4つのディスクレベル管理機構を持つ（v1では見落としていた）：

| 機構 | ファイル | 何をするか |
|---|---|---|
| Session Maintenance | `src/config/sessions/store-maintenance.ts` | `pruneAfter` (時間), `maxEntries` (数) でstaleセッションを `.deleted.*` にアーカイブ |
| Disk Budget | `src/config/sessions/disk-budget.ts` | `maxDiskBytes` / `highWaterBytes` によるoldest-first eviction |
| Session Reaper | `src/cron/session-reaper.ts` | cron run sessionの自動sweep |
| Heartbeat Truncation | `src/infra/heartbeat-runner.ts` L308-325 | HEARTBEAT_OK時に `fs.truncate()` でtranscriptを元サイズに復元 |

**これらはセッション「全体」の管理であり、セッション内の「行レベルのツール出力」のpruningは行わない。** → 本プランのスコープはここ。

### 証拠4: WAL rotateパターン

`episodic-claw/src/segmenter.ts` の `walRotateForFlush()` (L168-210) は、ファイルを直接書き換えずに安全にデータを整理する実績がある。閉じたファイルであればこのパターンをさらに簡素化できる。

---

## 2. 設計方針

### 2.1 アーキテクチャ原則

- **Closed-Only**: `*.deleted.*` と `*.reset.*`（閉じたセッション）のみを対象。アクティブ `.jsonl` には一切触れない。
- **DennouAibou独自機能**: `src/dennou-soul/` 以下に隔離（Rule 1: Encapsulation）。
- **上流便乗**: 独自スケジューラを持たず、上流 `saveSessionStore()` のmaintenance走査タイミングにpost-hookで便乗する。
- **設定は独自ファイル**: `dennou-config.json` に分離し、`openclaw.json` を汚さない（Rule 2: Smart Debloating）。
- **不可逆操作を前提**: JSONLから消したツール出力は二度と戻せない。プレースホルダ行を残す。

### 2.2 安全機構（2層防御）

| # | 機構 | 説明 | 危険度低減効果 |
|---|---|---|---|
| 1 | **Closed-Only Guard** | `*.deleted.*` と `*.reset.*` のみを対象。アクティブ `.jsonl` は絶対に触らない | アクティブセッション破損リスクが**完全にゼロ** |
| 2 | **Dry-Run 段階的導入** | 初期は `dryRun: true` でログ出力のみ、実際の削除は行わない | 誤動作を事前に検出できる |

> **v1 との差分**: Idle Time Guard, Copy-on-Rotate, Lock/排他制御の3層を削除。閉じたファイル限定にすることで、これらが構造的に不要になった。

---

## 3. 設定スキーマ

```typescript
// src/dennou-soul/types.ts
export interface DennouSessionToolsPruneConfig {
  /** 機能のON/OFF */
  enabled: boolean;
  /** この文字数以上のツール出力のみPrune対象 */
  minPrunableToolChars: number;
  /** セッション末尾から保護するツール出力エントリ数 */
  keepLastTools: number;
  /** Prune後のプレースホルダテキスト */
  placeholder: string;
  /** Dry-runモード。trueの場合、ログ出力のみ */
  dryRun: boolean;
}
```

### デフォルト値

```json
// dennou-config.json
{
  "sessionToolsPrune": {
    "enabled": false,
    "minPrunableToolChars": 1200,
    "keepLastTools": 5,
    "placeholder": "[tool output pruned by DennouAibou]",
    "dryRun": true
  }
}
```

> **v1 との差分**:
> - `targetFiles` 削除 — Closed-Onlyで固定。設定で変えられる必要がない
> - `idleThresholdMinutes` 削除 — 閉じたファイル限定なのでアイドル判定が不要
> - `intervalMinutes` 削除 — スケジューラ廃止（上流便乗）
> - `ttlMinutes` 削除 — 閉じたファイル内のツール出力は全て「古い」ので時刻判定が不要
> - 9フィールド → 5フィールドに削減

---

## 4. 対象ファイルとPrune条件

### 対象ファイル（Closed-Only）

```
~/.openclaw/agents/{agentId}/sessions/*.jsonl.deleted.*
~/.openclaw/agents/{agentId}/sessions/*.jsonl.reset.*
```

> **アクティブセッション (`*.jsonl`) は対象外。**

### Prune条件

1. ファイル拡張子が `.deleted.*` または `.reset.*` であること
2. JSONLの各行を解析し、以下の条件を**すべて**満たすエントリをPrune：
   - `toolResult` ロールのエントリである
   - content の文字数が `minPrunableToolChars` (1200) 以上
   - セッション末尾から `keepLastTools` (5) 以内でない
3. Pruneされた行はプレースホルダ行に置き換える

### 処理手順（簡素化）

```
1. 対象ディレクトリの *.deleted.* / *.reset.* を列挙
2. 各ファイルを1行ずつ読み取り
3. Prune条件に合致 → プレースホルダ行を書き出し
4. 条件に合致しない → そのまま書き出し
5. 元ファイルを上書き（閉じたファイルなので安全）
```

> **v1 との差分**: Copy-on-Rotateパターン（リネーム→読み取り→新ファイル→旧削除→Lock解放）を廃止。閉じたファイルは他プロセスが書き込まないため、直接上書きで安全。

---

## 5. 実装フェーズ

### Phase 1: 基盤（見積：小, 0.5日）

- `src/dennou-soul/` ディレクトリを新規作成
- `src/dennou-soul/types.ts` に `DennouSessionToolsPruneConfig` 定義
- `src/dennou-soul/config.ts` に `dennou-config.json` の読み込みとデフォルト値マージ

### Phase 2: Pruneエンジン（見積：小〜中, 0.5日）

- `src/dennou-soul/prune-closed-sessions.ts` を作成
  - `pruneClosedSessionFile(filePath, config)` — 単一ファイルのpruneロジック
  - `pruneAllClosedSessions(sessionsDir, config)` — ディレクトリ走査 + 上記を各ファイルに適用
- ユニットテスト: `prune-closed-sessions.test.ts`

### Phase 3: 上流フック統合（見積：小, 数時間）

- `src/dennou-soul/session-maintenance-hook.ts` を作成
  - 上流 `saveSessionStore()` の完了後に `pruneAllClosedSessions()` を呼び出す
  - エラー発生時は警告ログのみ（上流の正常動作を妨げない）
- フックの登録ポイント: `src/config/sessions/store.ts` の `saveSessionStore()` 末尾にオプショナルコールバック

### Phase 4: Dry-Run → 本番切替

- `dryRun: true` で1週間運用
- ログを確認して誤検知がないことを確認
- `dryRun: false` に切り替えて本番運用開始

> **v1 との差分**: Phase 3（定期実行スケジューラ）を廃止。`setInterval` + `startSessionPruneScheduler()` + `stopSessionPruneScheduler()` が丸ごと不要になった。

---

## 6. ロールバック計画

- **設定のみ**: `enabled: false` で機能停止。既存データには影響しない。
- **実装全体**: `src/dennou-soul/` 配下のprune関連ファイルを削除。フック登録を外す。
- **Prune済みファイルの復元**: **不可逆**だが、対象は閉じたセッション（`.deleted.*` / `.reset.*`）なので実質的な影響はない — 元々アクティブに使われていないデータ。

---

## 7. 決定済み事項（v1の未確定を解消）

| 項目 | v1での状態 | v2での決定 | 根拠 |
|---|---|---|---|
| バックアップ戦略 | 未確定 | **不要** | 閉じたセッションは元々削除予定のデータ。バックアップの追加コストが利益を上回る |
| 設定の保存場所 | 未確定 | **`dennou-config.json`（独自ファイル）** | Rule 2: Smart Debloating。`openclaw.json` を汚さず、上流syncの衝突を防ぐ |
| OpenClawアップストリーム同期 | 独自のまま | **独自のまま** | Rule 1: Encapsulation。コアファイルには触れない |

---

---

## 8. 実装状態（2026-04-28）

### 全フェーズ完了

| Phase | ファイル | 状態 | 備考 |
|---|---|---|---|
| Phase 1 | `src/dennou-soul/types.ts` | ✅ 完了 | `DennouSessionToolsPruneConfig` 定義 |
| Phase 1 | `src/dennou-soul/config.ts` | ✅ 完了 | `dennou-config.json` 読み込み + デフォルトマージ |
| Phase 2 | `src/dennou-soul/prune-closed-sessions.ts` | ✅ 完了 | エンジン本体（228行） |
| Phase 2 | `src/dennou-soul/prune-closed-sessions.test.ts` | ✅ 完了 | 11テスト 全通過 |
| Phase 3 | `src/dennou-soul/session-maintenance-hook.ts` | ✅ 完了 | フック定義 + `setAfterSaveHook` 登録 |
| Phase 3 | `src/config/sessions/store.ts` | ✅ 完了 | `setAfterSaveHook()` / `_afterSaveHook` / 成功パス3箇所で呼び出し |
| Phase 3 | `src/cli/run-main.ts` | ✅ 完了 | `runCli()` 初期化時に `initSessionMaintenanceHook()` 呼び出し |
| Phase 4 | デフォルト設定 | ✅ 完了 | `dryRun: true`（安全側）でリリース済み |

### 設計からの逸脱（意図的）

1. **フック方式**: プランでは `saveSessionStore` のオプショナルコールバックとしていたが、実際はモジュールレベルのグローバルフック（`setAfterSaveHook` + `_afterSaveHook`）を採用。理由: 全呼び出し元に `onAfterSave` を追加する必要がなく、統一された1箇所でフックが設定できる。上流APIを変えない。

2. **`enabled` の初期値**: プランでは `false` としていたが、実装では `true` に設定。理由: `dryRun: true` が安全機構の役割を果たしており、`enabled: true` + `dryRun: true` の組み合わせで「動作はするが副作用は出ない」状態。ユーザーが明示的に `dryRun: false` に変えるまではディスクに影響しない。

### 実装ファイル一覧

```
src/dennou-soul/
  types.ts               (29行) DennouSessionToolsPruneConfig 型
  config.ts              (55行) dennou-config.json 読み込み
  prune-closed-sessions.ts (228行) Pruneエンジン本体
  prune-closed-sessions.test.ts (388行) ユニットテスト
  session-maintenance-hook.ts (52行) フック定義 + 登録

src/config/sessions/store.ts (+6行) setAfterSaveHook + _afterSaveHook + 呼び出し3箇所
src/cli/run-main.ts      (+2行) initSessionMaintenanceHook() 呼び出し
```

---

### バグ修正履歴（2026-04-28 レビュー時）

#### Bug 1: ENOENTリトライ成功パスでフック未呼び出し

**発見**: `store.ts` のUnixパス、最初のatomic writeがENOENTで失敗した場合、リトライ成功後に `_afterSaveHook` が呼ばれていなかった。

**修正**: リトライ成功後も `await _afterSaveHook?.(storePath)` を呼ぶ。

**影響**: 稀なENOENTリトライパスでのみ発生。本番運用でのトリガー確率は低い。

#### Bug 2: 閉じたセッションでワークスペースパス保護が効かない

**発見**: `session-maintenance-hook.ts` が `config.pruneProtection`（常に `resolvedWorkspacePaths: []`）を直接使っていたため、閉じたセッションのPruneではキーワード保護のみ有効でワークスペースパス保護が機能していなかった。

**修正**: `resolveProtectionWithWorkspacePaths()` を追加。初回呼び出し時に `resolveAgentWorkspaceDir()` でパスを自動解決しキャッシュ。`afterSavePrune` を `async` にして解決済みprotectionを渡す。

**影響**: 閉じたセッションでもワークスペースパス保護が有効になった。

---

## 9. 参考

- contextPruning 設定スキーマ: `src/config/types.agent-defaults.ts` L24-106
- contextPruning ランタイム実装: `src/agents/pi-hooks/context-pruning/pruner.ts`
- 上流 session maintenance: `src/config/sessions/store-maintenance.ts`
- 上流 disk budget: `src/config/sessions/disk-budget.ts`
- WAL rotateパターン: `episodic-claw/src/segmenter.ts` L168-210 `walRotateForFlush()`
- DENNOU_RULES.md Rule 1（Encapsulation）、Rule 2（Smart Debloating）
- Pro Engineer Review: `2026-04-26_session_prune_plan_v1.md` 末尾セクション

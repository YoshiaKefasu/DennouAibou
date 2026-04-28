# 2026-04-28 Active Session Tools Prune Plan (v1)

> **前提**: Closed-Only の v2 実装は完了済み（`src/dennou-soul/prune-closed-sessions.ts`）。
> 本プランは**アクティブセッション**のツール出力をIdle検知後にpruneする追加機能。

---

## 0. 目的

- エージェントが返答を完了してIdle状態に入った後、**アクティブセッションJSONLからツール出力を削減**する。
- ディスクの肥大化防止に加え、**次回のLLMへのコンテキスト窓から不要なツール出力を除去**することが主目的。
- DENNOU_RULES.md Rule 1（Encapsulation）を厳守し、上流コアファイルへの変更を最小限にする。

---

## 1. 現状分析

### 証拠1: 上流に既存のIdle検知機構がある

OpenClawは以下の3つのIdle関連機構を持つ：

| 機構 | ファイル | 何をするか |
|---|---|---|
| **DiagnosticSessionState** | `src/infra/diagnostic-events.ts` L3 | セッション状態を `"idle" \| "processing" \| "waiting"` で管理 |
| **logSessionStateChange → "idle"** | `src/logging/diagnostic.ts` L194-227 | エージェントの処理完了時に `state: "idle"` イベントを `emitDiagnosticEvent()` で発火。**`onDiagnosticEvent()` でlistenできる** |
| **session.reset.idleMinutes** | `src/config/sessions/reset.ts` L80-115 | N分のIdle後にセッションを**リセット**（新セッション作成）する既存設定。ただしpruneではなくリセット |

### 証拠2: Idle検知の既存フロー

```
ユーザーメッセージ → [processing] → エージェント応答完了
  → logSessionStateChange({ state: "idle" })   ← ★ここでイベント発火
  → emitDiagnosticEvent({ type: "session.state", state: "idle" })
  → onDiagnosticEvent() のリスナーで受信可能
```

`src/logging/diagnostic.ts` L205 で `params.state === "idle"` 時に `queueDepth` をデクリメントし、`session.state` イベントを emit する。**DennouAibouはこのイベントを `onDiagnosticEvent()` で listen し、Idleからの経過時間を独自に計測できる。**

### 証拠3: 既存のIdle→リセット機構とのスコープ差

`session.reset.idleMinutes` は「N分のIdle後にセッション全体をリセット（新しいセッションを開始）する」機能。本プランは「セッション内のツール出力だけをpruneし、セッション自体は維持する」ため、**既存機構と補完関係にあり衝突しない**。

### 証拠4: v2実装のPruneエンジンは再利用可能

`src/dennou-soul/prune-closed-sessions.ts` の `pruneClosedSessionFile()` は、JSONLの行レベルでツール出力をplaceholderに置換するロジック。このコアロジックをアクティブセッションにも適用できる（ファイルパスの制限を外すだけ）。

---

## 2. 設計方針

### 2.1 アーキテクチャ原則

- **Idle Timer**: `onDiagnosticEvent()` で `session.state: "idle"` を listen → 独自のタイマー（`setTimeout`）を起動 → N分後に未だidleならprune実行
- **DennouAibou独自**: `src/dennou-soul/` に隔離。上流への変更は**ゼロ**（`onDiagnosticEvent` は既存のpublic API）
- **Prune後はディスク + コンテキスト窓の両方から除去**: JSONLを書き換えるため、次回のLLM呼び出し時に読み込まれるコンテキスト窓からもツール出力が消える
- **設定は `dennou-config.json`**: 既存の `sessionToolsPrune` セクションに追加

### 2.2 安全機構（3層防御）

| # | 機構 | 説明 | 危険度低減効果 |
|---|---|---|---|
| 1 | **Idle Timer Guard** | `session.state: "idle"` 検出後 `idleDelayMinutes` 経過するまで待機。途中で `processing` に戻ったらタイマーキャンセル | 会話中のpruneを100%防止 |
| 2 | **Copy-on-Write** | アクティブセッションは直接上書きせず、一時ファイルに書き出し → atomic rename | 書き込み中のプロセスとの競合を防止 |
| 3 | **Dry-Run** | 初期は `dryRun: true` でログ出力のみ | 誤動作を事前に検出 |

### 2.3 上流変更がゼロである理由

- `onDiagnosticEvent()` は `src/infra/diagnostic-events.ts` L229 で export されたpublic API
- `emitDiagnosticEvent({ type: "session.state", state: "idle" })` は既に全セッション状態遷移で発火されている
- DennouAibouは**リスナーを追加するだけ**。上流のコードを一切変更する必要がない

---

## 3. 設定スキーマ

```typescript
// src/dennou-soul/types.ts に追加
export interface DennouActiveSessionPruneConfig {
  /** アクティブセッションのIdle Pruneを有効にするか */
  enabled: boolean;
  /** Idle検知後、何分間沈黙が続いたらpruneするか（分） */
  idleDelayMinutes: number;
  /** この文字数以上のツール出力のみPrune対象 */
  minPrunableToolChars: number;
  /** セッション末尾から保護するツール出力エントリ数 */
  keepLastTools: number;
  /** Prune後のプレースホルダテキスト */
  placeholder: string;
  /** Dry-runモード */
  dryRun: boolean;
}
```

### デフォルト値

```json
// dennou-config.json に追加
{
  "sessionToolsPrune": { ... },
  "activeSessionToolsPrune": {
    "enabled": true,
    "idleDelayMinutes": 30,
    "minPrunableToolChars": 1200,
    "keepLastTools": 10,
    "placeholder": "[tool output pruned by DennouAibou — idle prune]",
    "dryRun": true
  }
}
```

> **設計判断**:
> - `idleDelayMinutes: 30` — Idle後30分の沈黙で発火。ユーザーが30分以内に返事すればpruneはキャンセルされる
> - `keepLastTools: 10` — アクティブセッションでは直近の文脈がより重要なため、v2の `5` より多く保護
> - `minPrunableToolChars: 1200` — v2と同じ閾値を再利用（DRY）

---

## 4. Idle検知 → Prune実行フロー

```
┌─────────────┐
│ Agent Reply  │ ← エージェントが返答完了
└──────┬──────┘
       │
       ▼
┌─────────────────────┐
│ logSessionStateChange│ ← 上流が "idle" を emit
│ { state: "idle" }   │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────────────┐
│ DennouAibou Listener        │ ← onDiagnosticEvent() で listen
│ (src/dennou-soul/           │
│  idle-prune-watcher.ts)     │
└──────┬──────────────────────┘
       │ setTimeout(idleDelayMinutes)
       │
       ├─── [ユーザーが返事] → processing → タイマーキャンセル ✗
       │
       ├─── [5分間沈黙] → タイマー発火 ✓
       │
       ▼
┌─────────────────────────────┐
│ pruneActiveSessionFile()    │ ← v2のエンジンを拡張して呼び出し
│ - JSONL行解析               │
│ - ツール出力 → placeholder  │
│ - atomic write              │
└─────────────────────────────┘
```

### タイマー管理の詳細

```typescript
// セッションキーごとにタイマーを管理
const idleTimers = new Map<string, NodeJS.Timeout>();

onDiagnosticEvent((evt) => {
  if (evt.type !== "session.state") return;
  const sessionKey = evt.sessionKey;
  if (!sessionKey) return;

  if (evt.state === "idle") {
    // 既存のタイマーがあればクリア（再起動）
    clearExistingTimer(sessionKey);
    // 新しいIdleタイマーを設定
    idleTimers.set(sessionKey, setTimeout(() => {
      pruneActiveSession(sessionKey);
    }, config.idleDelayMinutes * 60_000));
  } else {
    // processing/waiting に遷移 → タイマーキャンセル
    clearExistingTimer(sessionKey);
  }
});
```

---

## 5. Prune対象の判定

### 対象ファイル

```
~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl
```

> **Closed-Only v2との差分**: `.deleted.*` / `.reset.*` ではなく、アクティブな `.jsonl` が対象。

### Prune条件

1. `session.state` イベントで `"idle"` → `idleDelayMinutes` 分間、`"processing"` / `"waiting"` に戻らなかった
2. JSONLの各行を解析し、以下の条件を**すべて**満たすエントリをPrune：
   - `toolResult` ロールのエントリである
   - content の文字数が `minPrunableToolChars` (1200) 以上
   - セッション末尾から `keepLastTools` (10) 以内でない
3. Pruneされた行はプレースホルダ行に置き換える

### 安全な処理手順（Copy-on-Write for Active）

```
1. 現在の session.state を確認（まだ "idle" であること）
2. JSONL ファイルを読み取り
3. Prune条件に合致 → プレースホルダ行
4. 一時ファイル (xxx.jsonl.prune-tmp) に書き出し
5. session.state を再確認（まだ "idle" であること） ← ★ Double-check
6. atomic rename: xxx.jsonl.prune-tmp → xxx.jsonl
7. 一時ファイルの残骸があれば削除
```

> **v2（Closed-Only）との差分**: 閉じたファイルは直接上書きで安全だったが、アクティブセッションは上流がいつ書き込むかわからないため、一時ファイル経由のatomic renameを採用。

---

## 6. v2 Pruneエンジンとのコード共有

v2の `pruneClosedSessionFile()` とアクティブセッション版の共通ロジックを抽出：

```
src/dennou-soul/
  prune-engine.ts              (NEW) 共通pruneロジック（行レベル判定、placeholder置換）
  prune-closed-sessions.ts     (MODIFY) prune-engine.ts を呼び出すように変更
  prune-active-session.ts      (NEW) アクティブセッション用wrapper（atomic write）
  idle-prune-watcher.ts        (NEW) onDiagnosticEvent listener + タイマー管理
  types.ts                     (MODIFY) DennouActiveSessionPruneConfig 追加
  config.ts                    (MODIFY) activeSessionToolsPrune 設定読み込み追加
```

---

## 7. 実装フェーズ

### Phase 1: Pruneエンジン共通化（見積：小, 数時間）

- `src/dennou-soul/prune-engine.ts` を新規作成
  - `pruneToolOutputLines(lines, config)` — 行レベルのprune判定ロジック
  - v2の `pruneClosedSessionFile()` から共通部分を抽出
- `prune-closed-sessions.ts` を `prune-engine.ts` を呼び出す形にリファクタ
- 既存テスト全通過を確認

### Phase 2: アクティブセッションPrune（見積：小〜中, 0.5日）

- `src/dennou-soul/prune-active-session.ts` を新規作成
  - `pruneActiveSessionFile(filePath, config)` — 一時ファイル経由のatomic write
  - prune前後の `session.state` double-check
- ユニットテスト: `prune-active-session.test.ts`

### Phase 3: Idle Watcher（見積：小, 数時間）

- `src/dennou-soul/idle-prune-watcher.ts` を新規作成
  - `startIdlePruneWatcher(config)` — `onDiagnosticEvent` listener登録 + タイマー管理
  - `stopIdlePruneWatcher()` — cleanup
- `src/cli/run-main.ts` に `startIdlePruneWatcher()` 呼び出しを追加（+2行程度）
- `types.ts` に `DennouActiveSessionPruneConfig` 追加
- `config.ts` に `activeSessionToolsPrune` セクション読み込み追加

### Phase 4: Dry-Run → 本番切替

- `dryRun: true` で1週間運用
- ログで以下を確認：
  - Idle検知 → タイマー起動のログ
  - タイマー発火 → prune実行のログ
  - ユーザー復帰 → タイマーキャンセルのログ
- 問題なければ `dryRun: false` に切り替え

---

## 8. リスク分析

### リスク1: エージェント応答完了とJSONL書き込みのタイミング

- **問題**: エージェントが `"idle"` に遷移した直後に、上流がtranscriptへの最終書き込みを行う可能性
- **対策**: `idleDelayMinutes: 5` のタイマーにより、最低5分間は書き込み完了を待つ。さらにprune直前に `session.state` をdouble-checkする

### リスク2: 複数セッションの同時prune

- **問題**: 複数セッションが同時にidleになった場合、I/O負荷
- **対策**: `setTimeout` のタイミングが自然にずれる。問題が実証されたら `Promise.all` に並行数制限を追加

### リスク3: session.reset.idleMinutes との競合

- **問題**: `session.reset.idleMinutes` でセッションがリセットされた後に prune タイマーが発火
- **対策**: prune実行前にファイル存在確認。存在しなければスキップ。reset後のファイルは `.reset.*` になるためClosed-Only v2がカバー

---

## 9. ロールバック計画

- **設定のみ**: `activeSessionToolsPrune.enabled: false` で機能停止
- **実装全体**: `idle-prune-watcher.ts` + `prune-active-session.ts` を削除。`run-main.ts` から初期化呼び出しを削除
- **Prune済みの復元**: **不可逆**。ただしprune対象はコンテキスト窓から不要なツール出力であるため、実質的な情報ロスは低い

---

## 10. 参考

- `onDiagnosticEvent()`: `src/infra/diagnostic-events.ts` L229
- `logSessionStateChange()`: `src/logging/diagnostic.ts` L194-227
- `DiagnosticSessionState`: `src/infra/diagnostic-events.ts` L3
- `session.reset.idleMinutes`: `src/config/sessions/reset.ts` L80-115
- v2 Closed-Only実装: `src/dennou-soul/prune-closed-sessions.ts`
 - v2 プラン: `2026-04-26_session_prune_plan_v2.md`

---

## 11. 実装状態（2026-04-28）

### 全フェーズ完了

| Phase | ファイル | 状態 | 備考 |
|---|---|---|---|
| Phase 1 | `src/dennou-soul/prune-engine.ts` | ✅ 完了 | 共通Pruneエンジン。`parseLine`, `isToolResultEntry`, `getToolResultContentLength`, `pruneToolOutputLines` を抽出 |
| Phase 1 | `src/dennou-soul/prune-closed-sessions.ts` | ✅ 完了 | リファクタ: 共通エンジンを呼び出す形に変更 |
| Phase 2 | `src/dennou-soul/prune-active-session.ts` | ✅ 完了 | アクティブセッションPrune + mtime double-check + atomic write |
| Phase 2 | `src/dennou-soul/prune-active-session.test.ts` | ✅ 完了 | 13テスト 全通過 |
| Phase 3 | `src/dennou-soul/types.ts` | ✅ 完了 | `DennouActiveSessionPruneConfig` 追加 |
| Phase 3 | `src/dennou-soul/config.ts` | ✅ 完了 | `activeSessionToolsPrune` 設定読み込み |
| Phase 3 | `src/dennou-soul/idle-prune-watcher.ts` | ✅ 完了 | `onDiagnosticEvent` listener + タイマー管理 |
| Phase 3 | `src/cli/run-main.ts` | ✅ 完了 | `startIdlePruneWatcher()` 呼び出し |
| Phase 4 | デフォルト設定 | ✅ 完了 | `dryRun: true`（安全側）でリリース済み |

### 設計からの逸脱（意図的）

1. **タイマーキャンセル**: プラン図では `processing` に戻ったときのタイマーキャンセルが明示されていなかったが、実装では `handleIdleEvent` と `processing`/`waiting` 検出の両方をリスナー内で処理。`"idle"` → タイマー起動、`"processing"/"waiting"` → タイマーキャンセル。

2. **安全機構**: プランでは「Idle Timer Guard」「Copy-on-Write」「Dry-Run」の3層だったが、実装ではさらに **mtime double-check** を追加（読み取り前後の mtime 比較）。書き込み中の競合をより確実に検出する。

3. **dryRun時のログ**: プランには「dryRun時はファイルを変更しない」とだけあったが、実装では idle timer 設定時にも `DRY-RUN idle timer set` をログ出力する。運用者が watcher の動作を確認できる。

### 実装ファイル一覧

```
src/dennou-soul/
  types.ts                (+6行) DennouActiveSessionPruneConfig + デフォルト値
  config.ts               (+3行) activeSessionToolsPrune 読み込み
  prune-engine.ts          (NEW: 112行) 共通Pruneエンジン
  prune-closed-sessions.ts (MODIFY) prune-engine.ts を呼び出す形にリファクタ
  prune-active-session.ts  (NEW: 162行) アクティブセッションPrune + atomic write
  prune-active-session.test.ts (NEW: 300行) 13テスト
  idle-prune-watcher.ts    (NEW: 135行) onDiagnosticEvent listener + タイマー管理

src/cli/run-main.ts        (+2行) startIdlePruneWatcher() 呼び出し
```

### テスト結果

- `prune-closed-sessions.test.ts`: 11 passed（リファクタ後も既存動作維持）
- `prune-active-session.test.ts`: 13 passed（新規）
- 合計: **24 passed**

### レビュー結果（2026-04-28）

| # | 判定 | 備考 |
|---|---|---|
| ✅ | `prune-active-session.ts` | mtime double-check + atomic write + protection伝搬、すべて正しい |
| ✅ | `idle-prune-watcher.ts` | idle timer → cancel → cleanup、全経路で protection 正しく伝搬 |
| ✅ | `run-main.ts` → watcher | ワークスペースパス解決済み protection が渡されている |
| ✅ | テスト | 13/13 全通過、影響なし |

**批判的バグ: なし**


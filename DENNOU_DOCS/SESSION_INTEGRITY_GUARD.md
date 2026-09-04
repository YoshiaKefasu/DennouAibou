# Session Integrity Guard — セッション整合性ガード

> **状態**: 設計初版（実装前）
> **作者**: Executor（設計ドキュメント担当）
> **対象**: KASOU の記憶（セッション jsonl）の壊れない仕組み
> **方針**: 玄関の鍵（カーネル書き込み時ガード）と見回りの警備員（プラグイン定期ヘルスチェック＋自動修復）の二段構え

---

## 1. 背景と目的

### 1.1 何が起きたか（2026-09-04 発覚）

KASOU 本番セッション `93fcc1a8-7563-4cf2-b9f1-e4552e7e444f.jsonl` で、**親子リンク切断の大規模破壊**が見つかった。

| 計測値                | 値         |
| --------------------- | ---------- |
| 孤児ノード総数        | **146 個** |
| └ `model-snapshot` 行 | 112        |
| └ `prompt-error` 行   | 31         |
| └ `message` 行        | 1          |
| └ その他              | 2          |
| leaf node への分裂    | 148 本     |

### 1.2 根本原因

3/31 のコンパクションで**親メッセージが削除された**さい、子だった `snapshot` / `error` 行だけがファイル上に残置された。これにより後続の書き込みで `parentId` が指す相手が見つからない孤児エントリが大量に生まれた。

### 1.3 修復履歴（参考・参考値であり本書のスコープ外）

3 段階で修復済み（最終 1346 行 / 孤児 0 / 重複 0 / 構文 OK）。バックアップ 2 点取得済み。**今回の設計は再発防止であり、修復手順の再実装ではない。**

### 1.4 目的

ユーザー裁定に基づき、**「壊れない仕組み」を事前防止として作る**。

| 観点     | 設計判断                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------- |
| 対象     | KASOU の記憶（セッション jsonl）=「玄関をちゃんと守る」                                             |
| 主眼     | **書き込み時点でのガード**（事後修復より優先）                                                      |
| 構成     | **ハイブリッド**: 書き込みガードのみカーネル最小組み込み / ヘルスチェック＋自動修復はプラグイン分離 |
| 方針整合 | Phase F「カーネルは細く」を維持（DENNOU_DOCS/PHASE_F_SLIM_KERNEL.md §2 参照）                       |

> **書き込みガードの射程**: 以下のガードは **append 系**経路のみを観測する。コンパクション / 切り捨て / `_rewriteFile()` など **書き換え系**では JSONL ツリー構造が直接破壊され得るが、検知は本書の対象外とし、**プラグイン側ヘルスチェック**が担う（§3.1 経路表 / §4 プラグイン仕様 参照）。

---

## 2. アーキテクチャ

家の玄関にたとえると:

- **カーネル書き込みガード** = 玄関の鍵。「壊れた荷物を持ち込まない」= post-append で異常を**検知してログと修復ジョブに伝える**
- **プラグインヘルスチェック** = 巡回中の警備員。定期的に「壊れた荷物が紛れていないか」見回る
- **プラグイン自動修復** = 清掃スタッフ。**ゲートをすり抜けた過去ログ（既知孤児）だけ**を、決められた手順で片付ける
- **cron + 通知** = 警備会社のシフトと緊急連絡先

```
┌────────────────────────────────────────────────────────────┐
│ KERNEL（dennou-aibou 本体・最薄）                           │
│                                                            │
│  各呼び出し元 (attempt / command / gateway /                     │
│  transcript-mirror)                                            │
│   ※ btw / fork / export-session は非 append 経路（新規ファイル作成・読
│     み取り専用）で §3.1 介入経路一覧には含めない                  │
│   └ SessionManager.appendMessage() / appendCustomEntry()        │
│      │                                                     │
│      ▼                                                     │
│  ┌──────────────────────────────────────────────────┐      │
│  │ guardSessionManager() 既存 seam（再流用）         │      │
│  │   src/agents/session-tool-result-guard-wrapper.ts │      │
│  │   :21 で SessionManager を受け取り、              │      │
│  │   appendMessage / appendCustomEntry ラッパを       │      │
│  │   装着して post-append 検証を追加                 │      │
│  │   (1) getEntry(返り値 id) 存在チェック             │      │
│  │   (2) getLeafId() 整合チェック                      │      │
│  │   NG → ログ記録 + 修復ジョブエンキュー             │      │
│  └──────────────────────────────────────────────────┘      │
│      │ OK                                                  │
│      ▼                                                     │
│  セッション jsonl へ追加書き込み                            │
└──────────────────────────┬─────────────────────────────────┘
                           │ 検知イベントはプラグイン側へ
                           ▼
┌────────────────────────────────────────────────────────────┐
│ PLUGIN: extensions/session-integrity-guard                 │
│                                                            │
│  ┌─ 定期ヘルスチェック (cron: 毎日 03:00 JST) ────────┐    │
│  │  • 孤児数（parentId !== null で親不在の行数）       │    │
│  │  • JSON 構文                                     │    │
│  │  • 重複 ID                                       │    │
│  │  • leaf node 数（ヘッダ行は除外）                  │    │
│  └───────────────────────────────────────────────────┘    │
│      │                                                     │
│      ├─ 異常時 → Discord / Telegram に通知                 │
│      │                                                     │
│      └─ 修復対象あり → 自動修復（下記ルール）              │
│          • 修復前に必ずバックアップ取得                    │
│          • 除去対象: type !== "message" の孤児行のみ        │
│          • 絶対触らない: user / assistant メッセージ行     │
└────────────────────────────────────────────────────────────┘
```

---

## 3. カーネル側ガード仕様

### 3.1 対象 API（セッション jsonl の書き込み経路）

**介入方式の方針転換（BLOCKER 1 対応）**:

初版案の `guardSessionAppend({ sessionFile, leafId, newId, newParentId })` は実装不可能だった。`newId` / `newParentId` は `SessionManager.appendMessage()` 内部（`_appendEntry` → `_persist`）で生成・決定されるため、**呼び出し側は知る術がない**。代わりに `appendMessage` が返す ID を **post-append** で検証する方式に改める。

```
┌────────────────────────────────────────────────────────────┐
│ KERNEL（dennou-aibou 本体・最薄）                           │
│                                                            │
│  各呼び出し元の SessionManager.appendMessage() /           │
│  appendCustomEntry() 呼び出し                               │
│      ▼                                                     │
│  ┌──────────────────────────────────────────────────┐      │
│  │ guardSessionManager() 既存 seam（再流用）         │      │
│  │   src/agents/session-tool-result-guard-wrapper.ts │      │
│  │   :21 で SessionManager を受け取り、              │      │
│  │   :44-52 で before_message_write フックを         │      │
│  │   装着 / 以降のラッパーを生成する                   │      │
│  │   ※ 本ガードは appendMessage() ラッパを          │      │
│  │     ここで追加する（最小差分）                      │      │
│  └──────────────────────────────────────────────────┘      │
│      │                                                     │
│      ▼                                                     │
│  呼び出し側コード                                            │
│   戻り値 id を受け取り、getEntry(id) で存在確認             │
│   NG → ログ記録 + 修復ジョブ起動（書き込みは取り消し不可）  │
└────────────────────────────────────────────────────────────┘
```

#### 介入経路一覧（append / 書き換え系を全て列挙）

| 分類                                                                               | ファイル:行                                                       | 概要                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **append 系（ガートの主射程・raw `SessionManager.open()` を 3 箇所で要置換）**     | `src/agents/command/attempt-execution.ts:263`                     | コマンド系サブ実行経路。:273 / :281 で `sessionManager.appendMessage(...)`。**`SessionManager.open(...)` を `guardSessionManager(SessionManager.open(...), ...)` に置換**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| append 系                                                                          | `src/gateway/server-methods/chat-transcript-inject.ts:70`         | Gateway からの transcript 注入。:71 で `sessionManager.appendMessage(messageBody)`。**raw `SessionManager.open(...)` を `guardSessionManager(...)` に置換**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| append 系（ミラー）                                                                | `src/config/sessions/transcript.ts:165`                           | `appendAssistantMessageToSessionTranscript`（delivery mirror）。:166 で `sessionManager.appendMessage(message)`。**raw `SessionManager.open(...)` を `guardSessionManager(...)` に置換**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **間接書き込み経路（既に seam 経由で wrapped instance が流入するため自動カバー）** | `src/agents/pi-embedded-runner/replay-history.ts:328,357`         | `MODEL_SNAPSHOT_CUSTOM_TYPE = "model-snapshot"`（:42）。`createProviderReplaySessionState(sessionManager)` (:300) を介した `appendCustomEntry` (:328) と `appendModelSnapshot()` (:355) 内の `appendCustomEntry` (:357)。呼び出し元 `src/agents/pi-embedded-runner/run/attempt.ts:1201` / `src/agents/pi-embedded-runner/compact.ts:822` の `sanitizeSessionHistory()` が `params.sessionManager` として渡した SessionManager は、呼び出し元で既に `guardSessionManager()` 装着済みの wrapped instance（`src/agents/pi-embedded-runner/run/attempt.ts:822` / `src/agents/pi-embedded-runner/compact.ts:730`）。よって本ガード装着後は本経路も post-append 検証の対象として**自動カバーされる**（前回事故の孤児 146 件中 112 件を占める `model-snapshot` 経路） |
| 間接書き込み経路                                                                   | `src/plugins/provider-replay-helpers.ts:116`                      | `markGoogleTurnOrderingMarker()` 内の `sessionState.appendCustomEntry(GOOGLE_TURN_ORDERING_CUSTOM_TYPE, ...)`。`sessionState` は `replay-history.ts:300` で `sessionManager`（wrapped instance）から構築されるため、同様に**自動カバー**される                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **書き換え系（ガートの射程外）**                                                   | `src/agents/pi-embedded-runner/run/attempt.sessions-yield.ts:219` | 唯一の `_rewriteFile?.()` 呼び出し元。`sessionManager?._rewriteFile?.()` を呼び JSONL を直接書き換える。検知はプラグイン側ヘルスチェックが担う                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 書き換え系                                                                         | `src/agents/pi-embedded-runner/transcript-rewrite.ts:205`         | raw `SessionManager.open(params.sessionFile)`（:205）→ `branch()` / `resetLeaf()` で枝分かれをリセット → `getRawSessionAppendMessage(params.sessionManager)`（:166）で分岐末尾を `appendMessage` 再 append（:166-179）して JSONL を直接書き換える。検知はプラグイン側ヘルスチェックが担う                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 書き換え系                                                                         | `src/gateway/server-methods/chat.ts:472`                          | チャット送信ホットパスのメディアパス書き換え。`SessionManager.open(params.transcriptPath)`（:445）で開いた SessionManager の `getBranch()` 末尾の `user` メッセージに対し `MediaPath` / `MediaPaths` を上書きし、`branch()` で leaf を付け替える。検知はプラグイン側ヘルスチェックが担う                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 書き換え系                                                                         | `src/agents/pi-embedded-runner/context-engine-maintenance.ts:32`  | `buildContextEngineMaintenanceRuntimeContext()` の `rewriteTranscriptEntries` クロージャ（:32）から `transcript-rewrite.ts` の書き換え関数を呼び出すための独立した入口。context-engine ランタイムにトランスクリプト書き換えヘルパを付与する責務を持つ。検知はプラグイン側ヘルスチェックが担う                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 書き換え系                                                                         | `src/agents/pi-embedded-runner/tool-result-truncation.ts:227`     | raw `SessionManager.open(sessionFile)`（:227）→ oversized tool result を `branch()` 上で切り詰めて再構成する独立入口。呼び出し元は `src/agents/pi-embedded-runner/run.ts:1032` の `truncateOversizedToolResultsInSession()`。検知はプラグイン側ヘルスチェックが担う                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 書き換え系                                                                         | SDK 側 `_rewriteFile()`                                           | pi-coding-agent の内部実装。`SessionManager._rewriteFile()` は private。`transcript-rewrite.ts` / `session-truncation.ts:42` / `tool-result-truncation.ts:227` は直接の `_rewriteFile` 呼び出しを持たず、`src/agents/pi-embedded-runner/run/attempt.sessions-yield.ts:219` を唯一の **`_rewriteFile` 呼び出し**侵入口とする                                                                                                                                                                                                                                                                                                                                                                                                                                    |

> **カーネル側ラッパの観測範囲に関する注意**: 上記 3 つの raw `SessionManager.open()` 経路と、`guardSessionManager()` 済み instance を介した間接経路のみが本書のガート射程。SDK 内部からの append 呼び出しはカーネル側ラッパでは観測できない。具体的には `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1204,1237,1260` の `appendModelChange`、`:1283` の `appendThinkingLevelChange`、`:1432,1670` の `appendCompaction`、`main.js:558` の `appendSessionInfo` が該当。これらは SDK 側で直接 `SessionManager` を操作するため、`guardSessionManager()` のラッパを迂回する。検知は §4 のプラグイン側ヘルスチェックが担う。

#### 経路別装着指示（Phase 1 の実装箇所）

3 箇所の raw `SessionManager.open()` を以下の要領で `guardSessionManager(SessionManager.open(...), ...)` に置換する。`guardSessionManager` は冪等（`flushPendingToolResults` 存在チェック: `src/agents/session-tool-result-guard-wrapper.ts:40-41`）なので二重装着は安全。

| #   | ファイル:行（現在）                                       | 置換後                                                                                                                  |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/agents/command/attempt-execution.ts:263`             | `const sessionManager = guardSessionManager(SessionManager.open(sessionFile), { agentId, sessionKey, ... });`           |
| 2   | `src/gateway/server-methods/chat-transcript-inject.ts:70` | `const sessionManager = guardSessionManager(SessionManager.open(params.transcriptPath), { agentId, sessionKey, ... });` |
| 3   | `src/config/sessions/transcript.ts:165`                   | `const sessionManager = guardSessionManager(SessionManager.open(sessionFile), { agentId, sessionKey, ... });`           |

> 注: `src/agents/pi-embedded-runner/run/attempt.ts:822` / `src/agents/pi-embedded-runner/compact.ts:730` は既に `guardSessionManager(...)` で装着済み（変更不要）。これらを経由する `src/agents/pi-embedded-runner/run/attempt.ts:1201` / `src/agents/pi-embedded-runner/compact.ts:822` の `sanitizeSessionHistory()` 呼び出しは、wrapped instance を受け継ぐため §3.1 表の「間接書き込み経路」を自動カバーする。

#### 設計判断

- **ゲートは `guardSessionManager()` 内部で装着する**。`appendMessage` / `appendCustomEntry` をラッパして post-append 検証を行う。これは `before_message_write` フック（装着は `src/agents/session-tool-result-guard-wrapper.ts:44-52`）とは独立した seam として、同じ `guardSessionManager()` 呼び出しの中で同時に装着する（`src/agents/session-tool-result-guard-wrapper.ts:21, 40-41` の冪等チェック含む）。
- 呼び出し側（`src/agents/pi-embedded-runner/run/attempt.ts` / transcript.ts など）は **ガートの存在を意識しない**。既存の `sessionManager.appendMessage()` / `appendCustomEntry()` を呼ぶだけで、ログと検証だけが増える。
- 書き換え系（`src/agents/pi-embedded-runner/run/attempt.sessions-yield.ts:219` の `sessionManager._rewriteFile?.()` 呼び出し、および SDK 内部実装 `_rewriteFile()`）は JSONL を直接破壊し得るため **ガートの対象外**。`transcript-rewrite.ts` / `session-truncation.ts:42` / `tool-result-truncation.ts:227` は直接の `_rewriteFile` 呼び出しを持たず、唯一の **`_rewriteFile` 呼び出し**侵入口は `src/agents/pi-embedded-runner/run/attempt.sessions-yield.ts:219`。なお `transcript-rewrite.ts` / `context-engine-maintenance.ts` / `gateway server-methods/chat.ts` / `tool-result-truncation.ts` はそれぞれ独立した書き換え入口を持つが、いずれも `branch()` / `resetLeaf()` / `getRawSessionAppendMessage()` を介した再 append による JSONL 書き換えであり、§3.1 表 行7-11 に独立行として列挙済み。検知は §4 のプラグイン側ヘルスチェックが担う。
- **SDK 内部からの append はカーネル側ラッパでは観測できない**: `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1204,1237,1260` の `appendModelChange`、`:1283` の `appendThinkingLevelChange`、`:1432,1670` の `appendCompaction`、`main.js:558` の `appendSessionInfo` が該当。これらは SDK 内で `SessionManager` を直接操作するため、`guardSessionManager()` のラッパをバイパスする。検知は §4 のプラグイン側ヘルスチェックが担う。

### 3.2 ガード関数の責務

`guardSessionManager()` の戻り値である `GuardedSessionManager` に対し、`appendMessage` と `appendCustomEntry` のラッパを追加する（既存ラッパと同じ実装パターン）。ラッパは呼び出し後、`appendMessage()` の戻り値 ID を `getEntry(id)` で存在確認する。

```ts
// src/agents/session-integrity-guard.ts (新規・数行)
export function verifyAppendedEntry(
  sessionManager: SessionManager,
  appendedId: string,
): { ok: true } | { ok: false; reason: string } {
  const entry = sessionManager.getEntry(appendedId); // ★ public API を使用
  if (!entry) {
    return { ok: false, reason: `entry not found after append: ${appendedId}` };
  }
  // getLeafId() も public。leaf が不正に分裂していないか軽量チェック
  const leafId = sessionManager.getLeafId();
  if (leafId !== null && !sessionManager.getEntry(leafId)) {
    return { ok: false, reason: `leaf id not found: ${leafId}` };
  }
  return { ok: true };
}
```

> **Note**: `SessionManager.byId` は `private` 修飾されている（`session-manager.d.ts:192`）。`getEntry(id)` / `getLeafId()` は `public` なのでこちらを使う。

- 整合性ラッパは `[RAW_APPEND_MESSAGE]` を生 append に設定してプロトコルを継承する（`session-tool-result-guard.ts:19-22`）。これにより本ガードは tool-result ガードと同じ `originalAppend` を参照し、二重装着時も `installSessionToolResultGuard` のラッパを迂回せずに検証フックを通す。
- `appendMessage` のラッパ実装は `src/agents/session-tool-result-guard-wrapper.ts:21` の `guardSessionManager()` の中で、`installSessionToolResultGuard` 呼び出しの**後段**に装着する。これにより最終チェーンは `sm.appendMessage -> integrityWrapper -> toolResultWrapper -> rawAppend`（integrity が最外側、post-append 検証は tool-result 変換後の最終状態に対して走る）。
- post-append 検証は **書き込みが成功した後**に行うため、ガートに失敗してもファイルからの行削除はしない（削除は安全でないため）。代わりに **ログ記録 + 修復ジョブ起動** で対応する。

チェック内容:

1. **post-append 存在チェック** — `appendMessage` の戻り値 ID を `getEntry(id)` で取得し、`undefined` ではないこと
2. **leaf 整合チェック** — `getLeafId()` の戻り値 ID が `getEntry()` で引けること（メモリ上 leaf ポインタの不整合検知（ファイルレベルの分裂は §4.2））

### 3.3 拒否時の動作

- **書き込みは取り消さない**（post-append 検証のため、既にファイルに書かれている）。代わりに **検知ログ + メトリクス + プラグイン側修復ジョブの起動** を行う
- ログ出力: `createSubsystemLogger("sessions/integrity")` で `level: "error"`、`sessionFile` / `appendedId` / `reason` を含む
- メトリクス: `src/infra/event-pump.ts` に**既存のカウンタパターンは存在しない**（2026-09-04 コード読み合わせ確認）。`createSubsystemLogger("sessions/integrity")` の ERROR ログを 1 ログ/イベントで出力し、プラグイン側 (§4) の cron ヘルスチェックが集計する方式を採用する。代替案として、カーネル内に module-private な `let sessions_guard_reject_total = 0` カウンタを 1 つ持ち、`process.once("exit")` でログにダンプする方式も可（ただし Phase 1 では最小実装のため未実装。プラグイン側通知まで遅延通知で集約する）
- 修復ジョブ起動: §4 プラグイン仕様の `repair` を呼び出す。受け皿は **`src/process/command-queue.ts` の `CommandLane.Main`**（`enqueueCommand()`）にエンキューする。`event-pump.ts` のジョブキューは存在しないため流用不可。プラグイン側への通知は「CommandLane に積んだタスクが `register(api)` 内の `onStartup` で await する」「または、プラグインが `cron` サービスの 1 分粒度ポーリングで孤児検知結果を取りに来る」のいずれかで Phase 2 で確定する

### 3.4 性能影響

1 回の書き込みで増えるコスト:

| 項目             | 想定                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| 追加ファイル I/O | 0（読み込みはメモリ上の `byId` を再利用するだけで追加 I/O は発生しない） |
| 追加 CPU         | O(1) 1 走査（getEntry / getLeafId は Map 参照のみ）                      |
| 追加レイテンシ   | **< 1ms**（実測ターゲット）                                              |
| メモリ           | 追加なし                                                                 |

ホットパス（毎ターンの append）で常時動くため、**絶対に同期 I/O を増やさない・外部 RPC をしない** を満たすこと。

---

## 4. プラグイン側仕様

### 4.1 配置

```
extensions/session-integrity-guard/
├── openclaw.plugin.json       # kind: "memory", config schema
├── package.json
├── src/
│   ├── index.ts               # register(api) エントリ
│   ├── health-check.ts        # 孤児・構文・重複・leaf 数の計測
│   ├── repair.ts              # 自動修復（限定ルール）
│   ├── notify.ts              # Discord / Telegram 通知文面
│   └── backup.ts              # 修復前自動バックアップ
└── test/
    ├── health-check.test.ts
    ├── repair.test.ts
    └── notify.test.ts
```

プラグイン登録は `extensions/memory-core/src/dreaming.ts:264` の `resolveCronServiceFromStartupEvent()` パターンに倣い、startup イベントで `cron` サービスを取得 → `cron.add()` でジョブ登録。

### 4.2 ヘルスチェック項目

| 項目         | 計測方法                                                                                                               | 閾値（推奨）        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 孤児ノード数 | `parentId !== null` かつ `parentId` が他行にも出現しない行数                                                           | **> 0 で警告**      |
| JSON 構文    | 全行 `JSON.parse()` が成功するか                                                                                       | エラー 1 件でも警告 |
| 重複 ID      | `id` の集合と全行数が一致するか                                                                                        | エラーで警告        |
| leaf node 数 | `parentId` として他行から**一度も参照されない**ノード群。ただしヘッダ行（`type: "session"`）は leaf 計算から除外する。 | > 1 で警告          |

> **孤児定義の補足**: ルート行（`parentId === null`）は孤児ではない。

### 4.3 cron 実行間隔

**推奨: 毎日 1 回（深夜帯）** を `0 3 * * *` でデフォルトとする。設定で変更可能。

- 根拠: KASOU のセッション破損は「累積的」であり 1 日粒度で十分検知できる。頻繁にし過ぎると正常セッションの I/O が増える。
- 初回起動時の 1 回即時実行も任意で有効化（環境変数 `SESSION_INTEGRITY_RUN_ON_BOOT=1`）。

### 4.4 異常時の通知

#### Discord / Telegram 通知文面例（健康チェック NG 時）

```
⚠️ [session-integrity-guard] 異常検知
セッション: 93fcc1a8-7563-4cf2-b9f1-e4552e7e444f
- 孤児ノード: 12 個（snapshot: 9 / error: 3）   ※ ログ上は type ごとに内訳
- leaf node: 5 本に分裂（ヘッダ行除く）
- JSON 構文: OK
- 重複 ID: 0
自動修復: 実行しました / 保留しています（要確認）
バックアップ: <path>/sessions.bak.YYYYMMDD-HHmmss
```

通知は `cron` の `delivery` フィールド（`mode: "announce"` / `channel: "discord"` or `"telegram"`）を使用。`extensions/memory-core/src/dreaming.ts:75-77` の `CronServiceLike` を経由。

### 4.5 自動修復ルール

| 区分             | 内容                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **除去してよい** | 親不在かつ **`type !== "message"` の行のみ**（toolResult を含む message 行のツリー文脈復元への影響を考慮し、安全側で message 行を全て除外する。詳細は下記） |
| **絶対触らない** | `user` / `assistant` メッセージ行、`session` ヘッダ、ルート（`parentId: null`）、`type === "message"` の行全般                                              |
| **修復前に必ず** | `<file>.bak.YYYYMMDD-HHmmss` としてバックアップ取得                                                                                                         |
| **判断ロジック** | `parentId !== null && !byId.has(parentId) && entry.type !== "message"` で孤児判定し、除去対象を限定する                                                     |

> **統一方針（MED 1 対応）**: §2 図・§5.4・§8.1 と本表および下記 `isRemovableOrphan` の判定を **`type !== "message"` である孤児行のみ除去** に統一する。「`type !== "message"` の孤児行」は `model_snapshot` / `prompt_error` / `openclaw:*` 等のカスタムエントリにヒットする。`type === "message"` 行（user / assistant / toolResult / system 等）は **`isRemovableOrphan` で `false` を返す**ことで、ツール結果のツリー文脈復元に必要な行を誤って削除しないようにする。

#### 除去対象の絞り込み詳細

修復対象 = 孤児かつ `type !== "message"` の行。`isRemovableOrphan` は以下で定義する:

```ts
function isRemovableOrphan(entry: SessionEntry, _byId: Map<string, SessionEntry>): boolean {
  if (entry.type !== "message") {
    return true; // model_snapshot / prompt_error / openclaw:* は message 以外 → 孤児なら除去可
  }
  // type === "message" はツリー文脈復元の要となるため、role に関わらず一切触らない（安全側）
  return false;
}
```

修復対象行の抽出:

```ts
const removableOrphans = entries.filter(
  (e) => e.parentId !== null && !byId.has(e.parentId) && isRemovableOrphan(e, byId),
);
```

> **Note（MED 4 補足）**: `model_snapshot` / `prompt_error` は旧ランタイム（pi-coding-agent 0.x 系）由来の **レガシー型**であり、現行ランタイムでは `model-snapshot` / `prompt-error`（ハイフン）に統一されている。いずれも custom entry として `type !== "message"` でヒットするため、上記ロジックで等価に除去対象になる。型名分岐はしない（未定義カスタム型を将来追加する余地を残す）。

修復は**ドライラン → 実適用** の 2 段階で行い、ドライラン結果（除去対象行番号のリスト）をログに残す。

---

## 5. データフロー図

### 5.1 正常書き込み時

```
[呼び出し元]
   │ sessionFile, message
   ▼
guardSessionManager(SessionManager.open(sessionFile), ...)   // seam で appendMessage ラッパ装着
   │
   ├─ sessionManager.appendMessage(message)   ← ラッパで呼び出し
   │   └─ appendMessage ラッパ内部:
   │       ├─ const id = underlyingAppendMessage(message)
   │       ├─ verifyAppendedEntry(sessionManager, id)
   │       │   ├─ sessionManager.getEntry(id) !== undefined ?  ✓
   │       │   └─ sessionManager.getLeafId() が存在する ?      ✓
   │       │   → { ok: true }
   │       └─ return id
   │
   ├─ emitSessionTranscriptUpdate(...)        ← 既存通知
   │
   └─ 呼び出し元に id を return
```

### 5.2 拒否時

```
[呼び出し元]
   ▼
guardSessionManager(SessionManager.open(sessionFile), ...)
   │
   ├─ sessionManager.appendMessage(message)   ← ラッパで呼び出し
   │   └─ appendMessage ラッパ内部:
   │       ├─ const id = underlyingAppendMessage(message)  ← ファイルには既に書き込まれた
   │       ├─ verifyAppendedEntry(sessionManager, id)
   │       │   ├─ sessionManager.getEntry(id) === undefined ? ✗
   │       │   └─ → { ok: false, reason: "entry not found after append: <id>" }
   │       └─ 検知ハンドラ起動:
   │           ├─ log.error({ sessionFile, appendedId: id, reason })
   │           └─ CommandLane (src/process/command-queue.ts) にエンキュー → プラグイン側 repair タスク起動
   │
   ├─ ファイル上の行はそのまま（post-append なので削除しない）
   │
   └─ return id   ← 呼び出し元には ID を返すが、ガート側は検知をログとプラグインに伝える
```

### 5.3 定期チェック時（cron 1 日 1 回）

```
cron: 0 3 * * *  →  startSessionIntegrityCheck()
   │
   ├─ 対象セッション jsonl を列挙
   │
   ├─ 各ファイルに対し:
   │   ├─ parseSessionEntries(content)         ← pi-coding-agent 由来
   │   ├─ byId 構築 → 孤児数 / 構文 / 重複 / leaf 数を算出
   │   └─ 結果をレポートに集約
   │
   ├─ レポート判定
   │   ├─ 全項目 OK → 正常終了（ログのみ）
   │   └─ 1 件以上 NG → 通知経路へ + 自動修復判定
   │
   └─ cron job state.lastStatus 更新
```

### 5.4 自動修復時

```
異常検知 → 修復ジョブ起動
   │
   ├─ 修復対象抽出
   │   └─ type !== "message" の孤児行のみ（N 件）
   │
   ├─ ドライラン
   │   ├─ バックアップ取得: <file>.bak.<timestamp>
   │   └─ 適用後の行数 / 孤児数 / leaf 数をログ
   │
   ├─ 実適用（YAML 設定の `auto_repair: true` 時のみ）
   │   ├─ ファイルを tmp → rename で原子的置換
   │   ├─ 修復後セッションで再ヘルスチェック
   │   └─ 結果を通知
   │
   └─ 失敗時 → バックアップから手動戻し手順を通知文に含める
```

---

## 6. テスト計画

### 6.1 ユニットテスト（カーネル側）

`src/agents/session-integrity-guard.test.ts`（新規）

| ケース                                                   | 期待結果                                                |
| -------------------------------------------------------- | ------------------------------------------------------- |
| 正常: `appendMessage` 後 `getEntry(id)` が存在する       | `{ ok: true }`                                          |
| 異常: `appendMessage` 後 `getEntry(id)` が `undefined`   | `{ ok: false, reason: "entry not found after append" }` |
| 異常: `getLeafId()` が返す ID が `getEntry()` で引けない | `{ ok: false, reason: "leaf id not found" }`            |
| 正常: ヘッダ行のみ存在し leafId=null                     | `{ ok: true }`                                          |

### 6.2 統合テスト（プラグイン側）

`extensions/session-integrity-guard/test/health-check.test.ts`

- 健全なセッションを 1 ファイル与えて `health_check()` が 4 項目とも OK を返す
- 孤児 3 件混ぜたセッションで `orphan_count === 3`、`leaf_count === 1`（分裂前）/ 2（分裂後）

`extensions/session-integrity-guard/test/repair.test.ts`

- 孤児 3 件を含むセッションで `repair()` を呼ぶ → 修復後のファイルに孤児 0 / 行数 -3
- 修復前にバックアップファイルが生成されている
- 修復後、user / assistant 行は変化しない（行ハッシュ比較）

### 6.3 負荷想定

| 規模                            | 想定挙動                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| セッション 1000 行              | ガード追加レイテンシ < 1ms                                                                       |
| セッション 10⁴ 行               | ガード追加レイテンシ < 5ms                                                                       |
| セッション 10⁵ 行（異常ケース） | ガードで**検知**され、ログと修復ジョブキューへのエンキューが起きる（書き込みは既に行われている） |

ベンチは `vitest.performance-config.ts` の既存パターン（`experimental.fsModuleCache` / `experimental.importDurations` 設定ヘルパー）に乗せる。

---

## 7. 実装フェーズ

| フェーズ    | 内容                                                                                                                                                                                                   | 完了条件                                                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 1** | カーネル側ガード最小実装（`session-integrity-guard.ts` 新規 + `guardSessionManager` への appendMessage ラッパ装着 + §3.1 表の全 raw `SessionManager.open()` 経路 3 箇所の `guardSessionManager` 置換） | (a) ユニットテスト全件 PASS、(b) 既存 `transcript.test.ts` 全件 PASS、(c) ガード有効化後に既存セッションへの追加書き込みで副作用なし、(**d**) §3.1 表の **全 append 経路（raw `SessionManager.open()` 3 箇所 + 間接書き込み経路 2 箇所）が `guardSessionManager()` 経由の wrapped instance になっている**こと |
| **Phase 2** | プラグイン雛形作成 + cron 登録                                                                                                                                                                         | (a) `extensions/session-integrity-guard/` パッケージ生成、(b) 起動時 startup イベントで cron 取得 → 日次ジョブ登録、(c) ヘルスチェック関数のみ有効（通知・修復は未配線）                                                                                                                                      |
| **Phase 3** | 通知 + 自動修復                                                                                                                                                                                        | (a) Discord / Telegram への異常通知が実機で 1 通届く、(b) ドライラン→実適用の 2 段階が意図通り動作、(c) **修復後の再パースで孤児 0 件** かつ **修復前と user/assistant 行のハッシュが一致** かつ **バックアップファイル `<file>.bak.<ts>` が存在** の 3 点を検証ログに記録                                    |

各フェーズ完了時に `DENNOU_DOCS/` 配下のチェックリスト（任意）にチェックを入れる。

---

## 8. リスクと非スコープ

### 8.1 リスク

| リスク                                               | 緩和策                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ガード過剰検知**: 本来正当な書き込みを止めてしまう | (a) ガードのチェック 2 項目は最小限（post-append 存在 / leaf 整合）に限定、(b) post-append 検証のため**書き込みを取り消さず検知のみ**で反応（ファイル変更はプラグイン側修復に委ねる）、(c) kill switch `DENNOU_SKIP_INTEGRITY_GUARD=1` を用意 |
| **性能劣化**: ホットパスへの追加コスト               | O(1) 1 走査のみ・同期 I/O なし。ベンチで < 1ms を確認                                                                                                                                                                                         |
| **修復の誤作動**: 「絶対触らない」行を誤って削除     | 修復対象を「`type !== "message"`」で型レベルに絞り込み、`message.role === "user" \| "assistant"` の行を**プログラム的に選択不可能**にする（型名分岐はしない）                                                                                 |
| **バックアップ肥大**: 1 日 1 回フルバックアップ      | ローテーション（直近 N 件保持）は将来課題（§8.2）                                                                                                                                                                                             |

### 8.2 非スコープ（将来課題として明記）

以下は**本書の対象外**とし、明示的に将来フェーズへ送る:

1. **他セッション jsonl ファイル横断の整合性** — 単一ファイル内の孤児検出に限定。複数ファイル間の親子参照は別タスク。
2. **`sessions.json`（メタデータ）自体の整合性** — `saveSessionStoreUnlocked()` 経路は別の整合性問題（期限切れエントリ等）が主。本書では扱わない。
3. **過去ログの一括再修復** — 2026-09-04 の手作業修復は完了済みであり、本書はその再発防止策。再修復ツールの汎用化はしない。
4. **バックアップローテーション自動化** — 修復時のバックアップは毎回新規作成。N 件を超えたら古いものを消す仕組みは将来。
5. **マルチエージェント横断の整合性** — 1 セッション内のツリー整合性に限定。エージェントをまたぐ参照は別問題。
6. **通知の重複抑制・クールダウン** — 1 日 1 実行なので当面不要だが、同じ異常の連続通知抑制は将来。
7. **`appendAssistantMessageToSessionTranscript`（`src/config/sessions/transcript.ts:165-166`、§3.1 表 行3）のセッション書き込みロック未取得** — 現状、delivery mirror 経路では `acquireSessionWriteLock` を取得せずに `SessionManager.appendMessage()` を呼んでいる。ロック未取得の他の append 経路（§3.1 表 行1・行2 = `src/agents/command/attempt-execution.ts:263` と `src/gateway/server-methods/chat-transcript-inject.ts:70`）と競合し得、`byId` のメモリ状態がレースする可能性がある。本書はガートの装着のみを対象とし、ロックの取得は別タスクとする。

---

## 9. 関連参照

- 被害実体: `DennouAibou/src/config/sessions/transcript.ts`（セッション jsonl 書き込み窓口）
- 被害実体（セッション構造）: `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts`（`id` + `parentId` のツリー）
- 方針整合: `DENNOU_DOCS/PHASE_F_SLIM_KERNEL.md`（カーネルは細く・プラグインに逃がす）
- プラグイン雛形参考: `extensions/memory-core/src/dreaming.ts`（cron 取得 → `cron.add()` の標準パターン）
- 類似の追加フック: `src/config/sessions/store.ts:72` の `setAfterSaveHook()`（ストア保存後フックの登録パターン）。`AfterSaveHook` 型は `:64`

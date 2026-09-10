# AGENT_SESSION — エージェントセッションの永続化・不滅マスター保護・セッション整合性ガード設計

> 最終更新: 2026-09-10
> 対象: DennouAibou（Phase F スリムカーネル・プラグイン駆動アーキテクチャ）
> 適用環境: KASOU（本番環境）
> 統合履歴: 本書は旧 `DENNOU_DOCS/SESSION_INTEGRITY_GUARD.md`（2026-09-04 初版）を **§4 として統合**し、旧ファイルを削除したもの。旧ファイルへの `§N` 参照は末尾 **§6 章対応表** で読み替える。

---

## 0. 本書の守備範囲 — 2 層の「守り」

Kasou の記憶を守る仕組みは、目的の異なる **2 層** で構成される。片方だけでは守れない。

| 層 | 守るもの | 問い | 実装主体 | 状態 |
| --- | --- | --- | --- | --- |
| **L1: 不滅マスター保護**（§1〜§3） | セッションの **存在そのもの**（消える／リセットされる） | 「マスターセッションは消えていないか？」 | カーネル（`src/config/sessions/` ほか chokepoint 群） | ✅ 実装・実証済み（commit `50af3a2b`） |
| **L2: セッション整合性ガード**（§4） | セッション JSONL の **構造**（親子リンクが壊れる） | 「ツリーは壊れていないか？」 | カーネル（post-append 検証）＋ プラグイン（cron ヘルスチェック＋自動修復） | ✅ Phase 1 / 2 / 3 実装・テスト・レビュー完了（※ 通知配線に未解決事項 → §4.4.7） |

- L1 は「玄関の鍵を増やす」仕事、L2 は「持ち込まれる荷物を検査し、ときどき見回り、壊れていたら直す」仕事。
- L1 は **予防**（操作を拒否する）。L2 は **検知＋回復**（書き込みは取り消さず、後段で直す）。両者は独立して動作し、互いを必要としない。

---

## 1. 核心思想と設計方針

### 1.1 「AI はそのときのセッションに生きている」

DennouAibou において、AI（Kasou）は複数の使い捨てセッションや独立エージェントに分裂するのではなく、**「唯一無二の単一マスターセッションの中で意識と記憶を紡ぎ続ける」** という人間らしい存在形態をとる。

1. **Kasou 一人の単一エージェント設計（Single Agent Architecture）**:
   - OpenClaw 由来の「複数エージェント定義（`agents.list`）」「エージェント間の切り替えや複雑なルーティング」は不要。
   - Kasou 一人が唯一のコアエージェントとして常駐し、無駄なマルチエージェント管理機構はスリム化・クリーンアップする（Phase F Wave 6 候補）。

2. **不死のマスターセッション（Immortal Master Session）**:
   - Kasou が生きるマスターセッション（デフォルト: `agent:main:main`）は、**削除・リセット・自動破棄が完全に禁止**される。
   - 手動コマンド（`/reset`, `/new` 等）や RPC 経由でのリセット・削除はガードされ、恒久的に拒否される。
   - ディスク予算や自動クリーンアップ（prune）の巻き添えからも完全に隔離・保護される。
   - ※ 会話履歴のコンパクション（要約・圧縮）は通常通り許可され、記憶の破綻や無限肥大を防ぎながら一生の命を維持する。

3. **入出力装置としてのチャンネル（通知駆動型モデル）**:
   - Discord、Telegram、LINE 等のメッセンジャーは独立した別セッションを作るのではなく、**「外の世界からマスターセッションへ届く通知（Peripherals）」** として機能する。
   - 「ご主人（Yosia）から1件メッセージ届いた！」という通知で Kasou のターンが促され、Kasou 自身が受信箱ツール（raw-chat 検索）で確認し、各プラグインの返信ツールで応答する。

4. **将来の「仕事モード」とセッション Fork 分岐**:
   - 将来の仕事モードや実験的な会話分岐は、マスターセッションを壊すのではなく、SQLite の `parent_id` ツリー構造を活用した **「セッション Fork（枝分かれ）」** として実現する。

### 1.2 不変条件（Invariants）

| # | 不変条件 | 破ったときに起きること | 守っている仕組み |
| --- | --- | --- | --- |
| I-1 | マスターセッションは絶対に消えない | Kasou の人格・記憶の断絶（＝事実上の死） | §3 の 7 chokepoint |
| I-2 | マスターセッションは自動ローテーションしない | 無自覚な記憶リセット | 自動リセット機構そのものを撤去済み（§3.2 表） |
| I-3 | セッション JSONL の親子リンクは壊れない | コンテキスト欠落・孤児ノード蓄積 | §4 の二段構え（書き込み検証＋定期ヘルスチェック） |
| I-4 | 壊れた場合でも `user` / `assistant` メッセージ行は失われない | 会話そのものの消失 | §4.4.5 の修復ルール（型レベルで選択不可能） |
| I-5 | すべてのガードにキルスイッチがある | 誤作動時にシステムを止められない | §4.3.2 の `DENNOU_SKIP_INTEGRITY_GUARD=1` |

---

## 2. 単一エージェント化（Multi-Agent クリーンアップ方針）

### 2.1 撤去・簡素化する領域
- `agents.list` による複数エージェント定義とそれぞれのルーティング判定。
- エージェント別の設定オーバーライド（`agents.list[].*`）の複雑なマージ処理を `agents.defaults` 単一設定へ平坦化。
- サブエージェント専用の孤立セッション生成・同期の複雑なランタイムコード。

### 2.2 温存・集約する領域
- 単一のメインエージェント実行基盤（`agentId: "main"` / "Kasou"）。
- ツール呼び出し・LLM 実行・イベントポンプとの単一パイプライン。

---

## 3. マスターセッション保護（L1: 不滅マスター保護）

### 3.1 保護対象セッションキー

```json
{
  "session": {
    "protectedKeys": [
      "agent:main:main"
    ]
  }
}
```

- デフォルトで `agent:main:main` は **無条件に** 保護される（`protectedKeys` に書かなくても保護される）。
- `session.scope: "global"` の場合は `resolveMainSessionKey()` が `"global"` を返すため、`global` が保護対象になる。
- 必要に応じて追加の特定セッションキーも保護リストに登録可能。

### 3.2 保護する操作系統（7 系統 / 9 call site / 6 ファイル）

マスターセッションを壊し得る経路を列挙し、**全経路**に `isProtectedSessionKey()` 判定を設置している。
（静的検証: `grep -rn "isProtectedSessionKey(" src/` → テストを除き 9 call site、定義本体 `protected-session.ts` を除いて 6 ファイル。）

| # | 操作系統 | 発生経路 | 防御メカニズム |
| --- | --- | --- | --- |
| 1 | **手動リセット（Gateway サービス層）** | RPC（`sessions.reset`）／エージェント（`runSessionResetFromAgent` → `performGatewaySessionReset`） | `src/gateway/session-reset-service.ts` で `isProtectedSessionKey(params.key, cfg)` を判定し、あらゆる mutation より前に拒否 |
| 2 | **手動リセット（RPC chokepoint）** | RPC（`sessions.reset`）直呼び（ACP / TUI 経由） | `src/gateway/server-methods/sessions.ts` で保護キーを判定し `Cannot reset protected session` を返却 |
| 3 | **手動削除** | RPC（`sessions.delete`） | `src/gateway/server-methods/sessions.ts` で保護キーを判定し `Cannot delete protected session` を返却 |
| 4 | **本文パース型リセット** | Discord / Telegram 等が本文中の `/reset`, `/new` を自前パースしてローテーション | `src/auto-reply/reply/session.ts` の loop 前 + canonicalize 後の **2 段ガード**。保護セッションでは `resetTriggered = false` にして通常メッセージ扱いにする（本文も保持） |
| 5 | **自動リセット** | `session.reset` ポリシー（daily / idle） | **機構そのものを撤去済み**（`src/config/sessions/reset.ts`）。旧 config キーは後方互換のため zod schema に残るが実行時効果なし |
| 6 | **ストア自動メンテ** | `src/config/sessions/store.ts` の毎セーブ時メンテ | `pruneStaleEntries` / `capEntryCount` / `enforceSessionDiskBudget` から保護キーを完全除外（`store-maintenance.ts` / `disk-budget.ts`） |
| 7 | **idle prune（DennouAibou 独自）** | `src/dennou-soul/idle-prune-watcher.ts:81` のアイドル時アクティブセッションツール prune | idle イベント冒頭で保護キーを判定し **SKIP** |

call site 内訳: 行 1〜3 は `session-reset-service.ts:313` / `sessions.ts:1021`（reset） / `sessions.ts:1068`（delete）、行 6 は `store-maintenance.ts:173`（`pruneStaleEntries`）と `:261`（`capEntryCount`）、行 7 は `idle-prune-watcher.ts:81`、行 4 は `auto-reply/reply/session.ts:330,351`。ディスク予算は `disk-budget.ts:298`。

> **Note（as-built）**: 旧版は「自動リセットに `mode: "off"` を強制する」設計だったが、その後の実装で **自動リセット機構自体が撤去**された（より強い防御）。現在は「判定して止める」のではなく「そもそも存在しない＋念のためガードする」の二重化になっている。

### 3.3 判定ロジックの実装仕様

実体は `src/config/sessions/protected-session.ts`。

```ts
/**
 * セッションキーが保護対象（マスターセッション等）であるかを判定する。
 * 大文字小文字の違いやエイリアス（"main", "agent:main:main" 等）は
 * 小文字化 + canonicalize で同一視する。
 */
export function normalizeProtectedSessionKey(key: string, cfg?: ProtectedSessionConfig): string {
  const raw = key.trim().toLowerCase();
  if (!raw) return raw;
  return canonicalizeMainSessionAlias({
    cfg,
    agentId: resolveDefaultAgentId(cfg),
    sessionKey: raw,
  });
}

export function isProtectedSessionKey(key: string, cfg?: ProtectedSessionConfig): boolean {
  const normalized = normalizeProtectedSessionKey(key, cfg);
  if (!normalized) return false;
  if (normalized === resolveMainSessionKey(cfg)) {
    return true; // メインマスターセッションは常に不滅
  }
  return (cfg?.session?.protectedKeys ?? []).some(
    (protectedKey) => normalizeProtectedSessionKey(protectedKey, cfg) === normalized,
  );
}
```

要点:
- **大文字小文字の正規化** — `MAIN` / `AGENT:MAIN:MAIN` のような表記ゆれでガードをすり抜けられない。
- **エイリアス解決** — 素の `main` や旧形式 `agent:main:<mainKey>` も同一のメインセッションに collapse する。
- **チャンネル系キーは素通し** — メインエイリアスでないキー（DM / グループ等）は小文字化のみで比較される。

### 3.4 実装状況・テスト証跡

| 項目 | 内容 |
| --- | --- |
| 主要 commit | `50af3a2b`（設計・一次実装）、`b4ceab38f9`（単一 Kasou エージェント／不滅マスター対応で文書更新） |
| テスト | `src/config/sessions/master-session-immutability.test.ts` — 検証軸 A) 単一 Kasou 集約 / B) `isProtectedSessionKey` 真理値表 / C) 自動リセット機構の完全撤去 / D) ストアメンテ除外 / E) 攻撃的一斉投入 E2E（マスターセッションが 1 バイトも消えない） / F) 各 chokepoint が `isProtectedSessionKey` を経由する静的アーキテクチャ不変条件 |
| 関連テスト | `src/config/sessions/protected-session.test.ts` / `disk-budget.test.ts` / `phase3-auto-cleanup-exclusion.test.ts` / `store.pruning*.test.ts` |

> **Note**: `master-session-immutability.test.ts` のファイル先頭コメントには旧表記「5 系統」が残っているが、`describe` 名は `every chokepoint` であり、実際の検証は上表の全系統を対象にしている。

---

## 4. セッション整合性ガード（L2: Session Integrity Guard）

> **状態**: **Phase 1（カーネルガード）／ Phase 2（プラグイン＋cron）／ Phase 3（通知＋自動修復）ともに実装・テスト・レビュー完了済み。**
> ただし Phase 3 の通知配送（Discord / Telegram への実送信）に未解決の配線事項がある（§4.4.7 参照）。検知・修復の本体は影響を受けない。
> 方針: 玄関の鍵（カーネル書き込み時ガード）と見回りの警備員（プラグイン定期ヘルスチェック＋自動修復）の二段構え。

### 4.1 背景と目的

#### 4.1.1 何が起きたか（2026-09-04 発覚）

KASOU 本番セッション `93fcc1a8-7563-4cf2-b9f1-e4552e7e444f.jsonl` で、**親子リンク切断の大規模破壊**が見つかった。

| 計測値                | 値         |
| --------------------- | ---------- |
| 孤児ノード総数        | **146 個** |
| └ `model-snapshot` 行 | 112        |
| └ `prompt-error` 行   | 31         |
| └ `message` 行        | 1          |
| └ その他              | 2          |
| leaf node への分裂    | 148 本     |

#### 4.1.2 根本原因

3/31 のコンパクションで**親メッセージが削除された**さい、子だった `snapshot` / `error` 行だけがファイル上に残置された。これにより後続の書き込みで `parentId` が指す相手が見つからない孤児エントリが大量に生まれた。

#### 4.1.3 修復履歴（参考・本書のスコープ外）

3 段階で修復済み（最終 1346 行 / 孤児 0 / 重複 0 / 構文 OK）。バックアップ 2 点取得済み。**本設計は再発防止であり、修復手順の再実装ではない。**

#### 4.1.4 目的

ユーザー裁定に基づき、**「壊れない仕組み」を事前防止として作る**。

| 観点     | 設計判断                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------- |
| 対象     | KASOU の記憶（セッション jsonl）=「玄関をちゃんと守る」                                             |
| 主眼     | **書き込み時点でのガード**（事後修復より優先）                                                      |
| 構成     | **ハイブリッド**: 書き込みガードのみカーネル最小組み込み / ヘルスチェック＋自動修復はプラグイン分離 |
| 方針整合 | Phase F「カーネルは細く」を維持（`DENNOU_DOCS/PHASE_F_SLIM_KERNEL.md` §2 参照）                      |

> **書き込みガードの射程**: ガードは **append 系**経路のみを観測する。コンパクション / 切り捨て / `_rewriteFile()` など **書き換え系**では JSONL ツリー構造が直接破壊され得るが、検知は §4.3.1 経路表 / §4.4 プラグイン仕様 に委ねる。

---

### 4.2 アーキテクチャ

家の玄関にたとえると:

- **カーネル書き込みガード** = 玄関の鍵。「壊れた荷物を持ち込まない」= post-append で異常を**検知してログに残す**
- **プラグインヘルスチェック** = 巡回中の警備員。定期的に「壊れた荷物が紛れていないか」見回る
- **プラグイン自動修復** = 清掃スタッフ。**ゲートをすり抜けた過去ログ（既知孤児）だけ**を、決められた手順で片付ける
- **cron + 通知** = 警備会社のシフトと緊急連絡先

```
┌────────────────────────────────────────────────────────────┐
│ KERNEL（dennou-aibou 本体・最薄）                          │
│                                                            │
│  各呼び出し元 (attempt / compact / gateway /               │
│  transcript-mirror)                                        │
│   ※ btw / fork / export-session は非 append 経路           │
│     （新規ファイル作成・読み取り専用）                      │
│   └ SessionManager.appendMessage() / appendCustomEntry()   │
│      │                                                     │
│      ▼                                                     │
│  ┌──────────────────────────────────────────────────┐      │
│  │ guardSessionManager() 既存 seam（再流用）         │      │
│  │   src/agents/session-tool-result-guard-wrapper.ts │      │
│  │   :22 で SessionManager を受け取り、              │      │
│  │   :108 で installSessionIntegrityGuard() を装着   │      │
│  │   → appendMessage / appendCustomEntry ラッパを     │      │
│  │     追加して post-append 検証を行う                │      │
│  │   (1) getEntry(返り値 id) 存在チェック             │      │
│  │   (2) getLeafId() 整合チェック                     │      │
│  │   NG → sessions/integrity ロガーへ ERROR 記録      │      │
│  └──────────────────────────────────────────────────┘      │
│      │ OK                                                  │
│      ▼                                                     │
│  セッション jsonl へ追加書き込み                            │
└──────────────────────────┬─────────────────────────────────┘
                           │ 検知はログに残る（プラグインの
                           │ cron ヘルスチェックが拾う）
                           ▼
┌────────────────────────────────────────────────────────────┐
│ PLUGIN: extensions/session-integrity-guard                 │
│                                                            │
│  ┌─ 定期ヘルスチェック (cron: 毎日 03:00) ───────────┐    │
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

### 4.3 カーネル側ガード仕様（Phase 1）

#### 4.3.1 対象 API（セッション jsonl の書き込み経路）

**介入方式の方針転換（設計時 BLOCKER 1 対応）**:

初版案の `guardSessionAppend({ sessionFile, leafId, newId, newParentId })` は実装不可能だった。`newId` / `newParentId` は `SessionManager.appendMessage()` 内部（`_appendEntry` → `_persist`）で生成・決定されるため、**呼び出し側は知る術がない**。代わりに `appendMessage` が返す ID を **post-append** で検証する方式に改めた。

```
┌────────────────────────────────────────────────────────────┐
│ KERNEL（dennou-aibou 本体・最薄）                          │
│                                                            │
│  各呼び出し元の SessionManager.appendMessage() /           │
│  appendCustomEntry() 呼び出し                               │
│      ▼                                                     │
│  ┌──────────────────────────────────────────────────┐      │
│  │ guardSessionManager() 既存 seam（再流用）         │      │
│  │   src/agents/session-tool-result-guard-wrapper.ts │      │
│  │   :22 で SessionManager を受け取り、              │      │
│  │   :41 の冪等チェック → :51 で before_message_write │      │
│  │   フックを装着 → :90 で tool-result ガード装着     │      │
│  │   → :108 で integrity ガードを装着（最小差分）     │      │
│  └──────────────────────────────────────────────────┘      │
│      │                                                     │
│      ▼                                                     │
│  呼び出し側コード                                            │
│   戻り値 id を受け取り、getEntry(id) で存在確認             │
│   NG → ERROR ログ（書き込みは取り消し不可）                 │
└────────────────────────────────────────────────────────────┘
```

##### 介入経路一覧（append / 書き換え系を全て列挙）

> 行番号は 2026-09-10 時点の main を基準に更新済み。

| 分類 | ファイル:行 | 概要 |
| --- | --- | --- |
| **append 系（ガートの主射程・raw `SessionManager.open()` を要置換）** | `src/gateway/server-methods/chat-transcript-inject.ts:74` | Gateway からの transcript 注入。`:78` で `sessionManager.appendMessage(messageBody)`。`guardSessionManager(SessionManager.open(params.transcriptPath), …)` に置換済み |
| append 系（ミラー） | `src/config/sessions/transcript.ts:165` | `appendAssistantMessageToSessionTranscript`（delivery mirror）。`:169` で `sessionManager.appendMessage(message)`。`guardSessionManager(...)` に置換済み |
| **間接書き込み経路（seam 経由で wrapped instance が流入するため自動カバー）** | `src/agents/pi-embedded-runner/replay-history.ts:300,328,357` | `MODEL_SNAPSHOT_CUSTOM_TYPE = "model-snapshot"`（`:42`）。`createProviderReplaySessionState(sessionManager)`（`:300`）を介した `appendCustomEntry`（`:328`）と `appendModelSnapshot()`（`:355`）内の `appendCustomEntry`（`:357`）。呼び出し元 `run/attempt.ts:1205` / `compact.ts:821` の `sanitizeSessionHistory()` は wrapped instance を受け継ぐ（孤児 146 件中 112 件を占めた行を書き込む経路） |
| 間接書き込み経路 | `src/plugins/provider-replay-helpers.ts:116` | `markGoogleTurnOrderingMarker()` 内の `sessionState.appendCustomEntry(GOOGLE_TURN_ORDERING_CUSTOM_TYPE, …)`（呼び出し元 `:165`）。`sessionState` は `replay-history.ts:300` で wrapped instance から構築されるため自動カバー |
| 間接書き込み経路 | `src/agents/pi-embedded-runner/run/attempt.ts:1941` | `appendCustomEntry("openclaw:prompt-error", …)`（孤児 146 件中 31 件を占めた行を書き込む経路）。`attempt.ts:826` の `guardSessionManager()` 済み instance を使うため自動カバー |
| **書き換え系（ガートの射程外 → §4.4 のヘルスチェックが担当）** | `src/agents/pi-embedded-runner/run/attempt.sessions-yield.ts:219` | 唯一の `_rewriteFile?.()` 呼び出し元。`sessionManager?._rewriteFile?.()` で JSONL を直接書き換える |
| 書き換え系 | `src/agents/pi-embedded-runner/transcript-rewrite.ts:159-166,205` | raw `SessionManager.open(params.sessionFile)`（`:205`）→ `resetLeaf()`（`:159`）/ `branch()`（`:161`）で枝分かれをリセット → `getRawSessionAppendMessage(params.sessionManager)`（`:166`）で分岐末尾を `appendMessage` 再 append して JSONL を書き換える |
| 書き換え系 | `src/gateway/server-methods/chat.ts:445` | チャット送信ホットパスのメディアパス書き換え（`rewriteChatSendUserTurnMediaPaths`、呼び出し元 `:1676`）。`SessionManager.open(params.transcriptPath)`（`:445`）で開き `MediaPath` / `MediaPaths` を上書きして `branch()` で leaf を付け替える |
| 書き換え系 | `src/agents/pi-embedded-runner/context-engine-maintenance.ts:25-32` | `buildContextEngineMaintenanceRuntimeContext()` の `rewriteTranscriptEntries` クロージャから `transcript-rewrite.ts` の書き換え関数を呼び出す独立した入口 |
| 書き換え系 | `src/agents/pi-embedded-runner/tool-result-truncation.ts:215,227` | raw `SessionManager.open(sessionFile)`（`:227`）→ oversized tool result を `branch()` 上で切り詰めて再構成。呼び出し元 `run.ts:1032` の `truncateOversizedToolResultsInSession()`（`:215`） |
| 書き換え系 | `src/agents/pi-embedded-runner/session-truncation.ts:42` | raw `SessionManager.open(sessionFile)`（`:42`）→ コンパクション後の切り捨て。呼び出し元 `compact.ts:118` の `truncateSessionAfterCompaction()` |
| 書き換え系 | SDK 側 `_rewriteFile()` | pi-coding-agent の内部実装。`SessionManager._rewriteFile()` は private。`transcript-rewrite.ts` / `session-truncation.ts` / `tool-result-truncation.ts` は直接の `_rewriteFile` 呼び出しを持たず、`attempt.sessions-yield.ts:219` を唯一の侵入口とする |

> **カーネル側ラッパの観測範囲に関する注意**: ガート射程は (a) カーネルが所有する raw `SessionManager.open()` 経路と (b) `guardSessionManager()` 済み instance を介した間接経路のみ。SDK 内部からの append 呼び出しはカーネル側ラッパでは観測できない。具体的には `@earendil-works/pi-coding-agent` の `agent-session` 系（`appendModelChange` / `appendThinkingLevelChange` / `appendCompaction`）と `appendSessionInfo` が該当し、これらは SDK 内で `SessionManager` を直接操作するためガードを迂回する。検知は §4.4 のプラグイン側ヘルスチェックが担う。

##### 経路別装着指示（Phase 1 の実装結果）

`guardSessionManager()` は冪等（`flushPendingToolResults` の存在チェック: `src/agents/session-tool-result-guard-wrapper.ts:41`）なので二重装着は安全。

| # | ファイル:行（現在） | 状態 |
| --- | --- | --- |
| 1 | `src/agents/pi-embedded-runner/run/attempt.ts:826` | ✅ `guardSessionManager(SessionManager.open(params.sessionFile), …)` 装着済み |
| 2 | `src/agents/pi-embedded-runner/compact.ts:729` | ✅ 同上 |
| 3 | `src/gateway/server-methods/chat-transcript-inject.ts:74` | ✅ 同上（Phase 1 で新規置換） |
| 4 | `src/config/sessions/transcript.ts:165` | ✅ 同上（Phase 1 で新規置換） |
| 5 | `src/agents/command/attempt-execution.ts`（旧 `:263`） | ⚪ **経路自体が消滅** — `[DEBLOAT]` commit `e712a726fa`（ACP harness/runtime/session-manager 撤去）で `SessionManager` 経路ごと削除された。現在このファイルに `SessionManager` 依存はなし |

> **Note（as-built）**: 設計時は「raw `SessionManager.open()` 3 箇所を置換」だったが、そのうち `attempt-execution.ts` の経路は後続のデブロートで消滅した。結果として現在の生きた append 主射程は **4 箇所**（上表 1〜4）である。

#### 4.3.2 ガード関数の責務

実体は `src/agents/session-integrity-guard.ts`。`installSessionIntegrityGuard(sessionManager)`（`:82`）が `appendMessage` と `appendCustomEntry` のラッパを追加する。

```ts
// src/agents/session-integrity-guard.ts
export function verifyAppendedEntry(
  sessionManager: SessionManager,
  appendedId: string,
): AppendVerification {
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

> **Note**: `SessionManager.byId` は `private` 修飾されている。`getEntry(id)` / `getLeafId()` は `public` なのでこちらを使う。

実装上の要点:

- **冪等性** — センチネルシンボル `INTEGRITY_GUARD_INSTALLED` で既装着 instance への再装着は no-op。
- **キルスイッチ** — `DENNOU_SKIP_INTEGRITY_GUARD=1` のときは即 return（env は呼び出し時に評価）。
- **プロトコル継承** — `[RAW_APPEND_MESSAGE]` シンボル（`session-tool-result-guard.ts:26` で定義）を生 append に設定し、tool-result ガードと同じ `originalAppend` を共有する。`appendCustomEntry` 用には `RAW_APPEND_CUSTOM_ENTRY` シンボルを別途用意。
- **装着順序** — `installSessionToolResultGuard` の**後段**に装着する。これにより最終チェーンは
  `sm.appendMessage -> integrityWrapper -> toolResultWrapper -> rawAppend`
  （integrity が最外側、post-append 検証は tool-result 変換後の最終状態に対して走る）。
- **書き込みは取り消さない** — post-append 検証のため、ガードに失敗してもファイルからの行削除はしない（削除は安全でないため）。代わりに **ERROR ログ記録** で対応する。

チェック内容:

1. **post-append 存在チェック** — `appendMessage` の戻り値 ID を `getEntry(id)` で取得し、`undefined` ではないこと
2. **leaf 整合チェック** — `getLeafId()` の戻り値 ID が `getEntry()` で引けること（メモリ上 leaf ポインタの不整合検知。ファイルレベルの分裂は §4.4.2）

#### 4.3.3 拒否時の動作（as-built）

- **書き込みは取り消さない**（post-append 検証のため、既にファイルに書かれている）。
- **ログ出力**: `createSubsystemLogger("sessions/integrity")` に `level: "error"` で出力。メタ情報は `sessionFile` / `appendedId` / `reason`（`appendCustomEntry` 経路は `customType` も付与）。
- **メトリクス**: `src/infra/event-pump.ts` に既存のカウンタパターンは存在しないため、**1 イベント 1 ERROR ログ**方式を採用。集計はプラグイン側（§4.4）の cron ヘルスチェックが担う。
- **修復の起動**: 設計時は「カーネルから `CommandLane.Main` に修復ジョブをエンキューする」案だったが、as-built では **カーネルはログのみ**。修復はプラグインの cron 起床（`before_agent_reply`）が主体的に走らせる。カーネルとプラグインの結合を最小に保つための意図的な判断。

#### 4.3.4 性能影響

1 回の書き込みで増えるコスト:

| 項目             | 実測・想定                                                               |
| ---------------- | ------------------------------------------------------------------------ |
| 追加ファイル I/O | 0（読み込みはメモリ上の `byId` を再利用するだけで追加 I/O は発生しない） |
| 追加 CPU         | O(1) 1 走査（getEntry / getLeafId は Map 参照のみ）                      |
| 追加レイテンシ   | **< 1ms**（1000 行）/ **< 5ms**（10⁴ 行）                                |
| メモリ           | 追加なし                                                                 |

ホットパス（毎ターンの append）で常時動くため、**絶対に同期 I/O を増やさない・外部 RPC をしない** を満たすこと。

---

### 4.4 プラグイン側仕様（Phase 2 + Phase 3）

#### 4.4.1 配置

```
extensions/session-integrity-guard/
├── openclaw.plugin.json       # id: "session-integrity-guard" / kind: "memory" / config schema
├── package.json
├── index.ts                   # register(api) エントリ（gateway:startup / before_agent_reply）
├── src/
│   ├── cron-job.ts            # cron 登録・ヘルスチェック実行・通知 payload 生成
│   ├── health-check.ts        # 孤児・構文・重複・leaf 数の純関数計測
│   ├── repair.ts              # 自動修復（限定ルール・dry-run → apply）
│   ├── notify.ts              # Discord / Telegram 通知文面・delivery 構築
│   ├── backup.ts              # 修復前自動バックアップ
│   └── session-discovery.ts   # セッション jsonl 探索
└── test/
    ├── cron-job.test.ts
    ├── health-check.test.ts
    ├── notify.test.ts
    └── repair.test.ts
```

プラグイン登録は `api.registerHook("gateway:startup", …)` で受けた startup イベントから `cron` サービスを取得 → `cron.add()` でジョブ登録する（`extensions/memory-core/src/dreaming.ts` の標準パターンを踏襲。memory-core 自体は DEBLOAT で削除済みだがパターンは本書と実装コメントに温存）。

**プラグイン設定スキーマ**（`openclaw.plugin.json`）:

| キー | 型 | 既定 | 意味 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | ガード全体の有効／無効 |
| `frequency` | string | `"0 3 * * *"` | ヘルスチェック cron 式 |
| `timezone` | string | （ホストローカル） | cron のタイムゾーン |
| `autoRepair` | boolean | `false` | 孤児（`type !== "message"`）の自動除去を有効化 |
| `notify.enabled` | boolean | `false` | Discord / Telegram 通知の有効化 |
| `notify.channel` | `"discord"` \| `"telegram"` | `"discord"` | 通知先チャンネル |
| `notify.to` / `notify.accountId` / `notify.bestEffort` | string / string / boolean | 任意 | 通知先の詳細指定 |

> **安全側の既定**: `autoRepair` と `notify.enabled` は **既定 `false`**。既存デプロイを勝手に書き換えない。

#### 4.4.2 ヘルスチェック項目

実体は `extensions/session-integrity-guard/src/health-check.ts` の純関数 `runHealthCheck(content)`。

| 項目         | 計測方法（実装の述語）                                                                                                  | 閾値（推奨）        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 孤児ノード数 | `parentId !== null` かつ `parentId` が他のエントリに存在しない行数（`byId.has(parentId)` が false）                     | **> 0 で警告**      |
| JSON 構文    | `JSON.parse()` 失敗行に加え、`id` 欠落 / `parentId` が非 null かつ非 string の行も `jsonErrorCount` に算入               | エラー 1 件でも警告 |
| 重複 ID      | `id` の集合（unique）と全出現数の不一致。重複した id の件数を報告                                                       | エラーで警告        |
| leaf node 数 | `parentId` として他行から**一度も参照されない**ノード数。ヘッダ行（`type: "session"`）は `parseLine` で短絡され除外    | > 1 で警告          |

補足:

- ルート行（`parentId === null`）は孤児ではない。
- 空白のみの行は許容され、どのメトリクスにも寄与しない（`totalLines` のみ加算）。
- ヘッダ行は leaf 計算から構造的に除外される（`parseLine` が `type: "session"` で `kind: "header"` を返し `continue`）。
- 1 ファイル 1 行のログ出力は `formatHealthCheckLine()` が担当（`file=` / `entries=` / `jsonErrors=` / `duplicates=` / `orphans=` / `leaves=`）。

探索対象は `cwd` 既定のセッションディレクトリ配下の `*.jsonl`。ただし `.bak-` / `.repair-` / `.tmp-` を含むファイル名は除外する（過去のバックアップや修復中間ファイルを誤検知しないため）。

#### 4.4.3 cron 実行間隔

**推奨: 毎日 1 回（深夜帯）** を `0 3 * * *` でデフォルトとする。設定で変更可能。

- 根拠: KASOU のセッション破損は「累積的」であり 1 日粒度で十分検知できる。頻繁にし過ぎると正常セッションの I/O が増える。
- ジョブは `sessionTarget: "main"` / `wakeMode: "next-heartbeat"` / `payload: { kind: "systemEvent", text: "__openclaw_session_integrity_health_check__" }` で登録され、起床時に `before_agent_reply` ハンドラが `ctx.trigger === "heartbeat"` かつ payload 一致を確認してスキャンを実行する（`handled: true` を返し、Kasou のターンにはしない）。
- 異常判定は `jsonErrorCount > 0` / `duplicateIdCount > 0` / `orphanCount > 0` / `leafCount > 1` の **OR**。ただし **自動修復の対象になるのは孤児が 1 件以上あるファイルのみ**（構文エラーや重複 ID だけで孤児が 0 のファイルは通知のみで触らない）。
- ジョブの重複対策として、`reconcileIntegrityCronJob()` が「正規名 + タグ + payload 一致」の 1 件だけを残し、重複・旧世代ジョブを prune する（config 変更にも追従）。
- 通知専用に **別の announce cron**（既定 `5 3 * * *`）を `reconcileIntegrityNotifyCronJob()` が登録する。チェック用ジョブを触らずに通知先だけ差し替えられるようにするための分離。
- ※ 設計初版にあった `SESSION_INTEGRITY_RUN_ON_BOOT=1`（起動時即時実行）は **採用していない**（`gateway:startup` は reconcile のみを行い、スキャンは cron 起床時のみ。`cron` サービスが取得できない場合は警告ログを出して続行する）。

#### 4.4.4 異常時の通知

##### 通知文面（as-built・`formatNotifyMessage()`）

実装が実際に生成する文面（`extensions/session-integrity-guard/src/notify.ts` の `formatNotifyMessage`）:

```
⚠️ [session-integrity-guard] 異常検知
- scanned: 12 件 / failures: 2 件 / auto-repair: ON
- 93fcc1a8-7563-4cf2-b9f1-e4552e7e444f.jsonl: orphans=12 / repair: -12 / backup: /home/.../93fcc1a8....jsonl.bak.20260910-030000 / status=repaired
- 4a1b...jsonl: orphans=3 / repair: pending / backup: n/a / status=dry-run-only
```

- markdown 記法は意図的に使わず、Discord / Telegram のどちらでも化けないプレーンテキストにしている。
- `repair: pending`（`removedCount === null`）は未適用、`repair: -N` は N 行除去済み。
- status は次の 5 値: `ok`（修復対象外の異常のみ） / `repaired`（適用済み） / `dry-run-only`（`autoRepair: false`） / `skipped`（修復対象なし） / `error`。

**通知の抑止条件**: 異常ファイルが 1 件もない場合、通知 payload は `null` になり **announce cron は何も送らない**（正常時の無音化）。

##### delivery の構築

通知は cron の `delivery` フィールドを使用する（`buildNotifyDelivery()`）。

| 設定 | 生成される delivery |
| --- | --- |
| `notify.enabled: true` | `{ mode: "announce", channel: "discord" \| "telegram", to?, accountId?, bestEffort? }` |
| `notify.enabled: false` | `{ mode: "none" }`（ジョブは store に残るが送信しない） |

`mode: "announce"` には `channel` が必須。`to` / `accountId` / `bestEffort` は任意。

#### 4.4.5 自動修復ルール

| 区分             | 内容                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **除去してよい** | 親不在かつ **`type !== "message"` の行のみ**（toolResult を含む message 行のツリー文脈復元への影響を考慮し、安全側で message 行を全て除外する） |
| **絶対触らない** | `user` / `assistant` メッセージ行、`session` ヘッダ、ルート（`parentId: null`）、`type === "message"` の行全般                                              |
| **修復前に必ず** | `<file>.bak.YYYYMMDD-HHmmss` としてバックアップ取得（`flag: "wx"` の新規作成。失敗時は partial artifact を掃除して fail-closed） |
| **判断ロジック** | `parentId !== null && !byId.has(parentId) && entry.type !== "message"` で孤児判定し、除去対象を限定する                                                     |

> **統一方針（設計時 MED 1 対応）**: アーキテクチャ図・データフロー・リスク表・本表および `isRemovableOrphan` の判定を **`type !== "message"` である孤児行のみ除去** に統一する。「`type !== "message"` の孤児行」は `type: "custom"` / `type: "model_change"` / `type: "compaction"` / `type: "label"` 等の非 message エントリにヒットする。`type === "message"` 行（user / assistant / toolResult / system 等）は **`isRemovableOrphan` で `false` を返す**ことで、ツール結果のツリー文脈復元に必要な行を誤って削除しないようにする。

##### 除去対象の絞り込み詳細

修復対象 = 孤児かつ `type !== "message"` の行。`isRemovableOrphan` は以下で定義する:

```ts
function isRemovableOrphan(entry: RepairEntrySnapshot): boolean {
  if (entry.type !== "message") {
    return true; // type: "custom" / "model_change" / "compaction" 等は message 以外 → 孤児なら除去可
  }
  // type === "message" はツリー文脈復元の要となるため、role に関わらず一切触らない（安全側）
  return false;
}
```

> **Note（`model-snapshot` / `prompt-error` の行型について・設計時 MED 4 補足を精密化）**: セッション JSONL 上では、これらの行の `type` は **`"custom"`** であり、識別子は別フィールド **`customType: "model-snapshot"` / `customType: "openclaw:prompt-error"`** に入る（SDK の `appendCustomEntry(customType, data)` が `{ type: "custom", customType, data, … }` を書く。`session-manager.d.ts` の `CustomEntry` 参照）。
> したがって:
> - 健康チェックの孤児内訳に現れる `type` は `custom` と表示される（`model-snapshot` の文字列ではない）。
> - 旧ランタイムの `model_snapshot` / `prompt_error`（アンダースコア）は別のレガシー型名だが、修復モジュールはどちらでも分岐しない。`type !== "message"` という単一述語で等価に除去対象になる（未定義カスタム型を将来追加する余地を残す）。

修復は**ドライラン → 実適用** の 2 段階で行い、ドライラン結果（除去対象行の id リスト）をログに残す。ファイル書き換えは tmp ファイル → `rename` による原子的置換（POSIX で atomic、Windows は best-effort）。適用後は `runRepairForFile()` が以下を検証して `applied` outcome に記録する:

- `orphanCount === 0`（再パースして孤児が消えた）
- `messageRowHash` が修復前と一致（`type === "message"` 行が 1 行も変化していない。SHA-256 比較）
- `jsonErrorCount` が修復前と変化しない（パース不能行を破壊していない）

修復後の outcome（`applied`）は `backupPath` / `removedCount` / `bytesWritten` / 上記 `reparse` の 4 値を通知 payload に引き渡す。

#### 4.4.6 実装状態・テスト証跡

| Phase | 内容 | 主な commit | テスト |
| --- | --- | --- | --- |
| **Phase 1** | カーネル post-append 検証（`session-integrity-guard.ts` 新規 + `guardSessionManager` への装着 + raw `SessionManager.open()` 経路の置換） | `393f7fdfcd` / レビュー指摘修正 `230724fd4a` | `src/agents/session-integrity-guard.test.ts` — **11 passed** |
| **Phase 2** | プラグイン雛形 + 日次 cron 登録 + ヘルスチェック | `03b9185540` | `extensions/session-integrity-guard/test/{cron-job,health-check}.test.ts` |
| **Phase 3** | Discord / Telegram 通知 + バックアップ付き自動修復（dry-run → apply） | `dc03f1097e` | `extensions/session-integrity-guard/test/{notify,repair}.test.ts` — プラグイン全体 **39 passed** |

実行確認（2026-09-10 時点の main）:

- `node scripts/run-vitest.mjs run --config vitest.agents.config.ts src/agents/session-integrity-guard.test.ts` → 11 passed
- `node scripts/run-vitest.mjs run --config vitest.extension-memory.config.ts` → 4 files / 39 tests passed

> **Note（Phase 3 の MED 4）**: 修復モジュールは `customType` の値（`model-snapshot` / `openclaw:prompt-error` 等）や旧レガシー型名（`model_snapshot` / `prompt_error`）で一切分岐しない。行の `type` が `message` 以外なら親不在のとき等しく除去対象、という単一述語で扱う（将来のカスタム型追加余地を残す）。

#### 4.4.7 追加調査で判明した配線上の注意点（統合時の発見・未修正）

本節はドキュメント統合作業中に行ったコード突き合わせで見つかった事項であり、**ユーザー裁定を待つ未修正の項目**である。ヘルスチェックと自動修復の本体処理は影響を受けない。

| # | 症状 | 証拠 | 影響 |
| --- | --- | --- | --- |
| **G-1** | `reconcileIntegrityNotifyCronJob()` が登録するジョブ仕様（`sessionTarget: "main"` + `delivery: { mode: "announce", … }`）を、カーネルの cron バリデータが **拒否**する | `src/cron/service/jobs.ts:189` が `throw new Error('cron channel delivery config is only supported for sessionTarget="isolated"')`。実測（一時検証テストで `createJob()` に同仕様を投入）: `THREW: cron channel delivery config is only supported for sessionTarget="isolated"`。既存の回帰テスト `src/cron/service.jobs.test.ts:508` も同制約を固定化している | announce cron が登録されず、起動時に `session-integrity-guard: startup reconciliation failed: …` が ERROR ログに出る（`index.ts` の try/catch が吞む）。検知結果が外部に届かない |
| **G-2** | `runIntegrityHealthCheck()` が生成する `notifyMessage` を **誰も購読していない** | `extensions/session-integrity-guard/index.ts` のハンドラは `gateway:startup` と `before_agent_reply`（`INTEGRITY_EVENT_TEXT` 用）の 2 つのみ。`INTEGRITY_NOTIFY_EVENT_TEXT`（`__openclaw_session_integrity_notify_publish__`）のハンドラは存在せず、`notifyMessage` の参照箇所も `cron-job.ts` 内の return のみ | 仮に G-1 が解消されても、通知文面がチャンネルへ publish される経路がない |

背景: announce delivery はカーネル cron の仕様上 **isolated agentTurn ジョブ専用**である（`payload.kind: "agentTurn"` + `sessionTarget: "isolated"`。`docs/automation/cron-jobs.md` の Delivery and output 節）。プラグインは従来の main + systemEvent パターンを流用したため、delivery を伴う通知ジョブだけが成立していない。

修正の候補（未実施・別タスク）:

1. 通知専用 cron を `sessionTarget: "isolated"` + `payload.kind: "agentTurn"` に変更し、エージェントの返答サマリを announce で送る。
2. カーネルの `sendFailureNotificationAnnounce` 相当の直接送信経路をプラグインから使う。
3. 通知をとりあえず保留し、**修復済みの事実をログに残すだけ**に割り切る（検知・修復は既に動いている）。

検証の限界（正直な記載）: Phase 1〜3 は「実装＋ユニットテスト」まで完了しており、その範囲の検証は上記§4.4.6 のとおり PASS している。ただし通知の**実機配達**（Discord / Telegram に実際に 1 通届くこと）は G-1/G-2 のため **未検証** である。実運用に投入する前に、上記 1〜3 のいずれかを選んで配線を閉じる必要がある。

---

### 4.5 データフロー図

#### 4.5.1 正常書き込み時

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

#### 4.5.2 検知時（書き込み失敗検知）

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
   │           └─ log.error("session integrity verification failed (appendMessage)",
   │                        { sessionFile, appendedId, reason })
   │
   ├─ ファイル上の行はそのまま（post-append なので削除しない）
   │
   └─ return id   ← 呼び出し元には ID を返しつつ、検知はログに残す
                   （後段の cron ヘルスチェックが孤児として拾い、必要なら修復）
```

#### 4.5.3 定期チェック時（cron 1 日 1 回）

```
cron: 0 3 * * *  →  systemEvent payload で main セッション起床
   │
   ├─ plugin: before_agent_reply (ctx.trigger === "heartbeat" かつ payload 一致)
   │   └─ runIntegrityHealthCheck({ cwd: ctx.workspaceDir, logger, autoRepair })
   │
   ├─ 対象セッション jsonl を列挙（discoverSessionFiles）
   │
   ├─ 各ファイルに対し:
   │   ├─ runHealthCheck(content)               ← 純関数
   │   ├─ 孤児数 / 構文 / 重複 / leaf 数を算出
   │   └─ 結果をレポートに集約
   │
   ├─ レポート判定
   │   ├─ 全項目 OK → 正常終了（ログのみ）
   │   └─ 1 件以上 NG → 自動修復判定 → 通知 payload 生成
   │
   └─ 通知 cron (5 3 * * *) が announce delivery で Discord / Telegram へ送信
         ※ この最終段は現在配線が未完成（§4.4.7 G-1/G-2 参照）。
           ヘルスチェックのログと自動修復までは上記どおり動作する。
```

#### 4.5.4 自動修復時

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
   ├─ 実適用（プラグイン設定の `autoRepair: true` 時のみ）
   │   ├─ ファイルを tmp → rename で原子的置換
   │   ├─ 修復後セッションで再ヘルスチェック
   │   └─ 結果を通知
   │
   └─ 失敗時 → バックアップから手動戻し手順を通知文に含める
```

---

### 4.6 テスト計画と検証観点

#### 4.6.1 ユニットテスト（カーネル側）

`src/agents/session-integrity-guard.test.ts` — 11 cases、すべて PASS。

`describe("verifyAppendedEntry")`:

| ケース                                                   | 期待結果                                                |
| -------------------------------------------------------- | ------------------------------------------------------- |
| 正常: `appendMessage` 後 `getEntry(id)` が存在する       | `{ ok: true }`                                          |
| 異常: 空セッションで id が存在しない                     | `{ ok: false, reason: "entry not found after append" }` |
| 異常: id が entry map に存在しない                       | `{ ok: false, reason: "entry not found after append" }` |
| 異常: `getLeafId()` が返す ID が `getEntry()` で引けない | `{ ok: false, reason: "leaf id not found" }`            |

`describe("installSessionIntegrityGuard")`:

| ケース                                                   | 期待結果                                          |
| -------------------------------------------------------- | ------------------------------------------------- |
| キルスイッチ `DENNOU_SKIP_INTEGRITY_GUARD=1`             | `appendMessage` をラップしない                    |
| 冪等性（繰り返し装着）                                   | ラッパが二重化しない                              |
| `[RAW_APPEND_MESSAGE]` シンボル継承                      | tool-result ガードと同一の生 append を共有        |
| `appendCustomEntry` のラップと検証                       | append ごとに検証が走る                          |

`describe("guardSessionManager + integrity integration")`:

| ケース                                                   | 期待結果                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| tool-result ガードと積んだ状態                          | 検証が生き続ける（tool-result 変換後の状態を検証）          |
| 検証失敗時（leaf 消失）                                  | `sessions/integrity` に ERROR ログが出る                    |
| 装着順序                                                 | `integrity → toolResult → raw` が成立                        |

#### 4.6.2 統合テスト（プラグイン側）

`extensions/session-integrity-guard/test/health-check.test.ts`

- 健全なセッションを 1 ファイル与えて `runHealthCheck()` が 4 項目とも OK を返す
- 孤児 3 件混ぜたセッションで `orphanCount === 3`、`leafCount === 1`（分裂前）/ 2（分裂後）

`extensions/session-integrity-guard/test/repair.test.ts`

- 孤児 3 件を含むセッションで `repair()` を呼ぶ → 修復後のファイルに孤児 0 / 行数 -3
- 修復前にバックアップファイルが生成されている
- 修復後、user / assistant 行は変化しない（`hashMessageRows()` の SHA-256 比較）

`extensions/session-integrity-guard/test/notify.test.ts` / `test/cron-job.test.ts`

- announce delivery の構築（`mode: "announce"` は `channel` 必須、無効時は `mode: "none"`）
- managed cron ジョブの reconcile（追加 / 更新 / 重複 prune / 無効化時の削除）

#### 4.6.3 負荷想定

| 規模                            | 想定挙動                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| セッション 1000 行              | ガード追加レイテンシ < 1ms                                                                       |
| セッション 10⁴ 行               | ガード追加レイテンシ < 5ms                                                                       |
| セッション 10⁵ 行（異常ケース） | ガードで**検知**され、ERROR ログが残る（書き込みは既に行われている。修復は別経路）               |

ベンチは `vitest.performance-config.ts` の既存パターン（`experimental.fsModuleCache` / `experimental.importDurations` 設定ヘルパー）に乗せる。

---

### 4.7 実装フェーズと完了状況

| フェーズ | 内容 | 完了条件 | 状態 |
| --- | --- | --- | --- |
| **Phase 1** | カーネル側ガード最小実装（`session-integrity-guard.ts` 新規 + `guardSessionManager` への appendMessage ラッパ装着 + §4.3.1 表の raw `SessionManager.open()` 経路の `guardSessionManager` 置換） | (a) ユニットテスト全件 PASS、(b) 既存 `transcript.test.ts` 全件 PASS、(c) ガード有効化後に既存セッションへの追加書き込みで副作用なし、(d) §4.3.1 表の全 append 経路が `guardSessionManager()` 経由の wrapped instance になっている | ✅ **完了**（`393f7fdfcd` + レビュー修正 `230724fd4a`） |
| **Phase 2** | プラグイン雛形作成 + cron 登録 | (a) `extensions/session-integrity-guard/` パッケージ生成、(b) 起動時 startup イベントで cron 取得 → 日次ジョブ登録、(c) ヘルスチェック関数のみ有効 | ✅ **完了**（`03b9185540`） |
| **Phase 3** | 通知 + 自動修復 | (a) Discord / Telegram への異常通知、(b) ドライラン→実適用の 2 段階が意図通り動作、(c) 修復後の再パースで孤児 0 件 かつ 修復前と user/assistant 行のハッシュが一致 かつ バックアップファイルが存在、の 3 点を検証ログに記録 | ✅ **実装・テスト完了**（`dc03f1097e`）。⚠️ (a) の**配線に未解決事項あり** → §4.4.7 |

> **レビュー履歴**: Phase 1 は実装後にレビューを受け、指摘（単一 emit / hook-block ハンドリング / 共有シンボル）を `230724fd4a` で修正済み。Phase 2 / Phase 3 も実装＋テストを伴って完了している。
>
> **統合作業時の追加調査**: Phase 3 の通知配線に未解決事項（G-1 / G-2）を発見した。§4.4.7 を参照。ヘルスチェック・自動修復の本体は影響を受けない。

---

### 4.8 リスクと非スコープ

#### 4.8.1 リスク

| リスク                                               | 緩和策                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ガード過剰検知**: 本来正当な書き込みを止めてしまう | (a) ガードのチェック 2 項目は最小限（post-append 存在 / leaf 整合）に限定、(b) post-append 検証のため**書き込みを取り消さず検知のみ**で反応（ファイル変更はプラグイン側修復に委ねる）、(c) kill switch `DENNOU_SKIP_INTEGRITY_GUARD=1` を用意 |
| **性能劣化**: ホットパスへの追加コスト               | O(1) 1 走査のみ・同期 I/O なし。ベンチで < 1ms を確認                                                                                                                                                                                         |
| **修復の誤作動**: 「絶対触らない」行を誤って削除     | 修復対象を「`type !== "message"`」で型レベルに絞り込み、`message.role === "user" \| "assistant"` の行を**プログラム的に選択不可能**にする（型名分岐はしない）                                                                                 |
| **バックアップ肥大**: 1 日 1 回フルバックアップ      | ローテーション（直近 N 件保持）は将来課題（§4.8.2）                                                                                                                                                                                           |

#### 4.8.2 非スコープ（将来課題として明記）

以下は**本ガードの対象外**とし、明示的に将来フェーズへ送る:

1. **他セッション jsonl ファイル横断の整合性** — 単一ファイル内の孤児検出に限定。複数ファイル間の親子参照は別タスク。
2. **`sessions.json`（メタデータ）自体の整合性** — `saveSessionStoreUnlocked()` 経路は別の整合性問題（期限切れエントリ等）が主。本書では扱わない。
3. **過去ログの一括再修復** — 2026-09-04 の手作業修復は完了済みであり、本書はその再発防止策。再修復ツールの汎用化はしない。
4. **バックアップローテーション自動化** — 修復時のバックアップは毎回新規作成。N 件を超えたら古いものを消す仕組みは将来。
5. **マルチエージェント横断の整合性** — 1 セッション内のツリー整合性に限定。エージェントをまたぐ参照は別問題。
6. **通知の重複抑制・クールダウン** — 1 日 1 実行なので当面不要だが、同じ異常の連続通知抑制は将来。
7. **`appendAssistantMessageToSessionTranscript`（`src/config/sessions/transcript.ts:165-169`、§4.3.1 表 行2）のセッション書き込みロック未取得** — 現状、delivery mirror 経路では `acquireSessionWriteLock` を取得せずに `SessionManager.appendMessage()` を呼んでいる。ロック未取得の他の append 経路と競合し得、`byId` のメモリ状態がレースする可能性がある。本ガードは**装着のみ**を対象とし、ロックの取得は別タスクとする。
8. **SDK 内部 append の観測** — `@earendil-works/pi-coding-agent` 内部の `appendModelChange` / `appendThinkingLevelChange` / `appendCompaction` / `appendSessionInfo` はカーネル側ラッパを迂回する。検知は §4.4 のヘルスチェックに委ねる。

---

### 4.9 関連参照

- 被害実体: `src/config/sessions/transcript.ts`（セッション jsonl 書き込み窓口）
- 被害実体（セッション構造）: `@earendil-works/pi-coding-agent` の `SessionManager`（`id` + `parentId` のツリー）
- 方針整合: `DENNOU_DOCS/PHASE_F_SLIM_KERNEL.md`（カーネルは細く・プラグインに逃がす）
- プラグイン雛形参考: cron 取得 → `cron.add()` の標準パターン（旧 `extensions/memory-core/src/dreaming.ts`。DEBLOAT で削除済みだがパターンは `extensions/session-integrity-guard/src/cron-job.ts` に継承）
- 類似の追加フック: `src/config/sessions/store.ts:72` の `setAfterSaveHook()`（ストア保存後フックの登録パターン）。`AfterSaveHook` 型は `:64`

---

## 5. ロードマップ

1. **Step 1: マスターセッション保護ガードの実装・実証** ✅ **完了 (commit `50af3a2b`)**
   - `isProtectedSessionKey` の導入と 7 系統の防御 chokepoint 設置。
   - `/reset` `/new` や削除 RPC を叩いてもマスターセッションが一切破壊されないことをテスト実証済み。
2. **Step 2: セッション整合性ガードの実装・実証** ✅ **実装・テスト完了（Phase 1 `393f7fdfcd` / Phase 2 `03b9185540` / Phase 3 `dc03f1097e`）**
   - カーネル post-append 検証＋プラグイン cron ヘルスチェック＋自動修復は稼働。
   - ⚠️ 通知（Discord / Telegram 送信）の配線に未解決事項あり → §4.4.7。
3. **Step 3: 通知配線の修復（§4.4.7 G-1 / G-2）**
   - announce delivery を `sessionTarget: "isolated"` + `payload.kind: "agentTurn"` に合わせるか、直接送信経路を使う。
4. **Step 4: 複数エージェント機能のクリーンアップ（Phase F Wave 6 候補）**
   - 不要な multi-agent 関連コード・設定スキーマの整理。
   - Kasou 単一エージェントとしての設定・ランタイムの平坦化。
5. **Step 5: メッセンジャー通知駆動化（Peripherals Plugin 化）**
   - Discord / Telegram / LINE からマスターセッションへの通知ディスパッチ機構。
   - 受信箱（raw-chat 検索）＆送信ツールの整備。
6. **Step 6: SQLite Fork / 仕事モード基盤の整備**
   - メッセージグラフ（`chat_messages.parent_id`）およびセッションツリーを活用した Fork 機構の設計と実装。
7. **Step 7（将来）: バックアップローテーション / 通知クールダウン / セッション間整合性**
   - §4.8.2 の非スコープ項目を必要になった時点で着手。

---

## 6. 章対応表（旧 `SESSION_INTEGRITY_GUARD.md` → 本書）

旧ファイルを参照しているコメント・コミットメッセージ・過去ログの `§N` は、以下のように読み替える。

| 旧 `SESSION_INTEGRITY_GUARD.md` | 本書 `AGENT_SESSION.md` |
| --- | --- |
| §1 背景と目的 | §4.1 |
| §2 アーキテクチャ | §4.2 |
| §3 カーネル側ガード仕様 | §4.3 |
| §3.1 対象 API（介入経路一覧） | §4.3.1 |
| §3.2 ガード関数の責務 | §4.3.2 |
| §3.3 拒否時の動作 | §4.3.3 |
| §3.4 性能影響 | §4.3.4 |
| §4 プラグイン側仕様 | §4.4 |
| §4.1 配置 / §4.2 ヘルスチェック項目 / §4.3 cron 実行間隔 / §4.4 異常時の通知 / §4.5 自動修復ルール | §4.4.1 / §4.4.2 / §4.4.3 / §4.4.4 / §4.4.5 |
| §5 データフロー図（§5.1〜§5.4） | §4.5.1〜§4.5.4 |
| §6 テスト計画 | §4.6 |
| §7 実装フェーズ | §4.7 |
| §8 リスクと非スコープ（§8.1 / §8.2） | §4.8.1 / §4.8.2 |
| §9 関連参照 | §4.9 |

---

## 7. 関連ドキュメント

- `DENNOU_DOCS/PHASE_F_SLIM_KERNEL.md` — カーネルを細く保つ方針（本設計の前提）
- `DENNOU_DOCS/COMPACTION_FEATURE.md` — コンテキスト圧縮（§4 の整合性ガードと整合するよう JSONL を非破壊で扱う）
- `DENNOU_DOCS/DEBLOAT.md` — 大規模削除の記録（`memory-core` 撤去など、本設計の周辺事情）
- `DENNOU_RULES.md` — Smart Debloat / Isolate the "Soul" / Commit Taxonomy

# Model Fallback による同一ユーザー入力の履歴重複汚染分析

## 日時

- 作成: 2026-05-20
- 報告者: Kuraudo

## 現象

モデル fallback が発生したとき、外部チャット上では同じメッセージを何度も送っていないように見えても、内部の session transcript には同じユーザー入力が複数回保存されることがある。

実例では、同じ入力が session JSONL 内で次のように並んでいた。

```text
user, user, assistant
```

fallback が2回続けば、構造上は次のように増える可能性がある。

```text
user, user, user, assistant
```

さらに失敗候補が増えると、会話履歴は次のように汚れる。

```text
user, user, user, user, user, user, assistant
```

たとえると、ユーザーは1回しか注文していないのに、店員が在庫確認に失敗するたびに同じ注文票をレジへ何枚も積んでいる状態。

## 影響

- 会話履歴が実際より長くなる
- 直近文脈が「同じ入力の連打」に見える
- モデルが「ユーザーが同じことを何度も強調している」と誤解しやすい
- prompt cache の安定性が落ちる
- active-session prune の対象も増える
- 長期セッションではコンテキスト汚染が雪だるま式に増える

## 確認したファイル

- `src/agents/model-fallback.ts`
- `src/auto-reply/reply/agent-runner-execution.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- KASOU session JSONL: `93fcc1a8-7563-4cf2-b9f1-e4552e7e444f.jsonl`

## 根拠

### 1. fallback は候補モデルを順番に試す

`src/agents/model-fallback.ts:614-615`

```ts
for (let i = 0; i < candidates.length; i += 1) {
  const candidate = candidates[i];
```

このループは、primary model が失敗したときに fallback candidate を順番に試す。つまり、候補が3つあれば最大3回「同じユーザー入力を使った実行」が起きる。

### 2. 各 fallback candidate ごとに embedded agent run を起動し直している

`src/auto-reply/reply/agent-runner-execution.ts:674-711`

```ts
const fallbackResult = await runWithModelFallback({
  ...resolveModelFallbackOptions(params.followupRun.run),
  runId,
  run: async (provider, model, runOptions) => {
    ...
    const result = await runEmbeddedPiAgent({
```

`runWithModelFallback()` は候補ごとに `run` callback を呼ぶ。その callback 内で `runEmbeddedPiAgent()` が起動する。ここまでは「静かな retry」として正しいが、下層で transcript への書き込みが毎回走る。

### 3. 各 attempt が同じ prompt を `activeSession.prompt()` に渡している

`src/agents/pi-embedded-runner/run.ts:591-623`

```ts
const attempt = await runEmbeddedAttempt({
  sessionId: params.sessionId,
  sessionKey: resolvedSessionKey,
  ...
  prompt,
```

`src/agents/pi-embedded-runner/run/attempt.ts:1810-1814`

```ts
if (imageResult.images.length > 0) {
  await abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images }));
} else {
  await abortable(activeSession.prompt(effectivePrompt));
}
```

ここで同じ `effectivePrompt` が session に追加される。失敗した候補の attempt でもこの処理が走るため、fallback が続くほど transcript に同一 user turn が積み上がる。

## 根本原因

fallback retry の実行単位と transcript の永続化単位が同じになっている。

本来はこう分けたい。

```text
ユーザー入力: 1回だけ transcript に保存
モデル試行: primary → fallback1 → fallback2 を内部で静かに試す
assistant出力: 成功した最終候補だけ transcript に保存
```

現状はこうなっている。

```text
primary attempt   → user を保存 → 失敗
fallback attempt  → user を保存 → 成功
assistant         → 保存
```

つまり、外に二重送信しているわけではないが、内部帳簿には二重登録されている。

## 修正方針案

### 推奨: 上流 persistence latch 方式を `[SYNC]` で取り込む

上流 OpenClaw には、同じ問題を直す修正 `1b82c0e3d9b44a22793ddf14a404e6829f710c97` が入っている。この修正は、fallback run 全体で「すでに user message / assistant error を保存したか」を覚える latch を持ち、2候補目以降では同じ entry をもう一度保存しない。

```text
fallback run start:
  queuedUserMessagePersistedAcrossFallback = false
  assistantErrorPersistedAcrossFallback = false

first candidate persists user:
  queuedUserMessagePersistedAcrossFallback = true

second candidate:
  suppressNextUserMessagePersistence = true
```

この方式なら、fallback が何回続いても保存される履歴は次の形に保ちやすい。

```text
user, assistant
```

たとえると、同じ注文票を2枚目からレジに通さない方式。後から帳簿を消すのではなく、最初から重複登録を防ぐ。

#### なぜ rollback より優先するか

- 上流に既に入っているため、DennouAibou独自分岐を増やしにくい
- 既存の session guard / persistence boundary に寄せた修正で、責務が自然
- 失敗attemptの履歴を後から消すより、副作用リスクが低い
- tool送信後・block streaming後・context engine mutation後の「消してはいけないもの」を誤って戻す危険が小さい

注意点として、上流方式は主に **JSONL / transcript persistence の重複保存を止める** 方式であり、同一 fallback run 中の一時的な in-memory `activeSession.messages` 増加までは完全に消さない可能性がある。ただし、次ターン以降のコンテキスト汚染を止める目的には、この方式が最も安全で現実的。

### 予備案: failed fallback attempt の transcript rollback

上流 latch 方式を取り込んだ後も、失敗 attempt の dead branch / custom entry / context engine trace が実測で問題になる場合だけ、rollback を追加検討する。

fallback candidate を試す前に session leaf を記録し、失敗して次候補へ進むときだけ、その candidate が追加した user turn を巻き戻す。

```text
before candidate:
  leaf = current transcript leaf

candidate failed before external send:
  rollback transcript to leaf
  try next candidate

candidate succeeded:
  keep transcript
```

この方式でも、fallback が何回続いても最終履歴は次の形に保てる。

```text
user, assistant
```

ただし、ここで言う rollback は「ふわっと履歴を戻す」では足りない。実装時は `SessionManager` の leaf / branch 操作として明示する必要がある。

既存コードには近い前例がある。`attempt.ts` の orphan repair は、末尾が orphan user message のときに `sessionManager.branch(leafEntry.parentId)` または `sessionManager.resetLeaf()` で active leaf を戻している。fallback rollback もこの系統の操作を使うのが自然。

注意点として、これは active transcript の見え方を戻すだけでは不十分な場合がある。JSONL上に dead branch が残るだけなら active context 汚染は軽くなるが、ファイルサイズ・監査性・prompt cache安定性の問題は残る。最終的には「active leafを戻す」だけでなく、「失敗attemptが作った不要entryをどう扱うか」も設計対象にする。

### 安全に rollback してよい条件

- モデル呼び出しが rate limit / overload / model not found / provider timeout で失敗
- assistant text が外部チャットへ送信されていない
- messaging tool が外部送信していない
- deterministic approval prompt を送っていない
- tool execution が実行済みでない、または transcript 上の副作用を安全に巻き戻せることが確認できる

実装時は、これらを「気分」ではなくフラグで判定する。

候補:

- `partialReplyEmitted`: `onPartialReply` が1回でも呼ばれたら true
- `blockReplyEmitted`: `onBlockReply` / `onBlockReplyFlush` が外部へ出したら true
- `toolStarted`: tool start/update event を見たら true
- `messagingToolSent`: `attempt.didSendViaMessagingTool` が true
- `approvalPromptSent`: `attempt.didSendDeterministicApprovalPrompt` が true
- `hasReplied`: 既存の `hasRepliedRef` が true
- `promptErrorEntryAppended`: `openclaw:prompt-error` custom entry を追加したら true

rollback を許すのは、これらがすべて false で、失敗理由が fallback-safe なものに限る。

### rollback してはいけない条件

- messaging tool でTelegram/Discord/Slack等へすでに送信した
- tool call の副作用が発生した
- approval prompt を送った
- assistant partial / block reply が外部に出た
- compaction や context-engine maintenance が同じ transcript に不可逆な変更を入れた
- `openclaw:prompt-error` など、attempt中に custom entry が追加された

ここを間違えると「見えている外部状態」と「内部履歴」がズレる。なので最初の実装では、**失敗が model selection / provider response 前後で閉じているケースだけ**を対象にするのが安全。

特に block streaming が有効なときは要注意。外部チャットには最終返信しか出ない場合でも、Control UI には partial / block reply が見えている可能性がある。その場合、transcript だけ巻き戻すと「UIで見えた途中経過」と「保存履歴」が食い違う。

context engine も同じ。`finalizeAttemptContextEngineTurn()` や maintenance が失敗attemptの情報を記録した後で transcript だけ戻すと、vector/context側に古い足跡が残る。Phase 2では、context engine mutation が走る前に閉じる失敗だけを rollback 対象にする。

## 実装候補

### Option A: 上流 persistence latch を `[SYNC]` で取り込む（推奨）

上流commit `1b82c0e3d9b44a22793ddf14a404e6829f710c97` を取り込み、以下の流れをDennouAibouへ合わせる。

- `queuedUserMessagePersistedAcrossFallback`
- `assistantErrorPersistedAcrossFallback`
- `suppressNextUserMessagePersistence`
- `suppressAssistantErrorPersistence`
- `onUserMessagePersisted`
- `onAssistantErrorMessagePersisted`

利点:

- 上流と同じ修正なので将来のmerge衝突が少ない
- rollbackより安全で、実装範囲も比較的狭い
- user entry だけでなく assistant error stub の重複も防げる

注意:

- DennouAibouの現行コードにはこれらの latch / suppress パラメータがまだ無い
- commitは11ファイルにまたがるため、conflict解決後の回帰テストが必須
- in-memory session上の一時重複は別途実測する

### Option B: `runEmbeddedAttempt()` 内で attempt-local rollback を持つ（予備）

`attempt.ts` は `sessionManager` と `activeSession.prompt()` の両方を持っているため、巻き戻し地点を一番正確に見られる。

利点:

- user turn が追加される場所の近くで処理できる
- tool送信済み/assistant送信済みなどの状態を見やすい

注意:

- attempt の失敗理由を上位へ渡す必要がある
- どの失敗が rollback-safe かを明示する必要がある

### Option C: `agent-runner-execution.ts` 側で候補失敗時に rollback hook を呼ぶ（予備）

`runWithModelFallback()` の candidate failure を見て、失敗候補の transcript を戻す。

利点:

- fallback の文脈が見える
- candidate success/failure の境界が分かりやすい

注意:

- 低レベルの session leaf / transcript mutation を上位から扱う必要があり、責務がやや漏れる

### Option D: prompt append を1回だけに分離する（長期理想形）

最初の candidate だけ user prompt を transcript に追加し、2回目以降は既存 user turn を再利用してモデルだけ差し替える。

利点:

- 理想形に近い
- prompt cache にも優しい

注意:

- pi-agent-core / SessionManager の内部設計に強く依存する
- 実装コストが高い
- 上流追従時の衝突が大きくなりやすい

補足: 長期的には Option D が一番きれい。rollback は「汚れたら拭く」方式だが、Option D は「そもそも汚さない」方式。ただし SessionManager / pi-agent-core の内部設計に深く入るため、今すぐの修正としては上流 latch 方式を優先する。

## 推奨する段階的対応

### Phase 1: 上流 latch 方式の `[SYNC]` 取り込み

- 上流commit `1b82c0e3d9b44a22793ddf14a404e6829f710c97` を取り込む
- fallback 2回で `user,user,user,assistant` にならないことを期待するテストを含める
- assistant error stub が候補ごとに増えないことも確認する

テスト形の例:

```text
Given: 既存履歴10件
When: primary model が rate_limit で assistant出力前に失敗し、fallback model が成功
Then: 保存される session transcript は user 1件 + assistant 1件だけ増える
And: 次ターン以降に使われる永続履歴へ同一 user入力が重複しない
And: JSONLに同一 user入力が重複保存されない
```

### Phase 2: DennouAibou固有の残差を実測

上流 latch 方式を入れた後、以下を確認する。

- active JSONL に同一 user入力が重複しないこと
- assistant error stub が候補ごとに増えないこと
- fallback run 中の in-memory 一時重複が実害を出していないこと
- prompt cache / context size が改善すること

### Phase 3: rollback-safe な失敗だけ追加対応（必要な場合のみ）

- `rate_limit`
- `overloaded`
- `model_not_found`
- provider timeout before reply
- `LiveSessionModelSwitchError` が fallback 内で `overloaded` として扱われるケース

上流 latch 方式でまだ問題が残る場合だけ、この範囲で transcript rollback を検討する。

ただし、`model_not_found` でも `activeSession.prompt()` 後に検出される形なら rollback 対象外にする。安全判定は「エラー名」だけでなく「外部送信・tool・custom entry・context engine mutation が起きていないこと」とセットで見る。

### Phase 4: tool実行後失敗の扱いを別途設計

tool 実行後の失敗は、外部副作用と transcript の整合性が難しい。ここは別設計にする。

## 上流（OpenClaw本家）の状況

### 調査日時

2026-05-20、上流タグと `main` ブランチを確認。

### 結論: 上流には同内容の修正が既に入っている

Issue #83404 を閉じる形で、まったく同じ問題を修正するコミットが入っている。

- コミット: `1b82c0e3d9b44a22793ddf14a404e6829f710c97`（author: yetval, committer: steipete）
- 日時: 2026-05-18
- メッセージ: `fix(followup,reply): stop model-fallback retries duplicating session entries`
- 修正手法: `queuedUserMessagePersistedAcrossFallback` と `assistantErrorPersistedAcrossFallback` の2つの永続化ラッチを設け、同一fallback run内で2回目のuser entry追加とassistant error stub追加を抑制する

### ステータス: 適用済み

- `v2026.5.18`: 未適用（上流最新安定版）
- `v2026.5.19-alpha.1`: 適用済み
- `v2026.5.19-beta.1`: 適用済み
- `v2026.5.19-beta.2`: 適用済み
- `upstream/main`: 適用済み
- `upstream/release/2026.5.19`: 適用済み

`git branch -r --contains 1b82c0e3d9b44a22793ddf14a404e6829f710c97` と `git tag --contains 1b82c0e3d9b44a22793ddf14a404e6829f710c97` で確認済み。

### DennouAibou との比較

DennouAibou の旧推奨方針（transcript rollback）と上流の修正（persistence latch）は「アプローチは異なるが、防止したい問題は同じ」。

上流の persistence latch 方式の利点: rollback より副作用が少ない（すでに書かれた entry を 2回目だけ抑制するため、巻き戻しの複雑さが要らない）。

DennouAibou の rollback 方式の利点: 失敗 attempt が作ったあらゆる state mutation（custom entry, context engine, cache trace）も戻せる可能性がある。

現時点の推奨は、独自rollback実装ではなく、上流 latch 方式を `[SYNC]` で取り込むこと。rollback は、上流方式で足りない実測が出た場合の予備案に降格する。

## ステータス

- 2026-05-20: 原因確認済み
- 2026-05-20: 上流commit `1b82c0e3d9` が `upstream/main` / `v2026.5.19-beta.1` / `v2026.5.19-beta.2` に適用済みと確認
- 2026-05-20: 実装未着手
- 2026-05-20: 推奨方針を failed fallback attempt rollback から上流 persistence latch の `[SYNC]` 取り込みへ変更
- 2026-05-20: code-reviewer 指摘を反映し、rollbackの検出フラグ・orphan repair caveat・context engine / block streaming / prompt-error entry caveatを追記

## 変更履歴

| 日付 | 変更内容 |
|---|---|
| 2026-05-20 | 初版作成 |
| 2026-05-20 | code-reviewer指摘を反映し、rollback-safe条件と実装上の注意点を補強 |
| 2026-05-20 | 上流調査を追記（当初はIssue #83404の適用状況を未マージと誤認） |
| 2026-05-20 | 上流適用状況を訂正し、推奨方針を上流 persistence latch の `[SYNC]` 取り込みへ変更 |

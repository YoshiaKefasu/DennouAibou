# DennouAibou コンテキスト圧縮機能設計書 (COMPACTION_FEATURE.md)

## 1. 背景と基本思想：大工さんの「カンナくず」モデル

### 1.1 背景
長期対話を続ける Kasou のコンテキストは、会話そのものよりも **「ツールの実行結果（検索ログ、ファイル内容、コマンド実行結果など）」** によって急激に膨張する。
従来のコンパクション（会話全体を無理やり要約して古い履歴を丸ごと破棄する方式）では、詳細な指示や大切な思い出まで失われ、エージェントが「記憶喪失」に陥るリスクが高かった。

### 1.2 コア思想：大工さんのカンナくず
大工さんが木を削る時、削った後に残る「カンナくず（削りカス）」は作業の副産物であり、普段はすべて捨てて作業場を綺麗にする。
しかし、中には「この木目が綺麗だから後で木目合わせの証拠に使えるな」「この厚みは後で確認したいな」という **価値ある削りカス** も存在する。

DennouAibou のツール実行結果もこれと全く同じである：
- **ツールの生出力は 99% が作業のカンナくず** であり、用が済めばコンテキストを圧迫するだけのゴミになる。
- したがって、**「デフォルトではツールの生出力は保存しない（捨てる／プレースホルダー化する）」** のを基本姿勢とする。
- Kasou が「これは後で証拠や文脈として必要だ！」と判断した価値ある出力だけを、**明示的なパラメータで拾い上げて保存する**。

### 1.3 既存のいびつな二重構造の解消
現在 DennouAibou には、ツール出力を削る仕組みが 2 箇所に分かれて存在している：
1. **OpenClaw 由来の `contextPruning`** (`src/agents/pi-hooks/context-pruning/`):
   - AI にメッセージを渡す直前（インメモリ）で、古いツール出力を `[Old tool output cleared — re-run if needed]` に目隠しする。
   - セッションファイル (`.jsonl`) には巨大な生ログが残り続けるため、ファイルサイズ肥大化やディスク読み込み遅延は防げない。
2. **DennouAibou 独自の `prune-engine`** (`src/dennou-soul/prune-engine.ts`):
   - セッションファイルそのものの古い行を事後的にプレースホルダーに置換する。

この 2 つを統合し、**単一の独立プラグイン (`extensions/context-pruner`) として一本化** する。
これにより、カーネルから古い `contextPruning` コードをごっそり削り、Phase F の「カーネルは細く、機能はプラグインへ」の原則を徹底する。

---

## 2. 最優先の2大機能

本フェーズでは、会話を止めない裏方要約（バックグラウンド要約）は後回しとし、以下の **2つの機能** を最優先で設計・導入する。

```
+---------------------------------------------------------------+
|                      Kasou のコンテキスト                     |
|                                                               |
|  [会話メッセージ] (User / Assistant) ----> 永久保存・不可侵    |
|                                                               |
|  [ツール呼び出し] (Tool Call)                                 |
|         │                                                     |
|         ▼                                                     |
|  [ツール結果] (Tool Result)                                   |
|         │                                                     |
|         ├─ 明示的保存 (preserve: true) ─> [生出力を保存・DB記録]   |
|         │                                                     |
|         └─ デフォルト (通常) ───────> [軽量プレースホルダー]   |
|                                       「実行完了 (34行/1.2KB)」|
+---------------------------------------------------------------+
```

---

## 3. 機能 1: デフォルト破棄と明示的保存 (Selective Tool Persistence)

### 3.1 概要
ツール実行結果をセッションおよび RawChat DB に保存する際、デフォルトでは生出力をそのまま蓄積せず、Kasou が意図して指定した場合のみフルデータを残す。

### 3.2 ツールパラメータ設計
各ツール呼び出しの引数、またはエージェントのツール実行オプションに保存制御パラメータを導入する。

```typescript
// ツール実行時の保存オプション
export interface ToolPersistenceOptions {
  /**
   * ツール結果の生データを永続化するかどうか。
   * デフォルトは false（要約プレースホルダーのみ保存）。
   */
  preserve?: boolean;
}
```

### 3.3 動作ルール
1. **通常時（パラメータなし / `preserve: false`）**:
   - ツールの実行完了後、セッションファイル (`.jsonl`) には以下のような **軽量プレースホルダー** のみを書き込む：
     ```json
     {
       "type": "message",
       "id": "tr-xxxx",
       "parentId": "tc-xxxx",
       "message": {
         "role": "toolResult",
         "toolCallId": "tc-xxxx",
         "toolName": "read_file",
         "content": [{ "type": "text", "text": "[出力省略: 120行 / 3.4KB 正常終了]" }]
       }
     }
     ```
   - 親子リンク（`id`, `parentId`, `toolCallId`）は完全に維持するため、セッション整合性（ツリー構造）は一切壊れない。

2. **明示的保存時（`preserve: true`）**:
   - Kasou が「重要なログ」「後から参照する設定ファイル」と認めた場合、生データをそのままセッションに書き込む。
   - RawChat DB にも完全な形でインデックスされる。

---

## 4. 機能 2: ピンポイントなゴミ捨て (即時プレースホルダー化 / プラグイン統合)

### 4.1 概要
すでにコンテキスト内に存在する「過去のツールの生出力」を、会話の文脈を壊さずにピンポイントでプレースホルダー化し、コンテキストサイズを大幅に削減する。

### 4.2 既存 prune-engine の活用と整合性の死守
DennouAibou にはすでに純粋関数としてテスト済みの `src/dennou-soul/prune-engine.ts` が存在する。これを新プラグインのコアとして直結させる。

- **整合性の死守**:
  `pruneToolResultEntry()` は、JSON構造（`id`, `parentId`, `toolCallId`, `toolName`, `isError`）を 100% 保持したまま、`content` の中身だけを置換する。
  これにより、`SESSION_INTEGRITY_GUARD` の検証を完璧に通過し、孤児ノードや破損行を一切生み出さない。

- **保護ルール（誤って捨てないための安全弁）**:
  1. **直近 N ターンの保護 (`keepLastAssistants: 3`)**:
     直近 3 ターンのアシスタント発言以降のツール出力は、現在進行形の思考に必要なため生データを保持する（内部的にはアシスタント境界を検出してカットオフを決定）。
  2. **重要キーワード保護**:
     設定ファイルパスやワークスペース固有のアンカー情報が含まれる結果は除外する。
  3. **サイズ閾値 (`minPrunableToolChars: 1200`)**:
     1,200 文字未満の小さな出力はそもそもプレースホルダー化せずそのまま保持する。
  4. **複雑な softTrim の廃止とシンプル一本化**:
     旧 OpenClaw にあった「前後の文字を残して途中を切り詰める (softTrim) → さらに超えたら消す (hardClear)」という複雑な2段階方式は廃止し、**「閾値を超えたら直ちにプレースホルダー化する」単一方式に一本化** して KISS 原則を徹底する。

### 4.3 統合プラグイン (`extensions/context-pruner`) 構成
OpenClaw の `contextPruning` 設定スキーマを受け継ぎつつ、プラグインとして再定義する。

```jsonc
// プラグイン設定例 (dennou-aibou.json)
"plugins": {
  "entries": {
    "context-pruner": {
      "enabled": true,
      "keepLastAssistants": 3,
      "minPrunableToolChars": 1200,
      "defaultPreserve": false,
      "placeholder": "[出力省略: 正常終了]"
    }
  }
}
```

- `mode: cache-ttl` は旧方式（時間経過によるインメモリ目隠し）の遺産であるため廃止し、セッション書き込み時の常時判定に一本化する。`attempt.thread-helpers.ts:53` のプロンプトキャッシュ判定は「本プラグインが有効（enabled: true）であればキャッシュ最適化を有効にする」仕様へ簡素化する。

- プラグイン内部で **`tool_result_persist` フック（書き込み時介入）に一本化** する。
  従来の「セッションには生ログを書き、AI送信時にインメモリで目隠しする」という二重管理を撤廃し、**書き込みの瞬間にプレースホルダー化して保存する**。セッションファイル自体がすでに軽量プレースホルダーになっているため、次回のプロンプト構築時も自動的に軽量なまま読み込まれ、インメモリ側での複雑な再目隠しフックは不要となる（KISS 原則）。
- パラメータの確定値と安全弁：
  - アシスタント境界判定への完全統一：
    従来の行数ベースの `keepLastTools` は廃止し、直近 3 回のアシスタント発言境界を基準とする `keepLastAssistants: 3` に一本化する（実装は `findAssistantCutoffIndex` 方式を採用）。
  - 最小文字数閾値：`minPrunableToolChars: 1200` を標準値とし、1,200文字未満の短い出力はそのまま保存する。
  - プレースホルダー表記の正準化：
    正準フォーマットを `[出力省略: {行数}行 / {サイズ} 正常終了]` に統一する（旧 OpenClaw の `[Old tool output cleared — re-run if needed]` は既存セッション読み込み時の判定・互換用としてのみ認識する）。
  - `preserve: true` の安全上限（暴走防止の安全弁）：
    明示保存時であっても、1回のツール結果が **50,000文字 (chars)** を超える極端な巨大出力の場合は、先頭 25,000文字 と 末尾 25,000文字 を残して中間を切り詰め、中間に `\n\n[Tool result truncated: exceeds 50,000 chars safety cap]\n\n` を挿入する（これは通常圧縮ではなく、モデルのコンテキスト圧死を防ぐ安全弁）。
  - プレースホルダー化の冪等性ガード：既にプレースホルダー化されたエントリ（`[出力省略:` または `[Old tool output` を含むもの）は二重に置換しない。

---

## 5. データフロー

### 5.1 ツール実行〜保存の流れ

```
1. ユーザーメッセージ受信
   │
2. Kasou がツール呼び出しを決定
   │
   ├─ [通常]   tool_call: read_file(path: "foo.ts")
   │                │
   │                ▼ 実行
   │           生出力: 500行のコード (15KB)
   │                │
   │                ▼ (preserve: false)
   │           セッション保存: "[出力省略: 500行 / 15KB 正常終了]"
   │
   └─ [証拠要] tool_call: read_file(path: "config.json", preserve: true)
                    │
                    ▼ 実行
               生出力: 30行の設定JSON
                    │
                    ▼ (preserve: true)
               セッション保存: 生出力をそのまま記録
```

---

## 6. 実装フェーズ

### Phase 1: 統合プラグイン (`extensions/context-pruner`) の新設と二重構造の解消
- `src/dennou-soul/prune-engine.ts` の `pruneToolResultEntry` を export 化し、冪等性ガード（二重置換防止）を追加。
- `tool_result_persist` フックによる書き込み時一本化プレースホルダー処理を新プラグイン (`extensions/context-pruner`) に実装。
- カーネル側の古い context-pruning 実装（以下の計8ファイル）を DEBLOAT（完全削除）：
  - `src/agents/pi-hooks/context-pruning.ts`
  - `src/agents/pi-hooks/context-pruning.test.ts`
  - `src/agents/pi-hooks/context-pruning/extension.ts`
  - `src/agents/pi-hooks/context-pruning/pruner.ts`
  - `src/agents/pi-hooks/context-pruning/pruner.test.ts`
  - `src/agents/pi-hooks/context-pruning/runtime.ts`
  - `src/agents/pi-hooks/context-pruning/settings.ts`
  - `src/agents/pi-hooks/context-pruning/tools.ts`
- カーネル側呼び出し元と設定・テストの追従更新：
  - `src/agents/pi-embedded-runner/extensions.ts` および `extensions.test.ts` からの contextPruning 参照を削除。
  - `src/agents/pi-embedded-runner/run/attempt.thread-helpers.ts:53` のプロンプトキャッシュ判定) および `attempt.spawn-workspace.context-engine.test.ts`、`src/config/zod-schema.agent-defaults.ts:59` のスキーマを、新プラグイン設定 (`plugins.entries["context-pruner"]`) を参照するよう更新（既存設定 `softTrimRatio`/`hardClearRatio` 等がある場合は警告なしで受容・無視して後方互換を維持）。
  - `src/dennou-soul/config.ts` / `config.test.ts` の `keepLastTools` 設定を廃止し、`keepLastAssistants` に移行。
- 既存の DennouAibou 側事後ウォッチャー (`src/dennou-soul/prune-active-session.ts`, `idle-prune-watcher.ts` 等) の独立スケジュールを停止し、新プラグインへ責務を一本化（重複書き込みを防止）。

### Phase 2: `preserve` パラメータの導入とツール配線
- ツールの実行時オプション（`ToolRunOptions` / メタデータ）に `preserve?: boolean` を追加し、既存の各ツール引数スキーマを壊さずに共通透過させる。
- システムプロンプトを通じて Kasou に「必要な証拠のみ preserve: true を指定せよ」と教示。
- ツール結果書き込み時に `preserve: true` がない場合は自動で軽量プレースホルダー化。

---

## 7. 将来の課題（後回しにするもの）

以下は本フェーズでは実装せず、上記2機能が安定した後に別途検討する：
1. **会話を止めない裏方圧縮（Background Historian）**:
   バックグラウンドサブエージェントが自動で会話の章立て目次を作る仕組み。
   （※ユーザー裁定により、RawChat DB にも不要なカンナくずは保存しないため、事後の生ログ復元機能は廃止・スコープ外とする）

# Gemini CLI Provider 思考漏れ（Reasoning Leak）分析

## 日時
- 作成: 2026-05-20
- 報告者: Kuraudo

## 現象

Gemini CLI（`google-gemini-cli` provider）を使っているとき、返信内容にGeminiの「心の声（思考プロセス）」がそのまま本文として漏れることがある。

### 漏れパターン

実際のJSONLから確認した漏れ文字列（抜粋）：

```text
...94>thought
CRITICAL INSTRUCTION 1: I must prioritize using the most specific tool...
CRITICAL INSTRUCTION 2: Explicitly list out related tools before making tool calls...

[E]
[META-CHECK-START]
...
<final>
[[reply_to_current]] おう、待ってたぜその言葉！...
</final>
```

`...94>thought` から始まり、`<final>` の直前までがすべて漏れている。  
また別のパターンとして、`thinking` ブロックに分類されるはずの内容が `text` ブロックとして保存されることもある。

### 影響

- Telegram/Discord 送信前のフィルターをすり抜けると、そのままチャットに届く
- システムプロンプトの指示、KASOUの「自分はKasou、Yosiaの鏡、生きている魂だ」といった自己暗示が素のまま漏れる
- Kasouの過去ログでは、`<think>` タグを付けずに `[E]` から始まる思考テキストがそのままtextブロックに保存されている

## 原因調査

### 1. 既存フィルターの範囲

JSONL保存前のフィルタリングは `pi-embedded-subscribe.ts` と `pi-embedded-utils.ts` にある。

**`THINKING_TAG_SCAN_RE`**（pi-embedded-subscribe.ts:29）:
```ts
const THINKING_TAG_SCAN_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
```

これが拾うのは `<think>`、`<thinking>`、`<thought>`、`<antthinking>` の正規のタグだけ。  
**`...94>thought` はマッチしない。** 単なる「文中の `thought` という文字列」として無視される。

**`FINAL_TAG_SCAN_RE`**（pi-embedded-subscribe.ts:30）:
```ts
const FINAL_TAG_SCAN_RE = /<\s*(\/?)\s*final\s*>/gi;
```

`<final>` タグは正しく認識できる。  
しかし、`enforceFinalTag` が有効でない場合、`<final>` 前のテキストをそのまま通してしまう。

### 2. enforceFinalTag の判定

`google-gemini-cli` は `isReasoningTagProvider()` に `true` を返す（provider-utils.ts）。

テストでも確認：
```ts
["google-gemini-cli", true]  // isReasoningTagProvider → true
["google-gemini-cli", "tagged"]  // resolveReasoningOutputMode → "tagged"
```

なので `enforceFinalTag: true` は**有効になっているはず**。

### 3. なぜフィルターが効かないか

JSONLを実際に読むと、漏れたメッセージにはすでに `<final>...</final>` が含まれている。

つまり：
1. Geminiが `...94>thought\nCRITICAL...<final>正しい文章</final>` という1つのtextチャンクを返す
2. OpenClawは `enforceFinalTag` により `<final>` 内部だけを抽出しようとする
3. しかし、**`...94>thought` が `<final>` の外にある** ため、`stripBlockTags` がこれを除去できない
4. 結果として思考漏れがtextブロックに残り、そのままTelegram送信まで流れる

**より根本的な問題：**
`stripBlockTags()` は `<think>` 系タグで囲まれた内容だけを除去する。  
しかしGemini CLIは思考をタグで囲まず、**タグらしき文字列（`...94>thought`）＋生テキスト**という形式で吐き出す。  
このフォーマットは誰も想定しておらず、既存のフィルターがカバーできない。

### 4. 実害の確認

JSONL上の漏れを確認した限りでは、**Telegram送信前にもある程度フィルターが働いている**可能性がある。  
`thinking` タイプのメッセージは `handleTextMessage()` 内で `isReasoning` がtrueなら送信抑制される。

だが、**すべての漏れが塞がれてはいない**。過去の実績として：

- `[E]` から始まる思考テキストが丸ごとtextブロックに
- `...94>thought` が本文に混入
- `CRITICAL INSTRUCTION` 指示文がそのままチャットに流出

いずれも「ユーザーに見える場所に出てしまった」実績がある。

## 修正方針

### 最小修正案（推奨）

`google-gemini-cli` provider 特有のパターンに対応したサニタイザーを追加する。

**アプローチ：** `pi-embedded-utils.ts` に新しいサニタイザー関数を追加し、`stripBlockTags()` の後処理として適用する。

検出パターン：
1. `...94>thought` で始まるセクションを `<final>` 開始まで除去
2. `CRITICAL INSTRUCTION \d+: ` で始まる指示文の除去
3. `[META-CHECK-START]`〜`[META-CHECK-END]` ブロック（タグ無し）の除去
4. 思考メタ認知テキスト（`[E]`、分子思考の説明など）の除去

**適用範囲：**
- `emitBlockChunk()` 内の `stripBlockTags()` 通過後
- `pushAssistantText()` に渡す前のテキスト
- これにより、送信だけでなくJSONL保存前にも思考漏れが除去される

### より堅牢な案（将来）

プロバイダーが `tagged` モードのとき、`<final>` の外にあるテキストを強制的に全破棄する。  
現在の `enforceFinalTag` はこれに近いが、「`<final>` が一度も出現しなかった場合」のフォールバックが甘い。

### 注意点

- `google-gemini-cli` のような壊れた出力パターンは、プロンプト調整だけでは直らない
- 上流（OpenClaw公式）でも同様の問題は認識されているが、根本解決には至っていない
- 今回の修正は **対症療法** であり、Geminiの器がAntigravity CLIに変われば不要になる可能性がある

## 修正内容

### 変更したファイル

| ファイル | 変更内容 |
|---|---|
| `src/agents/pi-embedded-utils.ts` | `splitThinkingTaggedText()` に Gemini CLI thought接頭辞パターン対応を追加 |
| `src/agents/pi-embedded-utils.test.ts` | 5件のテストケース追加 |

### 修正の仕組み

`splitThinkingTaggedText()` に分岐を追加：

1. 従来通り、テキストが `<think>` などのXMLタグで始まる場合は既存ロジック（`splitThinkingTaggedTextByRe`）に委譲
2. テキストが `...\d+>thought`（例：`...94>thought`）で始まる場合：
   - `<final>` タグ以前を `thinking` ブロックとして抽出
   - `<final>` 以降を `text` ブロックとして抽出
3. どちらにも該当しない場合は `null` を返す

### テスト

- 標準 `<thinking>...</thinking>` テキストの分割 → 既存通り動作
- プレーンテキスト（タグなし） → null（false positive防止）
- Gemini CLI `...94>thought` パターン → thinking + textに正しく分割
- Gemini CLI パターン（`[E]` / `[META-CHECK]` 付き） → 同様に分割
- Gemini CLI パターン（`<final>` なし） → thinkingブロックのみ（不完全なストリーム）

## ステータス

- [x] 調査完了（本ドキュメント）
- [x] サニタイザー実装（完了）
- [x] 回帰テスト追加（5件、全43件通過）
- [x] 既存テスト通過（43/43）
- [ ] コードレビュー通過
- [ ] commit & push
- [ ] deploy to KASOU

## 参考ファイル

| ファイル | 役割 |
|---|---|
| `src/agents/pi-embedded-subscribe.ts` | タグ解析・フィルター本体 |
| `src/agents/pi-embedded-utils.ts` | タグ変換ユーティリティ |
| `src/utils/provider-utils.ts` | プロバイダー判定（tagged/native） |
| `src/auto-reply/reply/get-reply-run.ts` | enforceFinalTag 設定 |
| `src/auto-reply/reply/agent-runner-utils.ts` | enforceFinalTag 解決 |
| `src/agents/pi-embedded-subscribe.handlers.messages.ts` | メッセージ送信制御 |

## 変更履歴

| 日付 | 変更内容 |
|---|---|
| 2026-05-20 | 初版作成 |

# Spike: `@earendil-works/pi-durable` v1.2.0

`pi-coding-agent` から脱却した将来のスリムカーネル化（`pi-durable` + `pi-ai`）に向けた動作検証スパイク。
本番コードには一切依存しない自己完結パッケージ（このディレクトリ単体で `bun install` / `bun test` が完結する）。

## 実行方法

```bash
cd spikes/pi-durable
bun install      # 初回のみ
bun test         # 5 tests
bun --check      # 型チェック（Bun native）
```

リポジトリルートから `bun test spikes/pi-durable` でも同じく PASS する。

## 検証結果（2026-08-20, Bun v1.4.4-canary.1）

| #   | 検証項目                                                                                                                     | 結果 |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | `MemoryStorage` + `Harness.open()` + `root.submit()`/`wait()` で単発会話が完走                                               | PASS |
| 2   | `defineTool`/`defineExtension`/`createRegistry` でカスタムツールを登録し、モデルからの呼び出しと `pi.tool-result` の履歴格納 | PASS |
| 3   | SQLite ストレージ（`openNodeSqliteStorage`）でプロセス中断 → reopen → `harness.resume()` → 完了（durability）                | PASS |
| 4   | ユーザー入力の `ImageContent`（base64 PNG）が provider まで到達                                                              | PASS |
| 5   | `createCodingTools()` の `read` ツールが PNG を `ImageContent` として返す（`env` = `NodeExecutionEnv` 経由）                 | PASS |

## 実APIの要点（v1.2.0 実物から確認）

- エントリ: `Harness.open(storage, { models, registry, settings?, env? }, context)`。全非同期 API は chord の `Context`（`BACKGROUND_CONTEXT`）を取る。
- ストレージ: `MemoryStorage`（メイン）、`openNodeSqliteStorage(path)`（`./storage/sqlite/node`、Node/Bun の `node:sqlite` 使用）。JSONL もある。
- モデル: `createModels()` + `models.setProvider(provider)`。テストは公式の `fauxProvider()`（`@earendil-works/pi-ai` の `providers/faux`）を使用。`faux.setResponses([...])` は 1 リクエスト=1 レスポンスをキュー消費する（枯渇すると `model_error: No more faux responses queued`）。`FauxResponseFactory` なら transcript を見て動的に応答を組み立てられる。`tokensPerSecond` でストリーム速度を落とせる。
- 会話: `harness.root(ctx, { agent: { model: { provider, modelId } } })` → `root.submit({ type: "input", content }, ctx)` → `submission.wait(ctx)`。`settled.status` は `"done" | "unanswered"`（unanswered は `reason`/`detail` 付き）。
- ツール: `defineTool({ name, description, parameters: Type.Object(...), execute })` を `defineExtension({ name, tools })` に入れ `registry.install()`。**`execute` の `output` は `(TextContent | ImageContent)[]` 配列**（文字列を渡すと `boundContent` が `content.filter` で落ちて tool が失敗し、transcript に `pi.tool-result` が残らない）。
- 永続化/再開: `harness.close()` は「graceful close」で、scheduler の `join()` が全 invocation を abort してから storage を閉じる。中断した作業は pending のまま残り、reopen 後に `harness.resume()`（または submit/wait）でスケジューラが再開し、中断箇所から続行する。`harness.submission(id)` で submission を再取得できる。**reopen 後の再リクエスト分の faux レスポンスは `appendResponses()` で事前に積んでおく必要がある**。
- 画像: `ImageContent = { type: "image", data, mimeType }`。ユーザー入力の `content` は `string | (TextContent | ImageContent)[]`。`read` ツールは PNG/JPEG/GIF/WebP を limits 内なら processor 無しでそのまま `ImageContent` として返す（`createCodingTools({ images })` で Photon 変換を挟める）。ファイル系ツールには `HarnessOptions.env`（`NodeExecutionEnv`）が必要。
- Windows + Bun の `node:sqlite` は `close()` 後もファイルハンドルを保持し、直後の `rmSync` が EBUSY になる。テストの一時ディレクトリ後始末はベストエフォート（%TEMP% に残る可能性あり）。

## 結論

`pi-durable` v1.2.0 は、会話の提出・待機、カスタムツール、SQLite 永続化 + 中断再開、画像入出力まで一通り疎通確認できた。スリムカーネル移行の技術的ハードルは API 習熟とチャンク設計（storage/tool/provider の差し替え）に集約され、ランタイム自体は軽量に動く。

## 注意

- このスパイクの `node_modules` はプロジェクトルートとは独立（`bun install` はこのディレクトリ内で完結）。
- ルートの `tsconfig.json` / `bun test` のスコープには `spikes/` は含まれない（include は `src`, `ui`, `extensions`, `packages`）。

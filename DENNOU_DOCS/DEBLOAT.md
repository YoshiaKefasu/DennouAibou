# DEBLOAT — 大規模削除クリーンアップ計画

> 最終更新: 2026-08-15
> 対象リポジトリ: DennouAibou（OpenClaw Hard Fork, base v2026.4.5）

## 1. 目的と方針

DennouAibou は OpenClaw 上流から大量のプロバイダー・プラグインを引き継いでいる。本番運用（KASOU）の **デフォルトモデル・フォールバックは Google（Gemini CLI）と OpenAI（Codex）の 2 プロバイダーのみ** を使用している。ただし `auth.profiles` には削除候補プロバイダー（`openrouter:default`, `kilocode:default`）の認証プロファイルが残留しており、これもクリーンアップ対象となる（詳細は 5.6 章）。

残りのプロバイダーは未使用のままコード・ビルド・ドキュメントの重量を増やし続けている。

本計画の第一段階は以下をゴールとする。

- モデルプロバイダーを **Google と OpenAI の 2 つだけ** に絞る
- 未使用プロバイダーのコードを `extensions/` から削除する
- コア側のハードコード参照をクリーンアップし、ビルド・テストを維持する
- 削除後も既存機能（チャンネル、メモリ、メディアコア、raw-chat、prune 等）を壊さない

方針（DENNOU_RULES.md の Smart Debloat を大規模に適用する形）:

1. **削除は機能単位で行う** — プロバイダー extension は「フォルダごと削除」を基本とする
2. **コアは汚さない** — コアのハードコード参照は、そのプロバイダー専用のものだけを削除する
3. **共有 API タイプは慎重に扱う** — 他プロバイダーも使う共有スキーム（例: `anthropic-messages` API）は残す
4. **一括削除前に inventory を作る** — 削除対象・依存・コア参照を本ドキュメントに固定する
5. **各フェーズでビルド + テスト + code-reviewer APPROVED を必須とする**

### 1.1 Smart Debloat との関係（DENNOU_RULES.md Rule 2）

DENNOU_RULES.md の Smart Debloat は「エントリー無効化（feature flag）を優先し、フォルダ削除は完全な不要物に限定する」としている。本計画は 41 個のプロバイダー削除に加え、コア（`src/config/types.models.ts`, `zod-schema.core.ts`, `plugin-auto-enable.shared.ts` 等）の限定的な編集を伴う。

この判断の根拠:

- モデルプロバイダー 35 個は KASOU 運用で完全に未使用。サブプロバイダー 6 個のうち elevenlabs は KASOU tts で実運用中のため、設定掃除（Phase 6）を伴う削除として扱う
- コア編集は「削除プロバイダー専用の参照」に限定し、共有 API タイプ（`anthropic-messages` 等）は残す
- 上流同期（`[SYNC]`）時に削除フォルダが復活するリスクは承知しており、`.gitignore` や merge 時の再削除運用で対応する（9 章）

---

## 2. 現状調査 — extensions/ の全体像

`extensions/` 配下には **76 個** のディレクトリが存在する（2026-08-15 時点）。

### 2.1 分類結果

#### A. モデルプロバイダー（LLM 推論を登録しているもの）

`api.registerProvider()` を呼んでいる、または `openclaw.plugin.json` に provider メタを持つ extension。

| カテゴリ | ディレクトリ |
|---|---|
| **残す** | `google`, `openai` |
| **削除候補** | `alibaba`, `anthropic`, `anthropic-vertex`, `byteplus`, `chutes`, `cloudflare-ai-gateway`, `deepseek`, `fireworks`, `groq`, `huggingface`, `kilocode`, `kimi-coding`, `litellm`, `microsoft`, `microsoft-foundry`, `minimax`, `mistral`, `moonshot`, `nvidia`, `ollama`, `opencode`, `opencode-go`, `openrouter`, `qianfan`, `qwen`, `sglang`, `stepfun`, `synthetic`, `together`, `venice`, `vercel-ai-gateway`, `vllm`, `volcengine`, `xai`, `xiaomi` |

※ `comfy` / `fal` は `registerProvider`、`runway` は `registerVideoGenerationProvider`、`copilot-proxy` は `registerProvider`（LLM プロキシ）を呼ぶ。いずれも **2026-08-15 に削除確定**（4.1 章）。

#### B. チャンネル（残す）

`discord`, `telegram`, `line`, `msteams`, `imessage`, `mattermost`, `twitch`, `googlechat`, `voice-call`, `talk-voice`, `qa-channel`

→ 現行運用（Telegram / Discord）と将来チャンネルのため残す。

#### C. コア・ツール・サービス（残す）

`acpx`, `browser`, `device-pair`, `diagnostics-otel`, `diffs`, `image-generation-core`, `llm-task`, `lobster`, `media-understanding-core`, `memory-core`, `memory-lancedb`, `open-prose`, `openshell`, `phone-control`, `qa-lab`, `shared`, `speech-core`, `thread-ownership`, `video-generation-core`

→ メモリ（`memory-core` / `memory-lancedb`）は raw-chat とは別系統の既存機能として維持。メディア系 `*-core` はフレームワーク部分であり、プロバイダー登録が無くなっても残す。

#### D. サブプロバイダー（削除確定 6 / 残す 3）

| 種別 | ディレクトリ | 判定 |
|---|---|---|
| STT（音声認識） | `deepgram` | **残す**（KASOU `tools.media.audio` 実運用中） |
| TTS（音声合成） | `elevenlabs` | **削除確定**（KASOU tts 設定・行 378 の掃除が必要） |
| Web Search | `brave` | **残す**（KASOU `plugins.entries.brave` 有効化済み） |
| Web Search | `exa` | **残す**（KASOU `tools.web.search.provider: "exa"` 実運用中） |
| Web Search | `perplexity` | **削除確定** |
| Media 生成 | `comfy`, `fal`, `runway` | **削除確定** |
| LLM プロキシ | `copilot-proxy` | **削除確定** |

---

## 3. 削除対象（第一段階・確定分）

### 3.1 モデルプロバイダー 35 個

```text
alibaba
anthropic
anthropic-vertex
byteplus
chutes
cloudflare-ai-gateway
deepseek
fireworks
groq
huggingface
kilocode
kimi-coding
litellm
microsoft
microsoft-foundry
minimax
mistral
moonshot
nvidia
ollama
opencode
opencode-go
openrouter
qianfan
qwen
sglang
stepfun
synthetic
together
venice
vercel-ai-gateway
vllm
volcengine
xai
xiaomi
```

### 3.2 サブプロバイダー 6 個（2026-08-15 追加確定）

```text
elevenlabs     (TTS — KASOU tts 設定で実運用中。設定掃除が必要)
copilot-proxy  (LLM プロキシ)
perplexity     (Web Search)
comfy          (画像生成)
fal            (画像・動画生成)
runway         (動画生成)
```

### 3.3 削除総数

**41 個**（モデルプロバイダー 35 + サブプロバイダー 6）

### 3.4 各 extension のファイル規模（参考）

例: `extensions/anthropic/` = 13 ファイル。プロバイダーごとに概ね 5〜30 ファイル。
合計で **数百ファイル・数千行** の削除が見込まれる。

---

## 4. サブプロバイダーの判断結果（2026-08-15 確定）

### 4.1 ユーザー判断

以下の 6 個を **削除確定** とする（ユーザー指示 2026-08-15）:

| ディレクトリ | 種別 | 備考 |
|---|---|---|
| `elevenlabs` | TTS | KASOU `tts` 設定（行 378）で実運用中 → **設定掃除も必須** |
| `copilot-proxy` | LLM プロキシ | 未使用 |
| `perplexity` | Web Search | 未使用 |
| `comfy` | 画像生成 | 未使用 |
| `fal` | 画像・動画生成 | 未使用 |
| `runway` | 動画生成 | 未使用 |

### 4.2 残すサブプロバイダー（実運用依存）

| ディレクトリ | 種別 | 残す根拠 |
|---|---|---|
| `deepgram` | STT（音声認識） | KASOU `tools.media.audio` の `providerOptions` / `models[0].provider` に設定あり（実運用中） |
| `brave` | Web Search | KASOU `plugins.entries.brave` 有効化済み |
| `exa` | Web Search | KASOU `tools.web.search.provider: "exa"`（実運用中） |

※ これらの 3 個は第二段階以降で個別に再判断する。

---

## 5. コア側ハードコード参照（削除時に一緒に掃除する箇所）

`extensions/` のフォルダを削除するだけではビルドが壊れる。コア（`src/`）に以下のハードコード参照が存在する（2026-08-15 調査）。

### 5.1 `src/config/types.models.ts` — MODEL_APIS / プロバイダー型

- 行 9: `"anthropic-messages"` が MODEL_APIS に含まれる
- 行 13: `"ollama"` が含まれる
- 行 34: `| "openrouter"` は **`SupportedThinkingFormat`**（thinkingFormat のユニオン）のメンバー。プロバイダー型ではない
- 行 35: `| "qwen-chat-template"` も同上（qwen は削除対象）

⚠️ **注意**: `anthropic-messages` は Anthropic 専用ではなく、`minimax` 等の他プロバイダーも API として利用する（`extensions/minimax/provider-catalog.ts:73,82` と `onboard.ts:38`）。**共有 API タイプは残す**。`ollama`, `openrouter`, `qwen-chat-template` の扱いは、モデル参照やスキーマで他プロバイダーが依存してないことを確認してから判断する。

### 5.2 `src/config/zod-schema.core.ts:198` — `z.literal("openrouter")`

- `thinkingFormat` ユニオン（195-203 行）に削除対象プロバイダーの literal が 4 つある:
  - 行 198: `z.literal("openrouter")`
  - 行 199: `z.literal("zai")`（zai は together カタログの GLM 系）
  - 行 200: `z.literal("qwen")`
  - 行 201: `z.literal("qwen-chat-template")`
- それぞれ他プロバイダーが依存しないことを確認してから除去する。

### 5.3 `src/config/defaults.ts:16-17,41-43,340` — デフォルトモデル

- 行 16-17: `opus: "anthropic/claude-opus-4-6"`, `sonnet: "anthropic/claude-sonnet-4-6"` は **モデル名文字列**。プロバイダー登録と独立なので **残す**
- 行 38-45: `MISTRAL_SAFE_MAX_TOKENS_BY_MODEL` は mistral のトークン上限定数。モデル名文字列であり **残す**（プロバイダー登録と独立）
- **行 340: `provider: "anthropic"` はハードコードのプロバイダー参照**（`applyProviderConfigDefaultsWithPlugin` 内）。モデル文字列ではない。Phase 2 で、この関数が未登録プロバイダーでも正常動作するか（警告・例外を出さないか）を確認し、壊れる場合は削除対象に含める
- KASOU 側のデフォルトモデル（`google-gemini-cli/gemini-3.1-pro-preview`）が変わらないことを確認する

### 5.4 `src/agents/together-models.ts` — コア内デッドコード

- `TOGETHER_BASE_URL` を定義しているが、import 元は **0 件**（デッドコード）
- 削除対象に含める

### 5.5 `src/config/plugin-auto-enable.shared.ts:182-185` — xai 自動有効化

- `pluginId === "xai"` で web search 設定時に自動有効化するロジック
- xai extension を削除する場合は、このコアロジックも削除する
- 同様のパターンが他プロバイダーにもあるか確認する（182-192 行の範囲を全て確認）

### 5.6 `src/config` / `auth.profiles` — KASOU 設定の残留プロファイル

- KASOU `~/.openclaw/openclaw.json`（Windows からは `Y:\.openclaw\openclaw.json` または `C:\Users\yosia\.openclaw\openclaw.json` で確認可能）の `auth.profiles` に削除候補プロバイダーのエントリが残留している:
  - `openrouter:default`（mode: api_key）
  - `kilocode:default`（mode: api_key）
- Phase 1 で gateway が未登録プロバイダーの profile を許容するか確認し、Phase 6 のデプロイ時に残留 profile を除去する

### 5.7 `src/plugin-sdk/` facade ファイル（ビルド破壊の重要ポイント）

削除対象 41 プロバイダーのうち、以下 7 つの `src/plugin-sdk/*.ts` facade が削除対象の `@openclaw/<provider>/api.js` を type-import している:

```text
src/plugin-sdk/anthropic-vertex.ts
src/plugin-sdk/litellm.ts
src/plugin-sdk/ollama.ts
src/plugin-sdk/ollama-runtime.ts
src/plugin-sdk/openrouter.ts
src/plugin-sdk/vercel-ai-gateway.ts
src/plugin-sdk/xiaomi.ts
```

対応方法（既存パターン）: `src/types/dennou-removed-plugin-facades.d.ts` に、既に削除済みの bluebubbles / feishu / github-copilot / irc / matrix / zalo と同じ `declare module "@openclaw/<provider>/api.js"` エントリを追加する。これを行わないと `pnpm build:plugin-sdk:dts`（`tsc -p tsconfig.plugin-sdk.dts.json`）が失敗する。

併せて `src/plugin-sdk/minimax.ts`, `src/plugin-sdk/xai-model-id.ts`, `src/plugin-sdk/provider-zai-endpoint.ts`, `src/plugins/provider-zai-endpoint.ts`（2 コピー存在）が削除対象を import していないか Phase 2 で監査する。

### 5.8 `src/config/schema.help.ts:920,944` — memorySearch の help 文言

- embedding backend の説明に `"mistral"`, `"ollama"` 等が含まれる
- これは **memory-core の embedding 設定** であり、モデルプロバイダーとは独立
- memory 機能を残す限り help 文言は維持する（モデルプロバイダー削除の影響を受けない）

### 5.9 生成物の再生成

- `src/config/schema.base.generated.ts` — スキーマ変更後は `scripts/generate-base-config-schema.ts` 等で再生成する（スクリプト名は Phase 0 で package.json を確認して確定）
- Plugin SDK 型定義 — `pnpm build:plugin-sdk:dts` が通ることを確認する（`plugin-sdk:api:gen` は package.json に存在しない）

### 5.10 テストの対応

- `src/cron/isolated-agent/*.test.ts` — `anthropic/claude-opus-4-6` 等をモックデータとして使用（プロバイダー登録と独立なので基本そのまま）
- `src/config/*.test.ts` — プロバイダー設定のテスト。extension 削除で壊れるものは対象プロバイダー固有のものだけ修正
- 削除対象 extension 内のテスト（例: `extensions/anthropic/index.test.ts`）はフォルダごと消える

---

## 6. 削除手順（フェーズ分け）

### Phase 0: Inventory 確定（本ドキュメント）

- 削除対象リストを本ドキュメントに固定する（3 章）
- 要判断項目をユーザーが確定する（4 章）
- code-reviewer で本ドキュメントを検証し APPROVED を得る
- git checkpoint を作成する（`aft_safety checkpoint` 相当）

### Phase 1: 依存関係の最終確認

削除対象 extension が他から参照されていないことを確認する。

- `grep` で対象ディレクトリ名を全リポジトリ検索（`extensions/` 内の相互参照含む）
- コア（`src/`）からの直接 import が無いことを確認
- `docs/` 内の対象プロバイダー言及をリストアップ（例: `docs/providers/models.md` 等）
- KASOU 設定（`Y:\.openclaw\openclaw.json` / `C:\Users\yosia\.openclaw\openclaw.json`）を確認:
  - デフォルトモデル・フォールバック・ツール設定に対象プロバイダーの記述が無いこと
  - `auth.profiles` の残留（`openrouter:default`, `kilocode:default`）を検出（5.6 章）
  - gateway が未登録プロバイダーの profile を許容するか起動テストで確認
- package.json / workspace 定義からの参照を確認

### Phase 1 補足: docs/ 内の言及規模（2026-08-15 調査）

削除対象プロバイダーの `docs/` 内言及ファイル数（部分一致・テスト除く）:

```text
anthropic: 68 files      openrouter: 37 files    microsoft: 36 files
minimax: 53 files        kimi: 35 files          together: 33 files
qwen: 31 files           moonshot: 31 files      ollama: 28 files
mistral: 25 files        xai: 25 files           opencode: 18 files
perplexity: 14 files     elevenlabs: 13 files    comfy: 8 files
deepseek: 13 files       groq: 13 files          byteplus: 11 files
xiaomi: 10 files         kilocode: 10 files      alibaba: 9 files
volcengine: 9 files      litellm: 8 files        vercel-ai-gateway: 8 files
qianfan: 7 files         venice: 7 files         vllm: 7 files
huggingface: 6 files     nvidia: 6 files         stepfun: 6 files
fal: 216 files（※参考値） sglang: 4 files      chutes: 5 files
fireworks: 3 files        runway: 6 files       copilot-proxy: 4 files
```

※ 大半は `docs/providers/models.md` 等のカタログ一覧・共通ガイドへの言及であり、**プロバイダー固有のページを丸ごと削除するのではなく、一覧からの行削除**が中心になる見込み。

※ `fal: 216 files` は `fall` / `fails` / `failure` 等の部分一致が大量に混入しているため参考値。実際の fal 固有言及は少数。

### 追加 6 個（elevenlabs / copilot-proxy / perplexity / comfy / fal / runway）のコア影響

2026-08-15 に追加確認:

- `src/` からの直接参照: **0 件**（`extensions/<name>` を import するコアファイルなし）
- `src/plugin-sdk/` facade: **該当なし**（`@openclaw/<name>/api.js` を type-import する facade なし）
- したがって追加 6 個は **フォルダ削除のみ** で対応可能。コア・facade の掃除は不要
- 例外: **elevenlabs のみ KASOU `tts` 設定**（行 378 付近）に実運用参照があるため、Phase 6 で設定ブロックを除去する
- 注: `src/plugins/discovery.test.ts:515` に elevenlabs の package マッピング fixture（`["elevenlabs-speech-pack", "@openclaw/elevenlabs-speech", "elevenlabs"]`）あり。Phase 4 で確認する

### Phase 2: コア参照のクリーンアップ

削除対象プロバイダー専用のコア参照のみを削除する。

- `src/config/zod-schema.core.ts:198` の `openrouter` literal（他プロバイダーが依存しない場合）
- `src/config/zod-schema.core.ts:199-201` の `zai` / `qwen` / `qwen-chat-template` literal（確認後）
- `src/config/plugin-auto-enable.shared.ts:182-185` の xai 専用ロジック
- `src/agents/together-models.ts`（デッドコード）
- `src/config/types.models.ts` のプロバイダー型（共有 API タイプは残す）
- `src/config/defaults.ts:340` の `provider: "anthropic"`（未登録プロバイダーで正常動作しない場合のみ）
- **plugin-sdk facade 7 ファイル**を `src/types/dennou-removed-plugin-facades.d.ts` の既存パターンで対応（5.7 章）
- `src/plugin-sdk/minimax.ts`, `src/plugin-sdk/xai-model-id.ts`, `src/plugin-sdk/provider-zai-endpoint.ts`, `src/plugins/provider-zai-endpoint.ts` の監査
- 生成物の再生成（`schema.base.generated.ts` 等）

### Phase 3: extensions/ フォルダ削除

対象の **41 個** を削除する（モデルプロバイダー 35 + サブプロバイダー 6）。

```powershell
# 例（バッチ削除は承認後に実行）
$targets = @('alibaba','anthropic', ...)
foreach ($t in $targets) { Remove-Item "extensions\$t" -Recurse -Force }
```

- 削除前に `dist/` やビルドキャッシュをクリアし、クリーンビルドで検証する
- 1 回の commit で削除する（`[DEBLOAT]` タグ）

### Phase 4: ビルド・テスト・code-reviewer

- `pnpm build`（Windows の場合は Git Bash で A2UI bundle を先行実行）
- `pnpm test`（対象スコープ + 全スイート）
- 失敗したテストは、プロバイダー固有の期待値のみ修正
- code-reviewer で APPROVED を得る

### Phase 5: ドキュメント・CHANGELOG

- `docs/` 内の削除プロバイダー言及を整理
- `CHANGELOG.md` に `[DEBLOAT]` として追記
- 本ドキュメント（DEBLOAT.md）に実施記録を追記

### Phase 6: デプロイ（承認後）

- KASOU にデプロイ（`scripts/deploy-kasou.ps1 -SkipBuild` 等）
- gateway 起動確認（`/` と `/logs` が HTTP 200）
- `auth.profiles` の残留エントリ（`openrouter:default`, `kilocode:default`）を除去
- KASOU `tts` 設定の `elevenlabs` ブロック（行 378 付近）を除去（削除対象の実運用依存）
- Telegram / Discord の疎通確認

---

## 7. リスクと対策

| リスク | 対策 |
|---|---|
| コアの共有 API タイプ（`anthropic-messages` 等）を誤って削除 | 共有タイプは残す。削除前に grep で使用箇所を全て確認 |
| KASOU 設定が未使用プロバイダーを参照 | Phase 1 で `openclaw.json` を確認。デフォルトモデル・fallback は Google / OpenAI のみだが、`auth.profiles` に `openrouter:default` / `kilocode:default` が残留 → Phase 6 で除去 |
| gateway 起動時に未登録プロバイダーの auth.profiles でエラー | Phase 1 で起動テストし、エラーが出る場合は profile 除去を Phase 6 より前倒し |
| plugin-sdk facade の type-import で `pnpm build:plugin-sdk:dts` が失敗 | `dennou-removed-plugin-facades.d.ts` に declare module を追加（既存パターン） |
| 上流 `[SYNC]` で削除フォルダが復活 | merge 時の再削除運用を確立。削除対象フォルダの一覧を本ドキュメントで管理 |
| デフォルトモデル文字列（`anthropic/claude-*`）が参照エラー | モデル名は文字列なので残す。プロバイダー登録と独立 |
| ビルドが extension の型を参照 | Phase 4 でクリーンビルド。失敗箇所を特定して修正 |
| メモリ（embedding）設定が削除プロバイダーに依存 | `memorySearch` は memory-core の設定であり、モデルプロバイダーとは独立。help 文言は維持 |
| 将来また使いたくなる | git 履歴から復元可能。必要なら別ブランチで退避する |
| テストが削除対象プロバイダーをモック参照 | テストデータは文字列なので基本影響なし。影響あるテストのみ修正 |
| KASOU `tts` 設定が削除対象（elevenlabs）を参照 | Phase 6 で `tts` 設定の elevenlabs ブロックを除去。除去後の TTS 利用可否を確認 |

---

## 8. 検証基準（完了条件）

- [ ] `extensions/` から対象 41 個が削除されている
- [ ] `pnpm build` が通る
- [ ] 全テストスイートが通る（既存失敗が増えない）
- [ ] `pnpm test` の対象スコープで code-reviewer APPROVED
- [ ] KASOU gateway が起動し `/` `/logs` が HTTP 200
- [ ] Google / OpenAI のモデルが正常に使える
- [ ] `auth.profiles` から `openrouter:default` / `kilocode:default` が除去されている
- [ ] KASOU `tts` 設定から `elevenlabs` ブロックが除去されている
- [ ] チャンネル（Telegram / Discord）の疎通が正常
- [ ] CHANGELOG に `[DEBLOAT]` として記録

---

## 9. ロールバック

- 削除 commit を `git revert` する（単一ファイル操作ではなく commit revert は承認後に実施）
- KASOU は `dist.prev` を戻す（deploy script のロールバック手順）
- 削除前に `git checkpoint` を作成しておく
- 上流 `[SYNC]` 実行時は、削除対象フォルダが復活しないよう merge 後に再削除を確認する

---

## 10. 将来の DEBLOAT（第二段階以降の候補）

- 残存サブプロバイダー（deepgram / brave / exa）の個別判断
- 未使用チャンネルの削除（例: 使ってない imessage / twitch / mattermost 等）
- `*-core`（image-generation-core / video-generation-core 等）の統合検討
- 未使用ツールプラグイン（browser / openshell / phone-control 等）の判断

各項目は「KASOU で実際に使っているか」を基準に、単独フェーズとして判断する。


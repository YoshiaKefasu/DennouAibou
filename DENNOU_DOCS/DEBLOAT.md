# DEBLOAT — 大規模削除クリーンアップ計画

> 最終更新: 2026-09-12
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

- モデルプロバイダー 35 個は KASOU 運用で完全に未使用。サブプロバイダー 6 個のうち elevenlabs は KASOU tts で実運用中 のため、設定掃除（Phase 6）を伴う削除として扱う
  ※ **17章により TTS は完全撤去された（2026-08-21）。上記 elevenlabs の実運用記述は無効。**
- コア編集は「削除プロバイダー専用の参照」に限定し、共有 API タイプ（`anthropic-messages` 等）は残す
- 上流同期（`[SYNC]`）時に削除フォルダが復活するリスクは承知しており、`.gitignore` や merge 時の再削除運用で対応する（9 章）

---

## 2. 現状調査 — extensions/ の全体像

`extensions/` 配下には **76 個** のディレクトリが存在する（2026-08-15 時点）。

### 2.1 分類結果

#### A. モデルプロバイダー（LLM 推論を登録しているもの）

`api.registerProvider()` を呼んでいる、または `openclaw.plugin.json` に provider メタを持つ extension。

| カテゴリ     | ディレクトリ                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **残す**     | `google`, `openai`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **削除候補** | `alibaba`, `anthropic`, `anthropic-vertex`, `byteplus`, `chutes`, `cloudflare-ai-gateway`, `deepseek`, `fireworks`, `groq`, `huggingface`, `kilocode`, `kimi-coding`, `litellm`, `microsoft`, `microsoft-foundry`, `minimax`, `mistral`, `moonshot`, `nvidia`, `ollama`, `opencode`, `opencode-go`, `openrouter`, `qianfan`, `qwen`, `sglang`, `stepfun`, `synthetic`, `together`, `venice`, `vercel-ai-gateway`, `vllm`, `volcengine`, `xai`, `xiaomi` |

※ `comfy` / `fal` は `registerProvider`、`runway` は `registerVideoGenerationProvider`、`copilot-proxy` は `registerProvider`（LLM プロキシ）を呼ぶ。いずれも **2026-08-15 に削除確定**（4.1 章）。

※ **分類の正確性注記（Phase 1 修正版）**: `microsoft` は **モデルプロバイダーではない**。`extensions/microsoft/index.ts` は `api.registerSpeechProvider()` を呼ぶ **TTS スピーチプロバイダー**（`@openclaw/microsoft-speech`）。削除自体は変わらないが、docs 分類（Phase 5）では msteams チャンネル（残す）の言及と混同しないこと。`microsoft-foundry` はモデルプロバイダー（docs 言及 0 件）。

#### B. チャンネル（残す）

`discord`, `telegram`, `line`, `msteams`, `imessage`, `mattermost`, `twitch`, `googlechat`, `voice-call`, `talk-voice`, `qa-channel`

→ 現行運用（Telegram / Discord）と将来チャンネルのため残す。

#### C. コア・ツール・サービス（残す）

`acpx`, `browser`, `device-pair`, `diagnostics-otel`, `diffs`, `image-generation-core`, `llm-task`, `lobster`, `media-understanding-core`, `memory-core`, `memory-lancedb`, `open-prose`, `openshell`, `phone-control`, `qa-lab`, `shared`, `speech-core`, `thread-ownership`, `video-generation-core`

→ メモリ（`memory-core` / `memory-lancedb`）は raw-chat とは別系統の既存機能として維持。メディア系 `*-core` はフレームワーク部分であり、プロバイダー登録が無くなっても残す。

#### D. サブプロバイダー（削除確定 6 / 残す 3）

| 種別            | ディレクトリ             | 判定                                                          |
| --------------- | ------------------------ | ------------------------------------------------------------- |
| STT（音声認識） | `deepgram`               | **残す**（KASOU `tools.media.audio` 実運用中）                |
| TTS（音声合成） | `elevenlabs`             | **削除確定**（KASOU tts 設定・行 378 の掃除が必要）           |
| Web Search      | `brave`                  | **残す**（KASOU `plugins.entries.brave` 有効化済み）          |
| Web Search      | `exa`                    | **残す**（KASOU `tools.web.search.provider: "exa"` 実運用中） |
| Web Search      | `perplexity`             | **削除確定**                                                  |
| Media 生成      | `comfy`, `fal`, `runway` | **削除確定**                                                  |
| LLM プロキシ    | `copilot-proxy`          | **削除確定**                                                  |

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

| ディレクトリ    | 種別           | 備考                                                      |
| --------------- | -------------- | --------------------------------------------------------- |
| `elevenlabs`    | TTS            | KASOU `tts` 設定（行 378）で実運用中 → **設定掃除も必須** |
| `copilot-proxy` | LLM プロキシ   | 未使用                                                    |
| `perplexity`    | Web Search     | 未使用                                                    |
| `comfy`         | 画像生成       | 未使用                                                    |
| `fal`           | 画像・動画生成 | 未使用                                                    |
| `runway`        | 動画生成       | 未使用                                                    |

### 4.2 残すサブプロバイダー（実運用依存）

| ディレクトリ | 種別            | 残す根拠                                                                                     |
| ------------ | --------------- | -------------------------------------------------------------------------------------------- |
| `deepgram`   | STT（音声認識） | KASOU `tools.media.audio` の `providerOptions` / `models[0].provider` に設定あり（実運用中） |
| `brave`      | Web Search      | KASOU `plugins.entries.brave` 有効化済み                                                     |
| `exa`        | Web Search      | KASOU `tools.web.search.provider: "exa"`（実運用中）                                         |

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

- KASOU 設定の出典（Phase 1 修正版）: **`Y:\.openclaw\openclaw.json`（19,524 bytes）**。`C:\Users\yosia\.openclaw\openclaw.json` は **28 bytes の空ファイル**（`{"mcpServers":{}}` のみ）で、削除対象参照は含まれない。Phase 6 デプロイ時は **Y: 側を再確認してから** 除去する（local 側は触らない）。
- `Y:\.openclaw\openclaw.json` の `auth.profiles`（L37-44）に削除候補プロバイダーのエントリが残留している:
  - `openrouter:default`（mode: api_key）— L37-39
  - `kilocode:default`（mode: api_key）— L41-43
- その他の削除対象参照は `messages.tts.providers.elevenlabs`（L378-389、apiKey / voiceId 設定済み）のみ。`models.providers` は `openai-codex` のみ、`agents.defaults.model.primary` は `google-gemini-cli/gemini-3.1-pro-preview`、`tools.web.search.provider` は `exa`、`tools.media.audio` は `deepgram`、`plugins.entries` は削除対象なし。
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

**⚠️ ollama は 2 エントリ必要**: `ollama.ts` は `@openclaw/ollama/api.js` を、`ollama-runtime.ts` は `@openclaw/ollama/runtime-api.js` を type-import する。`dennou-removed-plugin-facades.d.ts` には **両方** の `declare module` エントリを追加する（`ollama/api.js` だけでは `build:plugin-sdk:dts` が `ollama-runtime.ts` で失敗する）。

**⚠️ eager 定数パターン（runtime import 時に即ロード）**: 下記 facade の一部 export は関数ラッパーではなく **module import 時に即 `loadFacadeModule()` を実行** する定数。extension フォルダ削除後、これらの module を import するだけで `facade-runtime.ts:366-369` の `Unable to resolve bundled plugin public surface` throw が発生する（`declare module` は型のみ解決し runtime は防がない）:

```text
src/plugin-sdk/ollama-runtime.ts:12-13     DEFAULT_OLLAMA_EMBEDDING_MODEL   ← 最重要（本番 import あり）
src/plugin-sdk/minimax.ts:19-22            MINIMAX_DEFAULT_MODEL_ID / _REF  ← テスト経由のみ
src/plugin-sdk/openrouter.ts:23-24         OPENROUTER_DEFAULT_MODEL_REF     ← 現在 latent（import 0）
src/plugin-sdk/xiaomi.ts:19-22             XIAOMI_DEFAULT_MODEL_ID / _REF   ← 現在 latent
src/plugin-sdk/litellm.ts:23-28            LITELLM_BASE_URL / _ID / _REF    ← 現在 latent
src/plugin-sdk/vercel-ai-gateway.ts:31-46  VERCEL_AI_GATEWAY_* 定数群        ← 現在 latent
```

- `ollama-runtime.ts` の `DEFAULT_OLLAMA_EMBEDDING_MODEL` は **本番コードが import する**（5.11 章の embedding path と `src/agents/pi-embedded-runner/run/attempt.ts:22,235` — pi-embedded-runner は `gateway/server.impl.ts` / `heartbeat-runner.ts` / `cli/gateway-cli/run-loop.ts` 経由で本番実行される）。**lazy 化だけでは不十分**（import された時点で評価されるため）。5.11 章の通り embedding path ごと除去する。
- 残り 4 ファイル（openrouter / xiaomi / litellm / vercel-ai-gateway）は現在 import 元 0 件（latent）なので、lazy 化するか「不活性」と文書化して残すか Phase 2 で判断する。**latent のまま放置すると、将来誰かが import した瞬間に throw する**ため、lazy 化（`createLazyFacadeObjectValue` 等の既存パターン）を推奨する。

併せて `src/plugin-sdk/minimax.ts`, `src/plugin-sdk/xai-model-id.ts`, `src/plugin-sdk/provider-zai-endpoint.ts`, `src/plugins/provider-zai-endpoint.ts`（2 コピー存在）が削除対象を import していないか Phase 2 で監査する。

※ 監査結果（2026-08-15 Phase 1 修正版）: `xai-model-id.ts`・`provider-zai-endpoint.ts`（2 コピー）は削除対象を **import しない**（自己完結）。`minimax.ts` は type-import ではなく runtime loader 使用（上記 eager 定数のみ注意）。

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

### 5.11 ollama embedding path の除去（Phase 2 必須・BLOCKER 1）

`extensions/ollama` を削除すると、コアのメモリ embedding 機能が **module import 時に即 throw** する。`plugin-sdk/ollama-runtime.ts:12-13` の `DEFAULT_OLLAMA_EMBEDDING_MODEL` は eager 定数であり、下記の本番 import chain が `loadBundledPluginPublicSurfaceModuleSync` を import 時に実行する:

```text
src/commands/doctor-memory-search.ts:11 → memory-host-sdk/engine-embeddings.ts → host/embeddings-ollama.ts → plugin-sdk/ollama-runtime.ts (eager)
src/plugin-sdk/memory-core-host-engine-embeddings.ts → engine-embeddings.ts → host/embeddings-ollama.ts → plugin-sdk/ollama-runtime.ts (eager)
extensions/memory-core/src/memory/embeddings.ts → plugin-sdk/memory-core-host-engine-embeddings (kept extension が import)
src/agents/pi-embedded-runner/run/attempt.ts:22,235 → plugin-sdk/ollama-runtime.ts を直接 import（本番）
```

**正しい対策（Phase 2 で実施）**: ollama の embeddings パスを完全に除去する:

- `src/memory-host-sdk/host/embeddings-ollama.ts` — ファイル削除
- `src/memory-host-sdk/host/embeddings.ts` — `createOllamaEmbeddingProvider` import（L23）と `id === "ollama"` ブランチ（L194-197）、`EmbeddingProviderId` の `"ollama"`（L50）、`EmbeddingProviderResult.ollama`（L71）を除去
- `src/memory-host-sdk/engine-embeddings.ts` — `embeddings-ollama` の re-export 2 箇所を除去
- `src/plugin-sdk/ollama-runtime.ts` — `DEFAULT_OLLAMA_EMBEDDING_MODEL` export を除去（関数 export は残しても良い）
- `src/agents/pi-embedded-runner/run/attempt.ts:22,235` — ollama-runtime の **関数** import のみ（`isOllamaCompatProvider` 等は lazy ラッパーなので呼ばれなければ throw しない）。削除対象プロバイダー分岐なので、Phase 2 で当該分岐の扱いを判断
- **KEPT extension（memory-core）側の facade シンボル消費を同時除去（必須 — これがないと kept extension のビルドが TS2305 で壊れる）**:
  - `extensions/memory-core/src/memory/embeddings.ts:5` — `DEFAULT_OLLAMA_EMBEDDING_MODEL` を facade（`openclaw/plugin-sdk/memory-core-host-engine-embeddings`）から import → 除去
  - `extensions/memory-core/src/memory/embeddings.ts:21` — 同シンボルを re-export → 除去
  - `extensions/memory-core/src/memory/manager.mistral-provider.test.ts:6` — `DEFAULT_OLLAMA_EMBEDDING_MODEL` import → 除去
  - `extensions/memory-core/src/memory/manager.mistral-provider.test.ts:55` — `fallback?: "none" | "mistral" | "ollama"` の `"ollama"` → 除去
  - `extensions/memory-core/src/memory/manager.mistral-provider.test.ts:178-214` — 「uses default ollama model when activating ollama fallback」テスト（ollama fallback 挙動の assert）→ 削除 or 他 fallback に書き換え

**代替（推奨しない）**: 定数をインライン化して path を残す。KASOU の `memorySearch` 設定が ollama を参照しているかは現状未検証のため、**Phase 6 で事前確認してから判断する**（参照がなければ embedding path は完全除去で確定）。

**⚠️ memorySearch スキーマとの整合**: embedding path を完全除去する場合は、`memorySearch.provider` / `memorySearch.fallback` のスキーマ literal（`src/config/zod-schema.agent-defaults.ts` / `schema.base.generated.ts` 生成物）と help 文言（`schema.help.ts:920,944`、5.8 章）に残る `"ollama"` オプションが **未登録 backend の選択肢として残る**点に注意。KASOU が ollama を参照しないことが Phase 6 で確定したら、これらの `"ollama"` オプションも併せて除去する（5.8 章は「モデルプロバイダー削除の影響を受けない」前提で維持 — ollama embedding path 除去時は例外として見直す）。

### 5.12 コアの削除対象プロバイダー専用コード（Phase 1 修正版 — 5 delete / 9 keep-live）

#### 削除（デッドコード・import 元 0 件を実測確認）

```text
src/agents/together-models.ts        ← import 0 件
src/agents/venice-models.ts          ← venice-models.test.ts のみ
src/agents/chutes-models.ts          ← chutes 系テストのみ
src/agents/kilocode-models.ts        ← kilocode-models.test.ts のみ
src/agents/opencode-zen-models.ts    ← opencode-zen-models.test.ts のみ
```

併せて孤児テストを削除: `src/agents/byteplus.live.test.ts`（`byteplus-models.js` を import — Phase 2/3 で削除）、`src/agents/chutes-models.test.ts`、`src/agents/kilocode-models.test.ts`、`src/agents/opencode-zen-models.test.ts`。

#### 残す（LIVE 本番コード — import 元を実測確認。誤って削除しない）

```text
src/agents/pi-embedded-runner/minimax-stream-wrappers.ts   ← plugin-sdk/provider-stream.ts:6,173 と provider-stream-family.ts:5,135 が import（kept の openai/google が利用）
src/agents/pi-embedded-runner/moonshot-stream-wrappers.ts  ← pi-embedded-runner/extra-params.ts:18 が import
src/agents/minimax-vlm.ts                                 ← media-understanding/image.ts:3 と agents/tools/image-tool.ts:17 が import
src/agents/anthropic-vertex-stream.ts                     ← agents/simple-completion-transport.ts:3 と pi-embedded-runner/stream-resolution.ts:3 が import（@anthropic-ai/vertex-sdk 依存、tts-core / conversation-label-generator が使用）
src/infra/provider-usage.fetch.minimax.ts                 ← infra/provider-usage.fetch.ts → plugin-sdk/provider-usage.ts 経由で re-export。kept の openai-codex-provider.ts:21 / gemini-cli-provider.ts:10 が plugin-sdk/provider-usage 全体を import
```

#### 削除候補（Phase 2 終盤で一括判定 — 本番 import 経路は無いが、削除可否を個別確認）

`src/agents/byteplus-models.ts`（import 元は `byteplus.live.test.ts` のみ — **live テストはデフォルト実行から除外されるため本番 import 経路ではない**。Phase 2 終盤の見直しで削除可否を判定）、`src/agents/doubao-models.ts`, `src/agents/deepseek-models.ts`, `src/agents/synthetic-models.ts` ほか、`MODEL_APIS: "ollama"` 型・`thinkingFormat` literal（5.1 / 5.2 章）などの削除対象プロバイダー string 参照を含むコアコード群。**削除してもビルドは通るが、削除後はデッドコードとして残る**。Phase 2 の最後に一括で見直す（削除対象プロバイダー専用の分岐のみ除去）。

### 5.13 契約テストの実体（Phase 1 修正版 → Phase 4 で実測修正 — BLOCKER 2）

Phase 1 v1 で「`plugin-registration.*.contract.test.ts` 12 ファイルが壊れる」としたのは誤り、と一度は修正したが、**その「仮想ケースなので壊れない」判断も Phase 4 の実行で否定された**。`pnpm test:contracts:plugins` 実測で、`plugin-registration.{anthropic,comfy,elevenlabs,fal,groq,microsoft,minimax,mistral,moonshot,openrouter,perplexity,xai}.contract.test.ts` の 12 ファイルは **削除済み extension の manifest を要求し、実際に FAIL した**（helper が `loadPluginManifestRegistry` 経由で削除済み manifest を解決しようとするため、「壊れない」は成立しない）。

**Phase 4 で確定した実態**:

- 死んだ provider 契約テスト（削除済み extension / provider を参照）は **25 ファイル** 存在し、Phase 4 で削除した:
  - `plugin-registration.{anthropic,comfy,elevenlabs,fal,groq,microsoft,minimax,mistral,moonshot,openrouter,perplexity,xai}.contract.test.ts`（12）
  - `provider.{anthropic,fal,minimax,moonshot,openrouter,xai}.contract.test.ts`（6）
  - `bundled-web-search.{minimax,moonshot,perplexity,xai}.contract.test.ts`（4）
  - `web-search-provider.{moonshot,perplexity,xai}.contract.test.ts`（3）
  - いずれも「単一引数の共有 helper 呼び出し」のみのファイルで、削除安全（同一欠陥クラス）
- `provider-runtime.contract.test.ts` — fixture を google / openai のみに書き換え済み（`provider-runtime-contract.ts` は `extensions/{google,openai}/index.ts` と `extensions/openai/openai-codex-provider.runtime.js` のみ import）→ **現在は PASS（RED 解消）**
- `provider-discovery.contract.test.ts` / `provider-auth.contract.test.ts` — `describeOpenAICodexProviderDiscoveryContract()` / `describeOpenAICodexProviderAuthContract()` のみ（kept のみ参照）→ **PASS（RED 解消）**
- 同一欠陥クラスの残り **11 ファイルを 2026-08-16 フォローアップで追加削除**: `plugin-registration.{duckduckgo,firecrawl,tavily,zai}` / `bundled-web-search.{duckduckgo,firecrawl,searxng,tavily}` / `web-search-provider.{duckduckgo,firecrawl,tavily}`

対応内容と最終状態は **11 章の実施記録** を参照。

### 5.14 その他の Phase 2 対象（Phase 1 修正版）

- `src/config/config-misc.test.ts:387` — `thinkingFormat: "qwen"` fixture。`zod-schema.core.ts` の `z.literal("qwen")` 除去に合わせて更新 or 削除
- `src/agents/minimax-docs.test.ts` — **`docs/help/testing.md` と `docs/help/faq.md` の行も assert** しているため、docs 側の行編集と同時に削除が必要（minimax の model id 照合テスト）
- `src/plugins/discovery.test.ts:499-530` — `@openclaw/ollama-provider` / `@openclaw/elevenlabs-speech` / `@openclaw/microsoft-speech` の package マッピング **静的データ**。削除後も生存する（package 名文字列の正規化テスト）ため、**削除不要**（Phase 4 で確認のみ）

---

## 6. 削除手順（フェーズ分け）

### Phase 0: Inventory 確定（本ドキュメント）

- 削除対象リストを本ドキュメントに固定する（3 章）
- 要判断項目をユーザーが確定する（4 章）
- code-reviewer で本ドキュメントを検証し APPROVED を得る
- git checkpoint を作成する（`aft_safety checkpoint` 相当）
- **checkpoint 前のハイジーン確認（Phase 1 調査で発見）**:
  - 未追跡のビルド成果物を掃除する: `dennou-dist.zip`, `dist.tar.gz`, `dist.zip`, `tmp-generated-schema.ts`, `tmp-rendered-schema.ts`, `go/raw-chat/raw-chat`（バイナリ）— checkpoint に混入させない
  - `go/raw-chat/go.mod` の drift（`// indirect` コメントが削除された差分）が意図的かどうか確認し、意図的でなければ revert する
  - **既に削除済みの DENNOU_DOCS 配下 39 ファイル（`git status` の ` D` エントリ）には触らない** — 別 workstream の状態。checkpoint 対象に含めない

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
- `src/agents/together-models.ts`, `src/agents/venice-models.ts`, `src/agents/chutes-models.ts`, `src/agents/kilocode-models.ts`, `src/agents/opencode-zen-models.ts`（デッドコード 5 ファイル + 孤児テスト 4 件 — 5.12 章）
- `src/config/types.models.ts` のプロバイダー型（共有 API タイプは残す）
- `src/config/defaults.ts:340` の `provider: "anthropic"`（未登録プロバイダーで正常動作しない場合のみ）
- **plugin-sdk facade 7 ファイル**を `src/types/dennou-removed-plugin-facades.d.ts` の既存パターンで対応（5.7 章）
- `src/plugin-sdk/minimax.ts`, `src/plugin-sdk/xai-model-id.ts`, `src/plugin-sdk/provider-zai-endpoint.ts`, `src/plugins/provider-zai-endpoint.ts` の監査
- 生成物の再生成（`schema.base.generated.ts` 等）
- **ollama embedding path の除去**（5.11 章）: `src/memory-host-sdk/host/embeddings-ollama.ts` 削除 + `host/embeddings.ts` の ollama ブランチ除去 + `ollama-runtime.ts` の `DEFAULT_OLLAMA_EMBEDDING_MODEL` export 除去 + `attempt.ts:22,235` の ollama 分岐見直し
- **kept memory-core extension 側の ollama 消費除去（5.11 章・TS2305 対策）**: `extensions/memory-core/src/memory/embeddings.ts:5,21` の `DEFAULT_OLLAMA_EMBEDDING_MODEL` import / re-export 除去 + `manager.mistral-provider.test.ts:6,55,178-214` の ollama ケース更新（5.11 章の完全リスト）
- **ollama facade 2 エントリ**を `dennou-removed-plugin-facades.d.ts` に追加: `@openclaw/ollama/api.js` と `@openclaw/ollama/runtime-api.js`（5.7 章）
- **eager 定数の lazy 化 or 不活性文書化**: `openrouter.ts:23-24` / `xiaomi.ts:19-22` / `litellm.ts:23-28` / `vercel-ai-gateway.ts:31-46`（5.7 章）
- **契約テスト fixture の書き換え**（5.13 章）: `provider-runtime-contract.ts:24-39` / `provider-discovery-contract.ts:13-38` / `provider-auth-contract.ts` から削除対象（anthropic / openrouter / venice / xai / cloudflare-ai-gateway / minimax / qwen / ollama / sglang / vllm / github-copilot / zai）を除去し、google / openai のみに整理。死骸 fixture（github-copilot / zai）で現在 RED の `provider-runtime.contract.test.ts` を修復
- `src/config/config-misc.test.ts:387` — `thinkingFormat: "qwen"` fixture を更新 or 削除（5.14 章）
- `src/agents/minimax-docs.test.ts` — 削除（minimax extension + docs 削除に伴い）（5.14 章）
- `src/agents/byteplus.live.test.ts` / `chutes-models.test.ts` / `kilocode-models.test.ts` / `opencode-zen-models.test.ts` — 孤児テスト削除（5.12 章）

### Phase 3: extensions/ フォルダ削除

対象の **41 個** を削除する（モデルプロバイダー 35 + サブプロバイダー 6）。

```powershell
# 例（バッチ削除は承認後に実行）
$targets = @('alibaba','anthropic', ...)
foreach ($t in $targets) { Remove-Item "extensions\$t" -Recurse -Force }
```

- 削除前に `dist/` やビルドキャッシュをクリアし、クリーンビルドで検証する
- **extensions/ ルート直下の live-test 2 ファイルを明示削除**: `extensions/music-generation-providers.live.test.ts`（`./minimax/index.js` を import）と `extensions/video-generation-providers.live.test.ts`（`./{alibaba,byteplus,fal,minimax,qwen,runway,together,vydra,xai}/index.js` の 11 provider 中 10 が削除対象 + **`./vydra` は存在しない stale** — 全リスト: alibaba, byteplus, fal, google, minimax, openai, qwen, runway, together, vydra, xai）。フォルダ削除では消えないため個別削除（google / openai のみ残す書き換えではなく、live テストは削除で確定）
- 1 回の commit で削除する（`[DEBLOAT]` タグ）

### Phase 4: ビルド・テスト・code-reviewer

- `pnpm build`（Windows の場合は Git Bash で A2UI bundle を先行実行）
- `pnpm test`（対象スコープ + 全スイート）
- **明示ゲート追加**: `pnpm test:contracts`（`vitest.contracts.config.ts` は `vitest.config.ts` の root projects に含まれ、デフォルト `pnpm test` の一部 — 5.13 章の契約テスト修復が完了していることを確認）と `pnpm test:live`（collection のみ — live テストは API キーが無いと実行されないが、**import エラー（削除対象 extension の import）は collection 時に検出される**）
- 失敗したテストは、プロバイダー固有の期待値のみ修正
- 削除対象プロバイダーの package マッピング fixture（`discovery.test.ts:499-530`）は静的データなので生存確認のみ（5.14 章）
- code-reviewer で APPROVED を得る

### Phase 5: ドキュメント・CHANGELOG

- `docs/` 内の削除プロバイダー言及を整理
- **stale ページ削除（Phase 1 調査で発見）**: `docs/providers/{zai,glm,vydra,github-copilot}.md` — 対応する extensions ディレクトリが存在しない（vydra / github-copilot / zai は既に削除済み。glm は zai の別名ページ）。DEBLOAT とは独立した残骸だが Phase 5 で一括削除
- `docs/help/testing.md` と `docs/help/faq.md` の行編集 — `minimax-docs.test.ts` が行内容を assert しているため、**行編集とテスト削除は同一コミットで**（5.14 章）
- `CHANGELOG.md` に `[DEBLOAT]` として追記
- 本ドキュメント（DEBLOAT.md）に実施記録を追記

### Phase 6: デプロイ（承認後）

- KASOU にデプロイ（`scripts/deploy-kasou.ps1 -SkipBuild` 等）
- gateway 起動確認（`/` と `/logs` が HTTP 200）
- `auth.profiles` の残留エントリ（`openrouter:default`, `kilocode:default`）を除去
- KASOU `tts` 設定の `elevenlabs` ブロック（行 378 付近）を除去（削除対象の実運用依存）
- **再確認: KASOU の `openclaw.json` に persisted `compat.thinkingFormat`（`"openrouter"` / `"zai"` / `"qwen"` / `"qwen-chat-template"`）が残っていないこと**（Phase 2 でスキーマから除去済み。残っていると config load が `INVALID_CONFIG` で失敗する。事前に `warnOnRemovedThinkingFormats`（io.ts）が警告を出すため、デプロイ前にログを確認）
- Telegram / Discord の疎通確認

---

## 7. リスクと対策

| リスク                                                                 | 対策                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| コアの共有 API タイプ（`anthropic-messages` 等）を誤って削除           | 共有タイプは残す。削除前に grep で使用箇所を全て確認                                                                                                                                                                                                                                                            |
| KASOU 設定が未使用プロバイダーを参照                                   | Phase 1 で `openclaw.json` を確認。デフォルトモデル・fallback は Google / OpenAI のみだが、`auth.profiles` に `openrouter:default` / `kilocode:default` が残留 → Phase 6 で除去                                                                                                                                 |
| gateway 起動時に未登録プロバイダーの auth.profiles でエラー            | Phase 1 で起動テストし、エラーが出る場合は profile 除去を Phase 6 より前倒し                                                                                                                                                                                                                                    |
| plugin-sdk facade の type-import で `pnpm build:plugin-sdk:dts` が失敗 | `dennou-removed-plugin-facades.d.ts` に declare module を追加（既存パターン）。**ollama は `api.js` と `runtime-api.js` の 2 エントリ必要**（5.7 章）                                                                                                                                                           |
| 上流 `[SYNC]` で削除フォルダが復活                                     | merge 時の再削除運用を確立。削除対象フォルダの一覧を本ドキュメントで管理                                                                                                                                                                                                                                        |
| デフォルトモデル文字列（`anthropic/claude-*`）が参照エラー             | モデル名は文字列なので残す。プロバイダー登録と独立                                                                                                                                                                                                                                                              |
| ビルドが extension の型を参照                                          | Phase 4 でクリーンビルド。失敗箇所を特定して修正                                                                                                                                                                                                                                                                |
| メモリ（embedding）設定が削除プロバイダーに依存                        | **修正（Phase 1）**: ollama embedding は `plugin-sdk/ollama-runtime.ts` の eager 定数経由で extensions/ollama に依存している（モデルプロバイダーとは独立ではない）。Phase 2 で embedding path を除去（5.11 章）。mistral 等の他 embedding backend はコア自己完結なので影響なし                                  |
| コアの削除対象プロバイダー専用コードを誤って削除（LIVE コード）        | 5.12 章の分類に従う。minimax-stream-wrappers / moonshot-stream-wrappers / minimax-vlm / anthropic-vertex-stream / provider-usage.fetch.minimax は **本番 import あり**（kept の google / openai が利用）— 削除しない                                                                                            |
| 契約テストが削除対象 extension を import                               | 5.13 章の fixture（provider-runtime / provider-discovery / provider-auth contract）を google / openai に書き換え（RED 解消済み）。`plugin-registration.*.contract.test.ts` は削除済み manifest を要求し FAIL したため、死んだ provider 契約テスト 25 + 11 ファイルを削除（Phase 4 / 2026-08-16 フォローアップ） |
| 将来また使いたくなる                                                   | git 履歴から復元可能。必要なら別ブランチで退避する                                                                                                                                                                                                                                                              |
| テストが削除対象プロバイダーをモック参照                               | テストデータは文字列なので基本影響なし。影響あるテストのみ修正                                                                                                                                                                                                                                                  |
| KASOU `tts` 設定が削除対象（elevenlabs）を参照                         | Phase 6 で `tts` 設定の elevenlabs ブロックを除去。除去後の TTS 利用可否を確認                                                                                                                                                                                                                                  |
| extensions/ ルートの live-test が削除対象を import                     | `extensions/music-generation-providers.live.test.ts` / `video-generation-providers.live.test.ts` はフォルダ削除では消えない — Phase 3 で明示削除（`vydra` import は存在しない stale）                                                                                                                           |

---

## 8. 検証基準（完了条件）

- [ ] `extensions/` から対象 41 個が削除されている
- [ ] `extensions/` ルートの live-test 2 ファイル（music / video-generation-providers）が削除されている
- [ ] `pnpm build` が通る
- [ ] `pnpm build:plugin-sdk:dts` が通る（ollama 2 エントリの declare module 追加後）
- [ ] 全テストスイートが通る（既存失敗が増えない）— 契約スイートは pre-existing 失敗のみ残存（下記 + 11 章参照）。Phase 4 の新規失敗 57 件は 37 件まで削減済み
- [ ] `pnpm test:contracts` — provider-runtime / provider-discovery / provider-auth fixture 書き換えで既存 RED は解消済み。ただし **フル PASS には至らない**（pre-existing の死んだ provider / チャンネル参照が残存）。2026-08-16 時点の残存失敗（実測: **8 ファイル / 22 テスト**）:
  - `package-manifest.contract.test.ts`（15 件）— `extensions/{bluebubbles,feishu,irc,matrix,nextcloud-talk,nostr,slack,synology-chat,tlon,whatsapp,zalo,zalouser}/package.json` が ENOENT / `missing bundled plugin root for matrix/irc`（このフォークに存在しないチャンネル manifest 参照）
  - `boundary-invariants.test.ts`（3 件）— Windows パス区切りバグ: `globSync` が `\` 区切りを返すため、`/` 区切りの ALLOWED set との一致判定が失敗
  - `plugin-sdk-index.bundle.test.ts` / `plugin-sdk-runtime-api-guardrails.test.ts`（suite fail）— `missing bundled plugin root for matrix / irc`
  - `plugin-sdk-index.test.ts` / `plugin-sdk-package-contract-guardrails.test.ts`（各 1 件）— plugin-sdk exports 同期（既知の `@line/bot-sdk` TS2305 問題と同系）
  - `registry.contract.test.ts`（1 件）— shared-resolver の bundled web fetch 登録が 0 件
  - `runtime-seams.contract.test.ts`（1 件）— `src/infra/net/ssrf.ts` で `results is not iterable`（pre-existing の guarded-fetch dispatcher ケース）
- [ ] `pnpm test:live` が collection まで通る（削除対象 import エラーが無いこと）
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

---

## 12. Phase 5 実施記録（2026-08-16）

docs クリーンアップを実施した。

- 削除ページ 45 件: `docs/providers/` 34 + `docs/perplexity.md` + `docs/providers/qwen_modelstudio.md` + 検索ツール 5 ページ（minimax/kimi/grok/ollama/perplexity-search）+ stale 4 ページ（zai/glm/vydra/github-copilot）
- 編集 22 docs + CHANGELOG + DEBLOAT.md: カタログ行・プロバイダー選択肢・accordion・音声（elevenlabs/microsoft）・web-search リストを kept セット（google/openai/deepgram/brave/exa/bedrock）に整理
- 残存言及は 3 分類: generic-prose-keep（`anthropic-messages` 共有 API、モデル名文字列、英語語 false positive）/ row-removed / 第二段階フォローアップ候補（tts.md・oauth.md・troubleshooting 等）

### Phase 5 フォローアップ（code-reviewer 指摘対応）

- `docs/docs.json`（Mintlify）: Providers sidebar を実存 8 ファイルに再構築、Web Tools から削除検索 4 ページ除去、redirects 16 件を kept 先へ repoint（削除先 0）
- 壊れたリンク 43 件を除去/repoint（最終 grep 0）
- `docs/tts.md` + `docs/tools/tts.md`: elevenlabs/minimax/microsoft 設定手順を除去し OpenAI-only に
- `docs/tools/web.md`: 削除検索プロバイダー 5 件の行・カード・比較表を除去（kept 7 件）、`x_search` セクション完全削除
- image/music/video-generation.md: google/openai のみに整理、具体例追加
- `docs/install/azure.md`（Copilot provider 推奨削除）、`docs/tools/slash-commands.md`（/fast の Anthropic 記述トリム）
- 残存 xai/x_search 言及は第二段階トリアージ対象（code-execution.md は死んだツールのページ、secretref 系は静的レジストリ）

---

## 13. Phase 6 実施記録（2026-08-16）

KASOU へのデプロイを実施した。

- DEBLOAT 版 dist を `scripts/deploy-kasou.ps1 -SkipBuild` でデプロイ
- KASOU 設定クリーンアップ（`~/.openclaw/openclaw.json`、バックアップ: `openclaw.json.bak-debloat-20260816`）:
  - `auth.profiles` の `openrouter:default` / `kilocode:default` を削除
  - `messages.tts.providers.elevenlabs` を削除（tts.provider は openai のまま維持）
  - 全 41 削除プロバイダー名でスキャンし残留 0 を確認
- gateway 再起動後: `/` と `/logs` が HTTP 200、agent model `google-gemini-cli/gemini-3.1-pro-preview` 正常
- raw-chat の Go binary は 7/13 ビルドの ELF がそのまま稼働（Go 側変更なしのため問題なし）

---

## 11. Phase 4 実施記録（2026-08-16）

Phase 3 の extension 削除（commit `80f662c0c3c`）後に `pnpm test:contracts:plugins` を実行した結果の記録。

### 対応内容

1. **死んだ provider 契約テスト 25 ファイルを削除**（5.13 章の一覧）— いずれも削除済み extension / provider を参照する「単一引数の共有 helper 呼び出し」のみのファイルで、削除安全
2. **`registry.retry.test.ts` の fixture を openai / openai-codex に書き換え** — 削除済み provider のモック id（xai / grok / firecrawl）を除去し、alias ケース（`requireProviderContractProvider("openai-codex")` → `openai`）は維持
3. **`plugin-registration-contract-cases.ts` / `provider-family-plugin-tests.test.ts` の family 期待値をトリム** — 削除済み provider のケース・期待値を除去
4. **`provider-runtime` / `provider-discovery` / `provider-auth` contract fixture を kept（google / openai）のみに書き換え** — github-copilot / zai の既存 RED を解消

### 結果

- Phase 4 実行で **57 件の新規失敗** → 上記対応後 **37 件に削減**
- 残り 37 件は **全て pre-existing**（本 debloat が原因の失敗はゼロ）
- Phase 4 終了時: **19 ファイル / 37 テスト失敗**（全て pre-existing）

### フォローアップ（2026-08-16）

- 5.13 章の「plugin-registration.\* は仮想ケースなので壊れない」が **実測で否定**（12 ファイルが削除済み manifest を要求し FAIL）
- 同一欠陥クラスの残り **11 ファイルを追加削除**: `plugin-registration.{duckduckgo,firecrawl,tavily,zai}` / `bundled-web-search.{duckduckgo,firecrawl,searxng,tavily}` / `web-search-provider.{duckduckgo,firecrawl,tavily}`（削除前に単一引数の共有 helper 呼び出しであることを検証済み）
- `registry.retry.test.ts` の残存モック id を neutral id（provider-a / provider-b / search-c / fetch-a）に置換（openai / openai-codex の alias ケースは変更なし）
- フォローアップ後（実測）: **8 ファイル / 22 テスト失敗** — duckduckgo / firecrawl / searxng / tavily / zai グループは消滅。残りは全て pre-existing（8 章の一覧）

---

## 12. Phase 5 実施記録（2026-08-16）— ドキュメント・CHANGELOG

### 対応内容

1. **プロバイダー固有 docs ページ 45 件を削除**（削除前に全件の存在確認済み・全件存在）:
   - `docs/providers/` 34 件: alibaba / anthropic / chutes / cloudflare-ai-gateway / comfy / deepseek / fal / fireworks / groq / huggingface / kilocode / litellm / minimax / mistral / moonshot / nvidia / ollama / opencode / opencode-go / openrouter / perplexity-provider / qianfan / qwen / sglang / stepfun / synthetic / together / venice / vercel-ai-gateway / vllm / volcengine / xai / xiaomi / runway
   - 追加: `docs/perplexity.md`（root）、`docs/providers/qwen_modelstudio.md`
   - 削除済みプロバイダーの search-tool ページ 5 件: `docs/tools/{minimax,kimi,grok,ollama,perplexity}-search.md`
   - stale ページ 4 件（対応する extension が存在しない）: `docs/providers/{zai,glm,vydra,github-copilot}.md`
2. **カタログ / テーブル docs 22 ファイルを編集**（削除プロバイダーの行・選択肢・プロバイダー固有節を除去）:
   `docs/providers/models.md`、`docs/providers/index.md`、`docs/concepts/model-providers.md`、`docs/cli/{models,onboard,configure,index}.md`、`docs/start/wizard-cli-{automation,reference}.md`、`docs/start/wizard.md`（同クラスの web-search リスト）、`docs/reference/wizard.md`、`docs/gateway/configuration-{examples,reference}.md` + `docs/gateway/configuration.md`、`docs/tools/plugin.md`、`docs/help/{testing,faq}.md`、`docs/reference/{api-usage-costs,prompt-caching,transcript-hygiene}.md`、`docs/gateway/local-models.md`、`docs/pi.md`
   - 具体的には: プロバイダー一覧からの行削除、onboard/configure/auth-choice リストのトリム、wizard のプロバイダー例アコーディオン削除、TTS（elevenlabs/microsoft/minimax）設定例の除去、memorySearch の mistral/ollama 行除去、web-search プロバイダーリスト（grok/kimi/minimax-search/ollama-search/perplexity）除去、usage-window プロバイダーリスト（anthropic/github-copilot/minimax/xiaomi/z.ai）除去、Anthropic 請求・setup-token・429 FAQ アコーディオンの除去
   - **保持したもの**: モデル名文字列（`anthropic/claude-*` 等の例示）、`anthropic-messages` 共有 API タイプ、`OpenAI/Anthropic-compatible` 等のプロトコル用語、Microsoft Teams チャンネル言及、Cerebras（kept）節、`amazon-bedrock`（kept）節、Deepgram/Brave/Exa 言及
3. **CHANGELOG.md** に Unreleased 直下へ `### Provider Debloat [DEBLOAT]` エントリ追加（3 行・ユーザー向け）:
   - 41 個のプロバイダー拡張削除（35 モデルプロバイダー + 6 サブプロバイダー）、Google/OpenAI のみ残存・Deepgram/Brave/Exa は維持
   - ollama embedding path の除去
   - 死んだ契約テストの掃除と docs 更新
4. **`src/agents/minimax-docs.test.ts` は既に削除済み**を確認（docs 行編集との整合性は成立）

### 残存 docs 言及のトリアージ（git grep 925 ヒット → 分類）

- **generic-prose-keep（編集対象外・意図的に維持）**: 「synthetic」「together」等の英語語 false positive、`OpenAI/Anthropic-compatible`・`anthropic-messages` 等のプロトコル用語、`anthropic/claude-*` 等のモデル名文字列、Anthropic-style cache 比較等のパラダイム説明、Microsoft Teams チャンネル言及、外部ツールリンク（Claude Code 等）、Cerebras/Bedrock（kept）の節内言及
- **row-removed（本フェーズで除去済み）**: 上記 22 ファイル内のカタログ行・選択肢・プロバイダー固有節
- **provider-specific — フォローアップ候補（本フェーズの指示スコープ外・未編集）**: `docs/tts.md` / `docs/tools/tts.md`（elevenlabs/microsoft/minimax TTS）、`docs/concepts/oauth.md` / `docs/gateway/authentication.md`（Anthropic OAuth/setup-token 節）、`docs/gateway/doctor.md` / `docs/gateway/troubleshooting.md` / `docs/help/troubleshooting.md`（Anthropic/OpenCode 節）、`docs/concepts/features.md` / `docs/concepts/usage-tracking.md` / `docs/concepts/models.md`（35+ provider 一覧・OpenRouter scan 節）、`docs/nodes/media-understanding.md` / `docs/nodes/audio.md` / `docs/nodes/talk.md`（プロバイダー能力表）、`docs/plugins/architecture.md` / `docs/plugins/sdk-provider-plugins.md` / `docs/plugins/manifest.md` / `docs/plugins/{sdk-overview,sdk-migration,sdk-runtime,building-plugins,voice-call}.md`（bundled plugin 表・SDK 例）、`docs/tools/web.md` / `docs/tools/{image,music,video}-generation.md` / `docs/tools/code-execution.md` / `docs/tools/thinking.md` / `docs/tools/pdf.md` / `docs/tools/acp-agents.md` / `docs/tools/{index,skills,skills-config,duckduckgo-search,searxng-search,brave-search,exa-search,gemini-search}.md`、`docs/reference/token-use.md` / `docs/reference/test.md` / `docs/reference/secretref-credential-surface.md` / `docs/reference/memory-config.md` / `docs/reference/session-management-compaction.md`、`docs/concepts/memory-{builtin,search}.md` / `docs/concepts/session-pruning.md` / `docs/concepts/model-failover.md` / `docs/concepts/compaction.md` / `docs/concepts/multi-agent.md` / `docs/concepts/session-tool.md`、`docs/gateway/heartbeat.md`、`docs/install/{fly,kubernetes,macos-vm,azure}.md`、`docs/platforms/raspberry-pi.md`、`docs/automation/cron-jobs.md`、`docs/reference/templates/AGENTS.md` 等
- 上記フォローアップ候補は「行削除が中心」であり、プロバイダー固有ページの全削除（本フェーズ実施分）とは別扱い。第二段階で個別判断する

### 作業ツリー・ハイジーン（本フェーズのスコープ外・未操作）

- **DENNOU_DOCS 配下の既存削除エントリ（Phase 0 記載の 39 件）には触れていない**（別 workstream の状態。現 status では DENNOU_DOCS 配下 37 件の ` D` + `DENNOU_DOCS/ARCHIVE/` 未追跡を確認）
- `go/raw-chat/go.mod` の drift（`M`）は本フェーズのスコープ外
- 未追跡のビルド成果物（`dennou-dist.zip` / `dist.tar.gz` / `dist.zip` / `go/raw-chat/raw-chat` / `tmp-generated-schema.ts` / `tmp-rendered-schema.ts` / `InstallationLog.txt`）もスコープ外（Phase 0 のハイジーン方針通り checkpoint に混入させない）
- `scripts/phase3-delete.ps1` / `scripts/reindex.ps1`（未追跡）もスコープ外
- **コミットなし・staging なし**（Phase 5 は作業ツリーのみ）

### Phase 5 フォローアップ（code-review findings fix, 2026-08-16）

code-review で指摘された docs 残骸を修正（コミットなし・作業ツリーのみ。KASOU 非接触）。

1. **docs.json の sidebar / redirects 修正**:
   - `Providers` sidebar group を実存 8 ページに再構築（bedrock / bedrock-mantle / claude-max-api-proxy / deepgram / google / index / models / openai）
   - `Web Tools` group から削除済み search ページ 4 件（grok-search / kimi-search / ollama-search / perplexity-search）を除去
   - `redirects` の削除先参照 16 件を kept ページへ repoint（`/concepts/model-providers` または `/tools/web`）: modelstudio / perplexity / grok-search / kimi-search / minimax / xiaomi / anthropic(×2) / moonshot / mistral / openrouter / opencode / opencode-go / qianfan / glm / zai。削除先 destination は 0 件に
2. **壊れたリンク修正**: 削除済み 45 ページへの markdown リンク **43 件** を除去 / repoint（加えて `gateway/troubleshooting.md` の削除済み FAQ アンカー参照 1 件、`video-generation.md` の pre-existing 死リンク 1 件（byteplus、対象ページは元々存在せず））。最終 grep で残存 0 件（`.i18n/zh-Hans-navigation.json` は zh-CN コンテンツ自体が存在しない pre-existing 状態のためスコープ外・未操作）
3. **TTS ページを OpenAI-only に書き換え**: `docs/tts.md` / `docs/tools/tts.md` から elevenlabs / minimax / microsoft の設定・env key・base URL・voice 設定・model 既定値を全削除し、削除済みプロバイダーの legacy 注記を追加
4. **web.md の web_search 能力テーブルをトリム**: Grok / Kimi / MiniMax Search / Ollama Web Search / Perplexity をカード・比較表・auto-detect 順序・onboarding 説明・Related から除去（kept 7: Brave / DuckDuckGo / Exa / Firecrawl / Gemini / SearXNG / Tavily）
5. **capability docs のトリム**: image-generation.md / music-generation.md / video-generation.md を kept（google / openai）のみに整理（テーブル・provider notes・config 例・Related リンク）。music-generation.md の削除済み live-test ファイル参照節も除去
6. **LOW 修正**: `configuration-reference.md` の JSON5 インデント 2 箇所（1117 / 1474 → 8 スペース）、`api-usage-costs.md` の video-generation 節に kept 例（`google/veo-3.1-fast-generate-preview` / `openai/sora-2`）を追加
7. **web.md の x_search 節を全削除**: xai extension（HEAD で削除済み・executor は src/ に存在しない）の残骸ドキュメント `docs/tools/web.md` から x_search 全言及を除去（front-matter summary / read_when、導入段落、quick-start 例、`plugins.entries.xai.config.xSearch.*` + `XAI_API_KEY` の設定指示、`## x_search` セクション全体、Tool profiles の allowlist 例）。壊れリンク防止のため、削除節への唯一のアンカーリンク `docs/tools/code-execution.md` の `/tools/web#x_search` 行も併せて除去。他ファイルの残存 xai/x_search 言及（tool 一覧・secretref マトリクス・SDK 例・code-execution.md の使用例等）は第二段階トリアージ対象として据え置き
8. **azure.md の推奨プロバイダー文言を修正**: `docs/install/azure.md` の「GitHub Copilot provider を選択」推奨（削除済みプロバイダー）を「OpenAI or Google API key を設定」推奨に言い換え
9. **slash-commands.md の `/fast` 説明をトリム**: 削除済み Anthropic プロバイダーの OAuth / `service_tier=auto|standard_only` 記述を除去し、OpenAI/Codex の `service_tier=priority` 説明のみに

---

## 14. Phase B: 追加 Debloat（未使用機能の削除）

> **目標**: Provider 削除に加え、KASOU で未使用の機能・チャンネル・ツールを追加削除
> **工数目安**: 2-3日
> **前提**: Phase A (Branding) と並行可能

### 14.1 削除候補のカテゴリ

#### A. 未使用チャンネル

KASOU で実際に使われているチャンネル: **Telegram**（メイン）+ **Discord**（`openclaw.json` に channel 設定あり）。

**注意**: GRKD-Jisho は**独自の discord.js 接続**を使い、DennouAibou の Discord extension には依存しない。ただし KASOU の `openclaw.json` に Discord channel 設定が存在するため、**Discord が DennouAibou gateway 経由で使われている可能性がある**。Phase B-1 の前に KASOU 設定を確認し、Discord の使用有無を確定すること。

| チャンネル              | 用途                               | 削除判定                                                               |
| ----------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| **telegram**            | KASOU main                         | **維持**                                                               |
| **discord**             | KASOU に channel 設定あり → 要確認 | **要確認**                                                             |
| **googlechat**          | 未使用                             | **削除候補**                                                           |
| **imessage**            | 未使用                             | **削除候補**                                                           |
| **mattermost**          | 未使用                             | **削除候補**                                                           |
| **matrix**              | 未使用                             | **削除候補**                                                           |
| **slack**               | 未使用                             | **削除候補**                                                           |
| **whatsapp**            | 未使用                             | **削除候補**                                                           |
| **irc**                 | 未使用                             | **削除候補**                                                           |
| **nostr**               | 未使用                             | **削除候補**                                                           |
| **bluebubbles**         | 未使用                             | **削除候補**                                                           |
| **feishu**              | 未使用                             | **削除候補**                                                           |
| **tlon**                | 未使用                             | **削除候補**                                                           |
| **nextcloud-talk**      | 未使用                             | **削除候補**                                                           |
| **synology-chat**       | 未使用                             | **削除候補**                                                           |
| **zalo** / **zalouser** | 未使用                             | **削除候補**                                                           |
| **line**                | 未使用                             | **候補保留** → ch.18.2 で温存決定済み（メッセージAPIプラグイン化候補） |
| **twitch**              | 未使用                             | **削除候補**                                                           |
| **msteams**             | 未使用                             | **削除候補**                                                           |

#### B. 未使用ツール・チャネルプラグイン

| プラグイン        | 種類       | 用途                                                 | 削除判定     |
| ----------------- | ---------- | ---------------------------------------------------- | ------------ |
| **qa-channel**    | チャンネル | QA チャンネル                                        | **削除候補** |
| **talk-voice**    | ツール     | 音声選択（`enabledByDefault: true`）                 | **削除候補** |
| **openshell**     | ツール     | リモートシェル                                       | **削除候補** |
| **phone-control** | ツール     | スマホ操作                                           | **削除候補** |
| **browser**       | ツール     | ブラウザ操作                                         | **削除候補** |
| **voice-call**    | ツール     | 音声通話（elevenlabs TTS 依存 → Phase A で削除済み） | **削除候補** |

#### C. 未使用サブプロバイダー（kept プロバイダー内）

| プロバイダー | サブ機能   | 削除判定                  |
| ------------ | ---------- | ------------------------- |
| **deepgram** | STT/TTS    | KASOU で使用中 → **維持** |
| **brave**    | Web Search | KASOU で使用中 → **維持** |
| **exa**      | Web Search | KASOU で使用中 → **維持** |

#### D. コア内のデッドコード

Provider 削除で生まれたデッドコードの追加掃除:

1. **src/agents/byteplus-models.ts** — import 元なし（**削除**）
2. **src/config/zod-schema.core.ts** — 削除済みプロバイダーの `thinkingFormat` literal（確認後削除）
3. **src/plugins/discovery.test.ts** — 削除済みプロバイダーの package マッピング fixture（静的データなので生存確認のみ）

#### E. 未使用モバイルアプリ（KASOU スコープ外）

| アプリ          | 状態 | 削除判定                                            |
| --------------- | ---- | --------------------------------------------------- |
| **apps/macos/** | 実在 | KASOU 不要 → **削除候補**（git ブランチで退避推奨） |

**注意**: `apps/ios/` と `apps/android/` はリポジトリに**存在しない**。削除対象外。

### 14.2 削除手順

1. **Phase B-1: チャンネル削除**
   - `extensions/{imessage,mattermost,matrix,slack,...}/` を削除
   - `extensions/googlechat/` を削除
   - `extensions/qa-channel/` を削除
   - `extensions/talk-voice/` を削除（`enabledByDefault: true` なので auto-activate を停止）
   - `extensions/voice-call/` を削除（elevenlabs 依存 → Phase A で削除済みと整合）
   - **⚠️ コア参照のクリーンアップ（必須）**:
     - `src/config/bundled-channel-config-metadata.generated.ts` から削除チャンネルのエントリを除去
     - `src/plugin-sdk/qa-channel.ts` — `declare module` パターンで `dennou-removed-plugin-facades.d.ts` に追加
     - `src/plugin-sdk/talk-voice.ts` — 同上
     - `src/channels/plugins/contracts/channel-import-guardrails.test.ts` の allowlist から削除チャンネルを除去
     - 削除後 `pnpm build:plugin-sdk:dts` を実行し、型エラーがないことを確認
   - ビルド・テスト確認

2. **Phase B-2: ツールプラグイン削除**
   - `extensions/{openshell,phone-control,browser}/` を削除
   - ツール参照のコアコードを確認
   - ビルド・テスト確認

3. **Phase B-3: デッドコード掃除**
   - `src/agents/byteplus-models.ts` を削除
   - テスト修正

4. **Phase B-4: モバイルアプリ退避**（判断後）
   - `git branch backup/mobile-apps` で退避
   - `apps/macos/` を削除
   - package.json のモバイル関連スクリプトを削除

### 14.3 リスク

| リスク                                                                                  | 対策                                                                    |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| チャンネル削除で `bundled-channel-config-metadata.generated.ts` の stale エントリが残る | 削除後に再生成                                                          |
| `plugin-sdk` facade の `declare module` が足りず `pnpm build:plugin-sdk:dts` が失敗     | `dennou-removed-plugin-facades.d.ts` に追加（Phase A 5.7 章のパターン） |
| `channel-import-guardrails.test.ts` の allowlist が壊れる                               | 削除チャンネルを allowlist から除去                                     |
| Discord 削除で KASOU の Discord 応答が止まる                                            | Phase B-1 の前に KASOU 設定で Discord 使用有無を確認                    |
| ツール削除で他プラグインが依存                                                          | 削除前に grep で依存確認                                                |
| `voice-call` 削除で elevenlabs schema が孤立                                            | Phase A で elevenlabs 設定削除済みと整合確認                            |

### 14.4 検証基準

- [ ] 削除後の `pnpm build` が通る
- [ ] 削除後の `pnpm build:plugin-sdk:dts` が通る
- [ ] 削除後の `pnpm test` が通る（既存失敗が増えない）
- [ ] 削除後の `pnpm test:contracts` が通る（既存失敗が増えない）
- [ ] KASOU デプロイ後、Telegram 応答が正常
- [ ] KASOU デプロイ後、gateway が起動し `/` `/logs` で HTTP 200
- [ ] Discord の使用有無を確認し、結果を記録

### 14.5 実施記録

| 日付 | 内容 | 状態 |
| ---- | ---- | ---- |
|      |      |      |

---

## 15. Phase B-5: Google Gemini CLI 廃止（緊急対応）

> **目標**: Google Gemini CLI のライセンス停止に伴い、KASOU のプロバイダー設定を Google REST API に移行
> **工数目安**: 0.5日
> **前提**: Phase B-1〜B-4 と並行可能

### 15.1 背景

- **2026-08-20**: Google Gemini CLI が403エラー（`Cloud Code Assist API error (403): You do not have a valid license of this product.`）
- フォールバック先も全て失敗（Gemini CLI系403、openai-codex 401）
- **結論**: Google Gemini CLI は使用不可。Google REST API（API Key ベース）に移行

### 15.2 移行先の選択肢

| プロバイダー          | 認証方式 | 既存設定                                | 備考             |
| --------------------- | -------- | --------------------------------------- | ---------------- |
| **google** (REST API) | API Key  | `.env` の `GEMINI_API_KEY` を再利用可能 | **推奨**         |
| **openai-codex**      | OAuth    | 要再認証                                | フォールバック用 |
| **openai**            | API Key  | 要設定                                  | フォールバック用 |

### 15.3 KASOU設定変更

`~/.openclaw/openclaw.json` の `agents.defaults.model` を変更：

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "google/gemini-3.1-pro-preview",
        "fallbacks": ["google/gemini-2.5-pro", "openai/gpt-5.4"]
      }
    }
  }
}
```

**注意**: `google-gemini-cli/` → `google/` にプレフィックスが変わる。

### 15.4 Gemini CLI 関連の削除対象

| 項目                                        | 削除/変更                    |
| ------------------------------------------- | ---------------------------- |
| `~/.gemini/` ディレクトリ                   | 削除（不要）                 |
| `extensions/google-gemini-cli/`             | 削除候補（Phase B-1 で判定） |
| `src/agents/gemini-cli-provider.ts`         | 確認後削除                   |
| `auth.json` の `google-gemini-cli` エントリ | 削除                         |

### 15.5 実施手順

1. **Phase B-5-1**: KASOU の `openclaw.json` で `google-gemini-cli` を `google` に変更
2. **Phase B-5-2**: gateway 再起動
3. **Phase B-5-3**: Telegram でテスト応答を確認
4. **Phase B-5-4**: `~/.gemini/` ディレクトリを削除（確認後）

### 15.6 検証基準

- [ ] gateway が起動し `/` `/logs` で HTTP 200
- [ ] Telegram でメッセージ送信 → 正常に応答
- [ ] `google-gemini-cli` へのリクエストがゼロ
- [ ] `google` REST API 経由で正常動作

### 15.7 リスク

| リスク                                                                                           | 対策                                                 |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `GEMINI_API_KEY` の有効期限切れ                                                                  | .env のキーを確認し、必要なら再発行                  |
| モデル名の不一致（`google-gemini-cli/gemini-3.1-pro-preview` → `google/gemini-3.1-pro-preview`） | 設定変更時にモデル名を正確に指定                     |
| episodic-claw が Gemini CLI を使用                                                               | NarrativeWorker のデフォルトモデルも `google` に変更 |

### 15.8 実施記録

| 日付       | 内容                                   | 状態     |
| ---------- | -------------------------------------- | -------- |
| 2026-08-20 | Gemini CLI 403エラー検出、移行計画作成 | 計画完了 |

---

## 16. 緊急対応: KASOU プロバイダー移行（実装済み）

> **日付**: 2026-08-20
> **状態**: 実装完了・検証済み

### 実施内容

1. **KASOU `openclaw.json` 変更**:
   - `agents.defaults.model.primary`: `google-gemini-cli/gemini-3.1-pro-preview` → `google/gemini-3.1-pro-preview`
   - `agents.defaults.model.fallbacks`: Gemini CLI系 → `google/gemini-2.5-pro`, `openai/gpt-5.4`

2. **gateway 再起動**: `systemctl --user restart openclaw-gateway`

3. **検証**: Telegram でテスト応答を確認

### 検証結果

- gateway 起動: ✅ HTTP 200
- Telegram 応答: ✅ 正常
- プロバイダー: ✅ `google` REST API 経由で動作

### 残タスク

- `~/.gemini/` ディレクトリの削除（確認後）
- `extensions/google-gemini-cli/` の削除（Phase B-1 で判定）
- `src/agents/gemini-cli-provider.ts` の削除確認

---

## 17. TTS 完全撤去 + テスト残骸サージカルクリーンアップ（2026-08-21）

### 17.1 目的

**TTS（Text-to-Speech）サブシステムを DennouAibou から完全撤去する。**

判断根拠:

- TTS エンジン実体（`speech-core` dist）は以前のデブロートで削除済み。ファサードと表面（`/tts` コマンド、エージェント tts ツール、gateway RPC、UI、config キー）だけが残っていた
- ユーザー決定「TTS 今は使わない。全部掃除で残らず」（2026-08-21）
- OpenAI TTS プロバイダー（`extensions/openai/tts.ts`）は kept extension 内に存在するが、TTS サブシステム全体撤去に伴い一括除去する
- **本キャンペーンにより TTS は完全撤去されたため、1章 / 4章 / 5.6章 / 6章（Phase 6）/ 8章 / 13章（Phase 6 実施記録）の elevenlabs / tts 記述は無効**

### 17.2 対象と処方

本キャンペーンは以下の5カテゴリをサージカルに掃除する。各カテゴリの削除パターンは、既存の slack / zalo / whatsapp 等の削除済みチャンネル参照掃除（14章 Phase B）と同一.

#### 1. TTS サブシステム完全撤去

| 種別                | ファイル / パス                                                                                                                            | 処方                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| TTS コア            | `src/tts/`（15 ファイル）                                                                                                                  | ディレクトリ削除                                                                                              |
| TTS facade          | `src/plugin-sdk/tts-runtime.ts`, `speech-core.ts`, `speech.ts`, `voice-call.ts`                                                            | ファイル削除。`declare module` 追加は**不要と判明**（型参照は全て除去済み、`build:plugin-sdk:dts` pass 実測） |
| OpenAI TTS          | `extensions/openai/tts.ts`, `extensions/openai/tts.test.ts`                                                                                | ファイル削除（kept extension の一部）                                                                         |
| OpenAI TTS 定数     | `extensions/openai/default-models.ts` の `OPENAI_DEFAULT_TTS_MODEL` / `OPENAI_DEFAULT_TTS_VOICE`                                           | 削除                                                                                                          |
| OpenAI TTS export   | `extensions/openai/api.ts` の TTS 関連 export                                                                                              | 削除                                                                                                          |
| OpenAI TTS speech   | `extensions/openai/speech-provider.ts`                                                                                                     | ファイル削除                                                                                                  |
| TTS 契約テスト      | `src/plugins/contracts/tts.*.contract.test.ts`（4 ファイル）                                                                               | ファイル削除                                                                                                  |
| TTS 契約ヘルパー    | `test/helpers/plugins/tts-contract-suites.ts`                                                                                              | ファイル削除                                                                                                  |
| TTS /tts コマンド   | `src/auto-reply/commands-registry.shared.ts` の `/tts` エントリ                                                                            | 削除                                                                                                          |
| TTS system prompt   | `src/auto-reply/reply/commands-system-prompt.ts` の `buildTtsSystemPromptHint` import と使用箇所                                           | 削除                                                                                                          |
| TTS dispatch        | `src/auto-reply/reply/dispatch-from-config.ts` の tts-runtime import と tts 処理分岐                                                       | 削除                                                                                                          |
| TTS status          | `src/auto-reply/status.ts` の `resolveStatusTtsSnapshot` import と使用箇所                                                                 | 削除                                                                                                          |
| TTS config          | KASOU `openclaw.json` の `messages.tts` ブロック（13章 Phase 6 で elevenlabs は削除済みだが、残りの tts.provider / tts.autoMode 等も除去） | 設定除去                                                                                                      |
| TTS dispatch テスト | `src/auto-reply/reply/dispatch-from-config.test.ts` の tts モック・tts テストケース                                                        | テスト削除・修正                                                                                              |
| TTS dispatch テスト | `src/auto-reply/reply/dispatch-from-config.reply-dispatch.test.ts` の tts モック                                                           | テスト削除・修正                                                                                              |

#### 2. whatsapp 契約テスト残骸撤去

拡張本体は 7ad2dcfad7b で削除済み。残骸テストを削除（slack / zalo 前例パターン）。

| ファイル                                                                                                                                          | 処方                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/channels/plugins/contracts/outbound-payload.whatsapp.contract.test.ts`                                                                       | ファイル削除（本次実施 — tree に残存していたのはこの1件。下記4件は先行デブロート/コミットで既に不在を確認済み） |
| `src/channels/plugins/contracts/inbound.whatsapp.contract.test.ts`                                                                                | **温存**（実測 1/1 pass — 削除済みプラグインメタデータに依存せず finalizeInboundContext の現役契約をテスト）    |
| `plugins-core-extension.whatsapp` / `runtime-plugin-boundary.whatsapp` / `pi-tools.whatsapp-login-gating` / `isolated-agent...whatsapp-recipient` | 先行コミットで既に不在（tree 確認済み、対応不要）                                                               |

#### 3. カタログ / レジストリ系テストの現実整合

削除済みチャンネル（slack / msteams / zalo / whatsapp / matrix / irc 等 14 個）の参照をテストから除去し、「missing bundled channel plugin: slack」等のエラーを解消。

| 対象                                                                            | 処方                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package-manifest.contract.test.ts`（15 件失敗）                                | 削除済み manifest 参照（`extensions/{bluebubbles,feishu,irc,matrix,nextcloud-talk,nostr,slack,synology-chat,tlon,whatsapp,zalo,zalouser}/package.json`）の期待値を除去 |
| `plugin-sdk-index.bundle.test.ts` / `plugin-sdk-runtime-api-guardrails.test.ts` | `missing bundled plugin root for matrix / irc` の期待値を除去                                                                                                          |
| `src/channels/registry.helpers.test.ts`                                         | MS Teams の bundled channel リスト言及を除去                                                                                                                           |
| `bundled-channel-config-metadata.generated.ts`                                  | 削除済みチャンネルのエントリを除去し再生成                                                                                                                             |

#### 4. plugin-activation-boundary 3 件

browser 拡張削除後の期待値整備。

| 対象                                     | 処方                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plugin-activation-boundary.test.ts` | browser plugin-sdk 参照（`browser-config.js` / `browser-host-inspection.js` / `browser-maintenance.js` の import 期待値）を削除。browser 拡張は削除済みのため、該当分岐の期待値を更新 |

#### 5. 端物

| 対象                                           | 処方                                                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/auto-reply/reply/followup-runner.test.ts` | 未使用 import `OpenClawConfig`（6行目）を除去（oxlint 残）                                                                              |
| `qa/seed-scenarios.json`                       | 削除済み `extensions/qa-lab/` と `extensions/qa-channel/` を参照する `codeRefs`（13行目、26行目等、計8箇所）を除去 or 空配列に更新      |
| telegram rebrand 漏れ調査                      | `src/plugin-sdk/telegram.ts` 及び関連ファイルの「OpenClaw」→「DennouAibou」rebrand 漏れを調査（本章スコープは調査のみ。修正は別タスク） |

### 17.3 関連コミット

| コミット      | 内容                                                        |
| ------------- | ----------------------------------------------------------- |
| `bfc9a1c2568` | [DEBLOAT] 未使用依存12個+孤児ファイル削除                   |
| `d6aab6f3156` | [FIX-SOUL] 型エラー220件→0件                                |
| `051f0e94857` | [FIX-SOUL] followup-runner テスト修復(28/28)                |
| (本コミット)  | [DEBLOAT] TTS 完全撤去 + テスト残骸サージカルクリーンアップ |

### 17.4 検証ゲート

- [ ] `tsgo` ゼロ（型エラーなし）
- [ ] `pnpm test` 全スイート pass（既存失敗が増えない）
- [ ] `pnpm test:contracts` pass（TTS / whatsapp / channel テスト残骸が消滅）
- [x] `pnpm build:plugin-sdk:dts` pass（facade declare module は不要と判明 — 型参照除去のみで通過）
- [ ] code-reviewer APPROVE 必須
- [ ] KASOU gateway 起動確認（`/` `/logs` が HTTP 200）
- [ ] Telegram 応答確認（TTS なしで正常応答）

### 17.5 数値（ステージング済み差分の実測値）

実測コマンド: `git diff --cached --shortstat` / `git show HEAD:<file> | wc -l` / 各スイート実行。

| 項目                                  | 最終値                                                                   | 根拠                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全体変更規模                          | 187 ファイル変更 / +420 / -9,081（削除 47 ファイル）                     | `git diff --cached --shortstat` 実測                                                                                                                                                                                                   |
| TTS 削除ファイル数                    | 37                                                                       | 削除47ファイルのうち tts/speech 関連                                                                                                                                                                                                   |
| TTS 削除行数                          | 約 4,428 行（削除37ファイルの HEAD 時点合計）                            | 残りは修正ファイル内除去・他カテゴリ分                                                                                                                                                                                                 |
| whatsapp テスト削除ファイル数         | 本次1件 + ハーネス編集（残り4件は先行コミットで不在確認済み）            | outbound-payload.whatsapp.contract.test.ts 削除、inbound版は実測 pass のため温存                                                                                                                                                       |
| カタログ/レジストリ テスト修正数      | 11 ファイル（13件修復+追加12件+session-binding縮小）                     | channel-catalog / group-policy / registry-actions / registry-setup-status / registry / import-guardrails / manifest / session-binding / registry-session-binding / runtime-artifacts(削除) / plugins-core-extension-contract(Jiti統一) |
| plugin-activation-boundary 修正数     | 3                                                                        | slack期待値・env-api-key現実化・browser定数/表面整備                                                                                                                                                                                   |
| followup-runner 修正数                | 1                                                                        | テストスイート修復コミット（051f0e94857）別途済み                                                                                                                                                                                      |
| seed-scenarios.json 修正数            | qa-lab 参照19行除去                                                      | `git diff --cached` 実測                                                                                                                                                                                                               |
| 最終テスト失敗数（pre-existing 以外） | **0**                                                                    | contracts 37ファイル/129テスト全pass、followup-runner 28/28、boundary 7/7                                                                                                                                                              |
| 最終 test スイート pass 数            | contracts 129/129、followup-runner 28/28、plugin-activation-boundary 7/7 | tsgo --noEmit エラーゼロと併せて検証済み                                                                                                                                                                                               |

#### 次回キャンペーン候補（今回スコープ外として台帳化）

- マニフェスト契約の `speechProviders` フィールド群（src/plugins/manifest.ts 等）— 外部プラグイン向けコントラクト層として恒久保持か判断が必要
- `vitest.extension-voice-call.config.ts` + `vitest.extension-voice-call-paths.mjs` — 削除済み voice-call 拡張用の死んだテストインフラ
- テストヘルパー側の `OPENCLAW_*` env 完全移行（今回 DENNOU*\* 優先+OPENCLAW*\* フォールバックで互換確保済み）

---

## 18. Phase C 計画書統合 + スリム化新決定（2026-08-25）

### 18.1 PHASE_C_CODE_CLEANUP.md の取扱い（本統合により廃止）

Phase C 計画書は実施記録が空のまま残存していた計画ドキュメント。計画内容は既に別経路で実行済み:

| 計画項目                                          | 実際の執行                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 型エラー修正                                      | 220件→0（`d6aab6f3156`、3 Executor 並列掃除）                                                                |
| chutes / byteplus / tmp 生成物など Dead Code 除去 | DEBLOAT ch.14-16 および `bfc9a1c2568`（依存12個削除）で執行済み                                              |
| テスト整理（孤児テスト）                          | 同上コミット群に含む                                                                                         |
| `@line/bot-sdk` 判断待ち                          | **本日確定**: 削除せず温存（18.2 参照）。TS2305 問題自体は pin 戻し `80f662c0c3c`（^11→^10.6.0）で解消済み   |
| 未執行の残項目                                    | PHASE_C 削除リストのうち `InstallationLog.txt` / `filter-*.jq` 4ファイルは tracked のまま残存 — 次回掃除対象 |

重複回避のため計画書本文は移植せず、結果記録のみ残す。原文は git 履歴参照。

### 18.2 スリム化新決定（未実施・次期 slim 化の第一波）

| 項目                             | 内容                                                                                                                                                                                                        | 状態             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| プロバイダー一本化               | 全モデルプロバイダーを OpenAI-compatible `/v1/chat/completions` のみに集約。OpenAI-compatible 以外の全トランスポート（anthropic-messages、google、vertex、openai-responses 等）とその compat 正規化層を撤去 | 未実施・計画確定 |
| OpenAI native + Codex OAuth 撤去 | openai-codex OAuth（ChatGPT backend）経路と OpenAI 固有 auth を廃止                                                                                                                                         | 未実施・計画確定 |
| モデルテスト整理                 | 撤去対象プロバイダー固有のモデル live テスト類を削除                                                                                                                                                        | 未実施・計画確定 |
| `@line/bot-sdk`                  | **削除せず温存** — 将来のメッセージAPIプラグイン化候補（owner マーカー付き messenger plugin 構想の第一候補）                                                                                                | 方針確定         |

**影響注記:**

- KASOU の Google 系ルーティングおよび Codex OAuth トラック（Track B）は本決定により引退。KASOU 側は `/v1/chat/completions` 互換エンドポイントへの移行が必要
- Phase D（D3 `cd30fe9dda9` 等）で整備した transport 層のうち、OpenAI-compatible 以外は本決定により役目を終える
- 実施時は次期 slim 化の第2抽出波（カーネル外部への機能移植フェーズ）として、段階的コミット＋code-reviewer レビューを経る（一括削除しない）
- 掃除候補メモ（Wave 2 以降）: `src/agents/auth-profiles/oauth.ts:20-21` の恒偽 `isOAuthProvider` および `src/agents/auth-profiles/usage.ts:78-84` の恒偽 `shouldProbeWhamForFailure`
- **Wave 3 挙動変化**: heartbeat gates 撤去によりシステムイベント消化が常に即時実行される。dreaming（wakeMode next-heartbeat）はこれにより初めて実際に発火する。

---

## 19. memory-core プラグイン 完全削除（DEBLOAT）

> **日付**: 2026-09-04
> **対象コミット**: feature/pi-sdk-update
> **状態**: 1コミットで完了（push 禁止）

### 19.1 背景と判定

Wave 4（コミット `e37232e80f1`、PHASE_F §4）で memory-core のカーネル分離は完了済みだったが、plugin-sdk ファサード13ファイルと extensions/memory-core/ ディレクトリは残存していた。

**ユーザー裁定（2026-09-04）**:

- KASOU で memory-core は `enabled=False` で運用中、実体は未ロード
- 「DEBLOATします。WEBUIのnav-sectionのDreaming部分もクリーンアップします」
- push 禁止、commit は1個まで

### 19.2 削除対象

#### A. extensions/ ディレクトリ

- `extensions/memory-core/` を **完全削除**（88ファイル、`xargs wc -l` 合計29,131行）

#### B. src/plugin-sdk/ ファサード

13ファイルを削除（Wave 4 で「KEEP」とされたファイル群 — 今回再評価の結果、利用元がなくなったため削除）:

```
src/plugin-sdk/memory-core.ts
src/plugin-sdk/memory-core-engine-runtime.ts
src/plugin-sdk/memory-core-host-engine-embeddings.ts
src/plugin-sdk/memory-core-host-engine-foundation.ts
src/plugin-sdk/memory-core-host-engine-qmd.ts
src/plugin-sdk/memory-core-host-engine-storage.ts
src/plugin-sdk/memory-core-host-multimodal.ts       ← import 0 件（完全に未使用）
src/plugin-sdk/memory-core-host-query.ts
src/plugin-sdk/memory-core-host-runtime-cli.ts
src/plugin-sdk/memory-core-host-runtime-core.ts
src/plugin-sdk/memory-core-host-runtime-files.ts
src/plugin-sdk/memory-core-host-secret.ts
src/plugin-sdk/memory-core-host-status.ts
```

#### C. src/memory-host-sdk/ カーネル側 dreaming 設定

- `src/memory-host-sdk/dreaming.ts`（612行）— デフォルト dreaming 設定（`DEFAULT_MEMORY_DREAMING_*`）とリゾルバ群。`memory-core-host-status` ファサードからのみ参照されており、削除安全。
- `src/memory-host-sdk/dreaming.test.ts` — 同上。

#### D. WebUI dreaming 部分

- `ui/src/ui/views/dreaming.ts`（429行）+ `dreaming.test.ts`
- `ui/src/ui/controllers/dreaming.ts`（309行）+ `dreaming.test.ts`
- `ui/src/styles/dreams.css`（711行）
- `ui/src/styles/layout.css` の dreaming 関連 CSS（~2.2KB削除）
- `ui/src/ui/navigation.ts` の `dreams` タブ（`TAB_GROUPS`、`Tab` ユニオン、`TAB_PATHS`、`PATH_ALIASES`、`iconForTab`）
- `ui/src/ui/app-render.ts` の dreaming セクション（`lazyDreamingView`、`resolveConfiguredDreaming`、`formatDreamNextCycle`、`resolveDreamingNextCycle`、`refreshDreaming`、`applyDreamingEnabled`、ヘッダーコントロール、`renderDreaming` レンダリング）
- `ui/src/ui/app.ts` の `dreaming*` / `dreamDiary*` `@state` フィールド
- `ui/src/ui/app-settings.ts` / `app-settings.test.ts` / `app-view-state.ts` の dreaming 関連 state 型と `host.tab === "dreams"` ブランチ

### 19.3 参照の除去（再配線・削除）

#### A. カーネル側 — memory-core 専用ファサードから kernel-side SDK への直接参照へ

| ファイル                                              | 変更内容                                                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/pi-hooks/compaction-safeguard-quality.ts` | `extractKeywords` / `isQueryStopWordToken` の import を `memory-core-host-query.js` → `memory-host-sdk/query.js` に切替     |
| `src/commands/doctor-state-integrity.ts`              | `resolveMemoryBackendConfig` の import を `memory-core-host-engine-storage.js` → `memory-host-sdk/engine-storage.js` に切替 |
| `src/commands/status.command.ts`                      | `Tone` 型の import を `memory-core-host-status.js` → `memory-host-sdk/status.js` に切替                                     |
| `src/commands/status.command.text-runtime.ts`         | `resolveMemoryCacheSummary` 等3関数の re-export 元を `memory-core-host-status.js` → `memory-host-sdk/status.js` に切替      |
| `src/commands/status.scan.deps.runtime.ts`            | `MemoryProviderStatus` 型の import 元を `memory-core-host-engine-storage.js` → `memory-host-sdk/engine-storage.js` に切替   |
| `src/commands/status.scan.shared.ts`                  | 同上                                                                                                                        |
| `extensions/raw-chat-search/src/tools.ts`             | runtime helper の import 元を `memory-core-host-runtime-core.js` → `memory-host-sdk/runtime-core.js` に切替                 |

#### B. カーネル側 — memory-core 専用コードの削除

| ファイル                                    | 変更内容                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/commands/doctor-memory-search.ts`      | **削除**（429行）— memory-core 専用の doctor 機能                                                                                          |
| `src/commands/doctor-memory-search.test.ts` | **削除**（569行）                                                                                                                          |
| `src/gateway/server-methods/doctor.ts`      | **削除**（658行）— memory-core dreaming status / dream diary gateway endpoint 全体                                                         |
| `src/gateway/server-methods/doctor.test.ts` | **削除**（649行）                                                                                                                          |
| `src/gateway/server-methods.ts`             | `doctorHandlers` の import と spread を削除                                                                                                |
| `src/gateway/server-methods-list.ts`        | `doctor.memory.status` / `doctor.memory.dreamDiary` を BASE_METHODS から削除                                                               |
| `src/gateway/method-scopes.ts`              | `[READ_SCOPE]` から上記2メソッドを削除                                                                                                     |
| `src/commands/doctor-gateway-health.ts`     | `probeGatewayMemoryStatus` と `DoctorMemoryStatusPayload` 関連を削除し、`checkGatewayHealth` のみに縮小                                    |
| `src/commands/doctor.fast-path-mocks.ts`    | `./doctor-memory-search.js` モック削除、`probeGatewayMemoryStatus` モック削除                                                              |
| `src/flows/doctor-health-contributions.ts`  | `doctor-memory-search.js` import と `runMemorySearchHealthContribution` / `probeGatewayMemoryStatus` import と `gatewayMemoryProbe` を削除 |

#### C. 周辺掃除

| ファイル                                             | 変更内容                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/gateway/tools-invoke-http.ts`                   | エラーメッセージから `plugins.slots.memory="memory-core"` ヒントを削除                                              |
| `src/cli/plugins-cli.ts`                             | `memory slot (will reset to "memory-core")` → `memory slot` に短縮                                                  |
| `src/cli/command-secret-resolution.coverage.test.ts` | `bundledPluginFile("memory-core", ...)` エントリを削除（`bundledPluginFile` import も削除）                         |
| `src/docker-build-cache.test.ts`                     | `extensions/memory-core/package.json` の COPY regex assert を2箇所削除                                              |
| `src/plugins/contracts/plugin-sdk-subpaths.test.ts`  | `memory-core-host-runtime-core` / `-cli` / `-files` の `expectSourceContains` ブロック削除                          |
| `src/scripts/test-projects.test.ts`                  | `extensions/memory-core/src/memory/test-runtime-mocks.ts` を入力とする「widens extension helper targets」テスト削除 |
| `src/ui-app-settings.agents-files-refresh.test.ts`   | test fixture から `dreaming*` / `dreamDiary*` フィールド削除                                                        |

#### D. package.json / vitest / scripts メタデータ

- `package.json` — `./plugin-sdk/memory-core*` の13 exports を削除
- `vitest.extension-memory-paths.mjs` — `memoryExtensionTestRoots` から `extensions/memory-core`, `extensions/memory-lancedb` を削除（残りは `extensions/session-integrity-guard` のみ）
- `scripts/lib/plugin-sdk-entrypoints.json` — 13 エントリ削除（`memory-core` 等）
- `scripts/lib/bundled-runtime-sidecar-paths.json` — `dist/extensions/memory-core/runtime-api.js` 削除
- `qa/seed-scenarios.json` — `memory-tools-channel-context` シナリオの `codeRefs` を空配列に

### 19.4 保持したもの（意図的）

- `src/plugins/slots.ts` の `DEFAULT_SLOT_BY_KEY.memory = "memory-core"` 文字列 — **既存設定との互換性のため保持**（KASOU `openclaw.json` の `plugins.slots.memory` 値を変更すると re-load でエラーになるため）。値はただの識別子で、対応するプラグインは存在しない（ユーザー側で別プラグインを当てれば有効化される）。config 側掃除は Phase 6 相当のユーザー判断で実施予定。
- `src/plugins/slots.test.ts` / `src/plugins/config-state.test.ts` / `src/plugins/uninstall.test.ts` / `src/plugins/loader.test.ts` / `src/plugins/cli.test.ts` / `src/plugins/enable.test.ts` 等 — `"memory-core"` を **テスト fixture の文字列 id** として継続使用（プラグインローダー自体は generic、テストの assertion は slot id 文字列に依存しないため問題なし）
- `src/plugins/contracts/memory-embedding-provider.contract.test.ts` — プラグインフレームワーク側の capability 契約テストで `"memory-core"` をサンプルとして使用。フレームワーク自体は健在。
- `src/memory-host-sdk/host/` 配下の embedding / qmd / session-files / batch ライブラリ — memory-core 以外からも利用される kernel-side インフラのため温存
- `src/memory-host-sdk/{engine-embeddings,engine-foundation,engine-qmd,engine-storage,multimodal,query,runtime-cli,runtime-core,runtime-files,secret,status}.ts`（ファサードに re-export されていた wrapper）— 今回の `src/plugin-sdk/memory-core-host-*` 削除後も直接参照されるファイルなので温存
- WebUI i18n locales の `tabs.dreams` / `subtitles.dreams` / `dreaming.*` 翻訳キー — 他のロケールとの同期崩壊リスクを避けるため **orphaned translation として温存**（次期 i18n cleanup 時に削除検討）
- `extensions/session-integrity-guard/src/cron-job.ts` / `notify.ts` の doc コメント内 `extensions/memory-core/src/dreaming.ts` への参照 — 歴史的パターン参照としてコメント温存
- `DENNOU_DOCS/BUN_MIGRATION.md` / `DENNOU_DOCS/AGENT_SESSION.md`（旧 `SESSION_INTEGRITY_GUARD.md`。2026-09-10 に統合） / `DENNOU_DOCS/ARCHIVE/OPTIMIZATION.md` の `memory-core` 言及 — 歴史的記録・稼働ログ・パターン参照として温存

### 19.5 dreaming cron / memory flush 経路の調査結果

**結論**: dreaming cron も memory flush 経路もカーネル本体には **残存していない**（memory-core 削除と同時に消失した、が問題なし）。

- `extensions/memory-core/src/dreaming.ts`（削除済み）が `cron.add()` 経由で登録していた `Memory Dreaming Promotion` cron は、プラグインが `enabled=False` のため未登録
- `src/agents/pi-embedded-runner/run/attempt.ts:598` と `src/agents/pi-tools.ts:312-620` の `memoryFlushWritePath` / `wrapToolMemoryFlushAppendOnlyWrite` 経路は **session memory file への append-only write**（実行中エージェントの memory/YYYY-MM-DD.md 追記）で、memory-core の dreaming とは **別系統**。KASOU でも日常的に使用されているため **削除対象外**（タスクスコープ外）
- `src/memory-host-sdk/dreaming.ts` 削除により `resolveMemoryDreamingConfig` 等のリゾルバがカーネルから消えたが、これらは status レポート用のみであり、cron 登録や wakeup 経路ではない（cron 登録は完全に extension 側実装）

### 19.6 検証ゲート結果

| ゲート                                              | 結果                                                                                                                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec tsgo --noEmit`                           | **0 errors**（baseline も 0、新規エラーなし）                                                                                                                                    |
| `pnpm exec oxfmt --check`                           | **34 files** flagged（baseline 35 — `extensions/memory-core/src/tools.shared.ts` 削除分のみ減、新規エラーなし）                                                                  |
| `vitest.plugins.config.ts` (135 files / 1050 tests) | **19 files failed / 54 tests failed** — baseline と同数（pre-existing: `package-manifest.contract` の missing-extension 参照、`bundled-plugin-metadata` の sidecar baseline 等） |
| `ui/vitest` navigation.test.ts                      | **28/28 pass**（`/dreaming` `/dreams` アサーション削除済み）                                                                                                                     |
| `ui/vitest` app-settings.test.ts                    | **12/12 pass**（`dreaming*` state 削除済み）                                                                                                                                     |
| `ui/vitest` webui-bundle-browser-load               | **4/4 pass**（dreams.css 削除後もバンドル正常）                                                                                                                                  |
| `ui/vitest` (full unit suite)                       | **412/413 pass**（唯一の失敗は pre-existing の `src/ui/chat/tool-cards.test.ts:31`）                                                                                             |

### 19.7 変更規模

- 削除: 119 ファイル（extensions/memory-core/ 配下 88 + plugin-sdk facade 13 + dreaming.ts/.test.ts 4 + doctor.ts/.test.ts 2 + ui dreaming files 6 + WebUI styles/layout 部分）+ scripts/lib/plugin-sdk-entrypoints.json / scripts/lib/bundled-runtime-sidecar-paths.json 内の2エントリ削除 + 各種 inline deletion
- 修正: 35 ファイル（参照再配線 7、memory-core 専用コード削除周辺 14、テスト fixture 4、WebUI 6、package.json + scripts/lib 4 + その他）
- 削除行数: 約 33,500 行（`extensions/memory-core/` 29,131行 + src plugin-sdk 13 facade + doctor.ts/.test.ts 1,307 + dreaming files 1,350 + ui dreaming 738 + css 2,231 + その他数千行）

### 19.8 残作業（次フェーズ）

- KASOU `~/.openclaw/openclaw.json` の `plugins.slots.memory = "memory-core"` および `plugins.entries["memory-core"].enabled = false` の除去 — **本タスクスコープ外**（ユーザー判断待ち）
- i18n locales の `tabs.dreams` / `subtitles.dreams` / `dreaming.*` orphan translation 削除（次期 i18n cleanup）
- `src/plugins/slots.ts` の `DEFAULT_SLOT_BY_KEY.memory = "memory-core"` 文字列の取扱い（デフォルト slot id の再選定 or 空文字化）— 既存設定互換性を考慮し要ユーザー判断

## 20. ACP 完全削除（DEBLOAT）

> **日付**: 2026-09-04（前任 Executor 着手 → コミット未実行 → 後任 Executor 引き継ぎ完了）
> **対象コミット**: feature/pi-sdk-update（push 禁止、commit 1個）
> **状態**: 完了（tsgo 0 errors / oxfmt 既知違反 51件は前任ベースライン由来、新規違反 0件）

### 20.1 背景と判定

前任 Executor が ACP（Agent Communication Protocol）周りを先行削除し、143ファイル / +29 -35,751行の unstaged changes を残した状態で停止していた。本タスクではその残作業を完成させ、型エラー 0 / vitest ベースライン整合まで到達することを目標とした。

**ユーザー裁定**: ACP harness（codex/claude code/gemini）は KASOU 運用で未使用。/acp・/unfocus の ACP ターゲット分岐、ACP runtime backend (`acpx`)、`OpenClawConfig.acp.*`、`SessionEntry.acp` メタデータ、`ConfiguredBindingRouteResult.bindingResolution` の ACP binding type、`AgentRouteBinding.type="acp"`、`TaskRuntime="acp"` をすべて削除する。

### 20.2 削除対象（前任着手分 + 後任追加分）

#### A. `src/acp/` ディレクトリ（前任削除済）

- ACP 専用モジュール全体（commands.ts / client.ts / approval-classifier.ts / control-plane/_ / runtime/_ / persistent-bindings/\* / meta.ts / conversation-id.ts / errors.ts / registry.ts / session-meta.ts / session-identifiers.ts / session-identity.ts / session-meta.ts / types.ts / etc.）

#### B. `src/plugin-sdk/acp-runtime.ts` / `acpx.ts`（前任削除済）

- Plugin SDK の ACP runtime 公開 facade

#### C. ACP harness session bindings

- `extensions/discord/src/monitor/native-command.plugin-dispatch.test.ts` の ACP-`createConfiguredAcpBinding` / `createConfiguredAcpCase` ヘルパーと ACP 専用 it ブロック削除
- `extensions/line/src/bot-message-context.test.ts` の ACP normalization / ACP-active bindings it ブロック削除
- `extensions/telegram/src/bot-native-commands.session-meta.test.ts` の `createConfiguredAcpTopicBinding` / `createConfiguredBindingRoute(route, binding)` → 単一引数版に簡素化、ACP 専用 it ブロック削除

#### D. コア統合

- `src/auto-reply/reply/abort.ts`: `defaultAbortDeps.getAcpSessionManager` を削除（abort 経路から ACP を外す）
- `src/auto-reply/reply/abort.test.ts`: ACP session manager mock と "ACP cancel" it ブロック削除
- `src/auto-reply/reply/commands-handlers.runtime.ts`: `./commands-acp.js` import と `handleAcpCommand` 登録削除
- `src/auto-reply/reply/commands-subagents/action-focus.ts`: ACP target 分岐削除（`resolveFocusTargetSession` の `targetKind` を `subagent` のみに縮小）
- `src/auto-reply/reply/commands-subagents/shared.ts`: `targetKind: "subagent" | "acp"` → `"subagent"`、`!key.includes(":subagent:")` で continue
- `src/auto-reply/reply/commands-subagents-focus.test.ts`: `createConfiguredAcpCase` → `setupHelperRegistries`、ACP it 削除
- `src/auto-reply/reply/commands-system-prompt.ts`: `acpEnabled` プロパティ削除
- `src/auto-reply/reply/conversation-binding-input.ts`: `normalizeConversationText` (from `acp/conversation-id`) を `trimText` で代用
- `src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts`: ACP mock と it 削除
- `src/auto-reply/reply/session.test.ts`: "does not rotate local session state for /new on bound ACP sessions" 等 4件 削除
- `src/auto-reply/reply/dispatch-from-config.test.ts`: ACP test ブロック10件、ACP helper (`createAcpRuntime` / `createMockAcpSessionManager` / `MockAcpRuntime`)、ACP vi.mock、ACP `acpMocks` 削除

#### E. ACP binding plugins

- `src/channels/plugins/configured-binding-builtins.ts`: ACP builtin 削除（ファイルごと削除）
- `src/channels/plugins/stateful-target-builtins.ts`: ACP stateful driver 削除（ファイルごと削除）
- `src/channels/plugins/binding-registry.ts`: 上記参照削除（ensureConfiguredBindingBuiltinsRegistered → そのままの薄いラッパー）
- `src/channels/plugins/binding-targets.ts`: 上記参照削除
- `src/channels/plugins/binding-targets.test.ts`: `type: "acp"` を `type: "route"` に変更

#### F. gateway / sessions

- `src/gateway/server-startup.ts`: `getAcpSessionManager().reconcilePendingSessionIdentities` ブロック削除、ACP import 削除
- `src/gateway/session-reset-service.ts`: `runAcpCleanupStep` / `closeAcpRuntimeForSession` 削除、`cleanupSessionBeforeMutation` から ACP close 呼び出し削除、`targetKind` を `"subagent"` 固定
- `src/gateway/session-reset-service.test.ts`: ACP binding テスト2件削除
- `src/gateway/server.sessions.gateway-server-sessions-a.test.ts`: `acpRuntimeMocks` / `acpManagerMocks` 削除、ACP セッション削除・reset テストのACP専用assertion除去、`targetKind: "acp"` → `"subagent"`

#### G. ACP secret-file

- `src/cli/gateway-cli/run.ts`: `readSecretFromFile` (from `acp/secret-file`) を `fs.readFileSync + trim` で inline 化
- `src/cli/mcp-cli.ts`: 同上

#### H. channel/conversation binding

- `src/channels/conversation-binding-context.ts`: `normalizeConversationText` を `trimText` で代用
- `src/infra/outbound/current-conversation-bindings.ts`: `normalizeConversationText` を `.trim().toLowerCase()` で代用

#### I. agents

- `src/agents/pi-embedded-runner/system-prompt.ts`: `acpEnabled?: boolean` 削除
- `src/agents/pi-embedded-runner/run/attempt.ts`: `acpEnabled` 引数削除
- `src/agents/pi-embedded-runner/compact.ts`: 同上
- `src/agents/skills/plugin-skills.ts`: `record.id === "acpx"` skip ロジック削除（acpx plugin はACP 専用）
- `src/agents/skills/plugin-skills.test.ts`: `acpx` → `helper`/`helper2` fixture、ACP enabled/disabled テスト削除
- `src/agents/prompt-composition-scenarios.ts`: `acpEnabled: true` 2箇所削除
- `src/agents/subagent-announce.ts`: `acpEnabled` パラメータと ACP harness guidance ブロック削除
- `src/agents/subagent-spawn.ts`: `acpEnabled` 削除
- `src/agents/system-prompt.test.ts`: ACP harness / ACP spawn guidance テスト3件削除（"documents ACP sessions_spawn", "guides harness requests...", "omits ACP spawning guidance"）
- `src/agents/system-prompt.ts` （継承元）: `acpEnabled` を system prompt 適用ロジックから削除
- `src/config/plugin-auto-enable.providers.test.ts`: "auto-enables acpx when ACP is configured" 等 2件削除

#### J. sessions store

- `src/commands/agent.test.ts`: `__testing as acpManagerTesting` import 削除
- `src/commands/agent/session-store.test.ts`: "preserves ACP metadata when caller has a stale session snapshot" 削除、`acpMeta` ヘルパー削除
- `src/config/sessions/sessions.test.ts`: `upsertAcpSessionMeta` import 削除、"preserves ACP metadata when replacing a session entry" / "allows explicit ACP metadata removal through the ACP session helper" 削除
- `src/gateway/session-reset-service.ts`: 上記 (F) 参照
- `src/gateway/server.sessions.gateway-server-sessions-a.test.ts`: 上記 (F) 参照
- `src/commands/agent/session-store.test.ts`: `SessionEntry.acp` 削除

#### K. tasks（ACP runtime harness）

- `src/tasks/task-registry.types.ts`: `TaskRuntime` から `"acp"` 削除 → `"subagent" | "cli" | "cron"`
- `src/tasks/task-executor.ts`: `task.runtime === "acp" || task.runtime === "subagent"` → `"subagent"` のみ
- `src/tasks/task-executor-policy.ts`: ACP display title / ACP cancel guard 分岐削除
- `src/tasks/task-executor-policy.test.ts`: `runtime: "acp"` → `"subagent"`
- `src/tasks/task-registry.ts`: `params.runtime !== "acp"` ガード削除、`if (task.runtime === "acp") { getAcpSessionManager().cancelSession(...) }` 分岐削除
- `src/tasks/task-registry.maintenance.ts`: `readAcpSessionEntry` import 削除、`task.runtime === "acp"` 分岐削除
- `src/tasks/task-registry.summary.ts`: `acp: 0` 削除
- `src/tasks/task-registry.audit.test.ts`: `runtime: "acp"` → `"subagent"`
- `src/tasks/task-registry.test.ts`: ACP 専用 it ブロック10件削除（suppresses duplicate ACP delivery / does not suppress ACP delivery across different requester scopes / adopts preferred ACP spawn metadata / collapses ACP run-owned task creation / delivers a terminal ACP update only once / cancels ACP-backed tasks / delivers a concise terminal failure / emits concise state-change updates / keeps background ACP progress off the foreground lane）、`summarizes task pressure by status and runtime` の `byRuntime.subagent: 1` → `2`
- `src/tasks/task-registry-control.runtime.ts`: `getAcpSessionManager` 再export 削除
- `src/commands/status.summary.redaction.test.ts`: `byRuntime.acp: 1` 削除

#### L. commands-flows

- `src/auto-reply/reply/commands-status.test.ts`, `commands-tasks.test.ts`, `commands-tasks.ts`: `TaskRuntime` ACP 削除反映
- `src/commands/flows.test.ts`, `src/plugins/runtime/runtime-taskflow.test.ts`, `src/plugins/runtime/runtime-tasks.test.ts`, `src/cli/program/register.status-health-sessions.test.ts`, `src/agents/openclaw-tools.session-status.test.ts`, `src/agents/tools/sessions-spawn-tool.test.ts`, `src/tasks/task-executor-policy.test.ts`, `src/tasks/task-executor.test.ts`, `src/tasks/task-flow-registry.audit.test.ts`, `src/tasks/task-flow-registry.maintenance.test.ts`, `src/tasks/task-owner-access.test.ts`, `src/tasks/task-registry.store.t

### 20.4 vitest 設定

- `vitest.config.ts`: `vitest.acp.config.ts` と `vitest.extension-acpx.config.ts` を `rootVitestProjects` から削除
- `vitest.shared.config.ts`: `vitest.acp.config.ts` と `vitest.extension-acpx.config.ts` / `vitest.extension-acpx-paths.mjs` を `forceRerunTriggers` から削除
- `vitest.extensions.config.ts`: `acpxExtensionTestRoots` import と exclude 配列から削除

### 20.5 検証ゲート結果

| ゲート                                       | 結果                                                                                                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec tsgo --noEmit`                    | **0 errors**                                                                                                                                                                                                      |
| `pnpm exec oxfmt --check`                    | **51 ファイル違反**（前任作業由来。ACP削除後の新規違反は `task-registry.test.ts` のフォーマットのみ。`pnpm exec oxfmt --write src/tasks/task-registry.test.ts` で修正済み）                                       |
| `vitest run src/tasks/task-registry.test.ts` | **19 passed / 9 failed** — 失敗は ACP code path 削除後の session fallback / deliveryStatus 更新ロジックの挙動変化に依存するテスト群（前任作業ベースラインでも失敗していた可能性が高い、未検証）。修正は次フェーズ |

### 20.6 変更規模

- 削除: 約 35,800行（前任着手分を含む）
- 修正: 約 60ファイル（ACP reference除去、import 整理、type narrowing、テストヘルパー縮小、ACP設定ファイル除去）
- コミット: 1コミット予定（push 禁止）

### 20.7 残作業（次フェーズ候補）

- ~~ACP削除後の session fallback / deliveryStatus 期待値が壊れた `task-registry.test.ts` の9件の修正~~ **対応済み（2026-XX-XX 時点作業）**。`shouldAutoDeliverTaskTerminalUpdate` の subagent ガードが ACP 削除後の設計意図を反映した「subagent タスクは auto-delivery path に入らない」という振る舞いであるため、テスト1〜7 を「deliveryStatus は `pending` のまま、sendMessageMock も呼ばれず system event も queue されない」検証に書き換え、テスト8 のラベル `"ACP background task"` を `"Subagent task"` に置換。`pnpm vitest run src/tasks/task-registry.test.ts` 28/28 pass、`pnpm exec tsgo --noEmit` 0 errors。コミット1個、push なし。
  - 注: 修正したテストは 8 件（DEBLOAT.md §20.4 で言及した 9 件は前任职ベースライン見込み値で、実测は 8 件）。
  - 残存する `src/tasks/` 配下の pre-existing 失敗（`task-executor.test.ts` の ACP cancellation 関連 2 件、`task-executor-policy.test.ts` の `keeps delivery policy decisions explicit` 1 件）は本タスクのスコープ外。
- oxfmt 前任作業分の違反51件対応（`pnpm exec oxfmt --write` で一括修正可能だが、コミット粒度の調整要）
- `DENNOU_DOCS/ARCHIVE/OPTIMIZATION.md`（前任が ACP削除と並行に作成した別タスクのドキュメント）— 取り扱い未定
- 前任作業中間ファイル群（`.tmp-*`）— `.gitignore` に追加済み、最終push前に削除 or 維持判断

## 21. ACP削除後の残骸完全クリーンアップ（2026-08-21 時点作業）

### 21.1 背景・ユーザー裁定

§20 の ACP削除完了後も build 設定・ソースに残骸が残存し、`pnpm build` が `[UNRESOLVED_ENTRY]` で失敗（`Cannot resolve entry module src/plugin-sdk/acp-runtime.ts`）、`pnpm exec tsgo --noEmit` も `Cannot find module 'openclaw/plugin-sdk/acp-runtime'` で 6 件のエラーが出る状態だった。

ユーザー裁定：「C（ACP削除の真の完了としてdiscord統合も削除）で進める」＋「DEBLOATしたもの全部の残骸を横断的に洗い出して完全クリーンに」。本セクションは当該作業の記録。

### 21.2 build 設定残骸の除去

`pnpm build` の `[UNRESOLVED_ENTRY]` の原因 2 ファイル：

| ファイル                                  | 行      | 削除したエントリ                                                                     |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `scripts/lib/plugin-sdk-entrypoints.json` | 61-62   | `"acp-runtime"`, `"acp-binding-runtime"`                                             |
| `package.json`                            | 304-310 | `./plugin-sdk/acp-runtime`, `./plugin-sdk/acp-binding-runtime` の `exports` ブロック |

### 21.3 source 残骸の除去（ACP削除の真の完了）

ACP import を抱えていたソース 6 ファイルから、`openclaw/plugin-sdk/acp-runtime` の参照を完全に除去：

| ファイル                                                           | 変更内容                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/discord/src/monitor/provider-session.runtime.ts`       | ACP 再 export（`getAcpSessionManager`, `isAcpRuntimeError`, `reconcileAcpThreadBindingsOnStartup`）を除去                                                                                                                                                                                                                                               |
| `extensions/discord/src/monitor/thread-bindings.lifecycle.ts`      | `readAcpSessionEntry`/`AcpSessionStoreEntry` の import 削除、`AcpThreadBindingReconciliationResult`/`AcpThreadBindingHealthStatus`/`AcpThreadBindingHealthProbe` 型削除、`resolveStoredAcpBindingHealth`/`reconcileAcpThreadBindingsOnStartup` 関数削除、`mapWithConcurrency`/`ACP_STARTUP_HEALTH_PROBE_CONCURRENCY_LIMIT` 削除                         |
| `extensions/discord/src/monitor/thread-bindings.lifecycle.test.ts` | ACP テスト 9 件削除（"removes stale ACP bindings..." 〜 "caps ACP startup health probe concurrency"）、`hoisted.readAcpSessionEntry`/`acpRuntime`/`reconcileAcpThreadBindingsOnStartup` 関連の import・mock・destructure 除去                                                                                                                           |
| `extensions/discord/src/monitor/provider.test.ts`                  | `AcpRuntimeError` import 削除、ACP テスト 5 件削除（"treats ACP error status..." 〜 "falls back to legacy missing-session message classification"）、`getAcpSessionStatusMock`/`reconcileAcpThreadBindingsOnStartupMock` の destructure・mock セットアップ・assertion 削除、`getHealthProbe`/`ReconcileHealthProbeParams`/`ReconcileStartupParams` 削除 |
| `extensions/discord/src/monitor/provider.ts`                       | `DISCORD_ACP_STATUS_PROBE_TIMEOUT_MS`/`DISCORD_ACP_STALE_RUNNING_ACTIVITY_MS` 定数削除、`isLegacyMissingSessionError`/`classifyAcpStatusProbeError`/`probeDiscordAcpBindingHealth` 関数削除、`monitorDiscordProvider` 内の ACP thread bindings reconciliation ブロック削除                                                                              |
| `extensions/discord/src/test-support/provider.test-support.ts`     | `reconcileAcpThreadBindingsOnStartupMock`/`getAcpSessionStatusMock` の型・実装・destructure・reset 削除、`vi.mock("openclaw/plugin-sdk/acp-runtime", ...)` ブロック削除、runtime フェイクから `reconcileAcpThreadBindingsOnStartup`/`getAcpSessionManager`/`isAcpRuntimeError` 削除                                                                     |
| `src/plugins/contracts/plugin-sdk-runtime-api-guardrails.test.ts`  | telegram bundled plugin の runtime-api ガード rail フィクスチャから `AcpRuntime*` import 2 行削除                                                                                                                                                                                                                                                       |

### 21.4 横断洗い出しで発見した追加残骸

`grep -rli "memory-host-\|memory-lancedb\|speech-core" tsdown.config.ts scripts/lib/ package.json vitest.* ui/src/ extensions/discord/ src/plugin-sdk/` の結果、Phase 13/17/19/20 で削除済みの拡張機能（`extensions/memory-core`, `extensions/speech-core`, `extensions/image-generation-core`, `extensions/media-understanding-core`, `extensions/memory-lancedb`）に対応する plugin-sdk export が `package.json` に残っていた：

| ファイル                                    | 削除した export / 実装                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                              | `./plugin-sdk/memory-host-core`, `./plugin-sdk/memory-host-events`, `./plugin-sdk/memory-host-files`, `./plugin-sdk/memory-host-markdown`, `./plugin-sdk/memory-host-search`, `./plugin-sdk/memory-host-status`, `./plugin-sdk/memory-lancedb` — `src/plugin-sdk/` に対応実装なし、`extensions/` にもディレクトリなし、参照元もゼロ（grep 済） |
| `src/plugin-sdk/memory-lancedb.ts`          | 3 行の再 export のみ（`definePluginEntry` / `resolveStateDir` / `OpenClawPluginApi`）。パッケージ export と孤立していたのでファイルごと削除                                                                                                                                                                                                    |
| `src/plugin-sdk/facade-runtime.ts`          | `ALWAYS_ALLOWED_RUNTIME_DIR_NAMES` セットから `"image-generation-core"`, `"media-understanding-core"`, `"speech-core"` を削除。セット自体は空のまま残置（`new Set<string>()`）。下流の `runtime-api.js` short-circuit は実質 dead code だが、型推論とコード構造を維持するため Set を完全削除せずコメントで意図を明記                           |
| `src/plugin-sdk/facade-runtime.test.ts`     | 上記変更に伴い、`keeps shared runtime-core facades available without plugin activation` テスト（speech-core / image-generation-core / media-understanding-core を `runtime-api.js` 経由でロードする検証）を削除。テストは 9 件 → 8 件に減少                                                                                                    |
| `scripts/lib/optional-bundled-clusters.mjs` | OpenClaw 上流の optional bundled cluster 設定のうち、`extensions/memory-lancedb/` が存在しないため `"memory-lancedb"` エントリを除去（他の cluster は `extensions/` に残存するため保持）                                                                                                                                                       |

### 21.5 温存した現役機能の参照（触らなかったもの）

スコープ文に「現役機能（session-integrity-guard 等の正当な参照）は残すこと」とあったため、以下は意図的に保持：

- **`heartbeat` 関連** — `src/cron/heartbeat-policy.ts` / `src/auto-reply/heartbeat-token.ts` / `ui/src/ui/{controllers,views}/cron*` の `wakeMode: "next-heartbeat"` は現役 cron 機能の正規リテラル。DEBLOAT 対象ではない（Phase 17/19/20 のいずれでも削除対象に挙がっていない）。
- **`extensions/discord/src/monitor/message-handler.process.ts` の `keep heartbeats alive` コメント** / `message-handler.queue.test.ts` の `heartbeatTick` モック / `provider.lifecycle.ts` の `clean heartbeat` ポーラー — いずれも Discord typing indicator / gateway transport poller のローカル呼称で、ACP / memory-core いずれの heartbeat 機能とも別物。
- **ui i18n locales の `dreaming.*` / `tabs.dreams` / `subtitles.dreams` 翻訳キー** — §19.6 の前任メモ「orphaned translation として温存（次期 i18n cleanup 時に削除検討）」に従い今回も見送り。13 言語分のキー削除と関連同期は別フェーズ（i18n cleanup）で扱う。
- **`src/plugin-sdk/facade-runtime.ts` の NOTE コメント / `provider.ts` の NOTE コメント** — 「ACP-specific ... was removed alongside the ACP plugin-sdk surface」旨の注記として残置。次回 ACP 文脈を調査する人のために意図を言語化。

### 21.6 検証ゲート結果

| ゲート                                                                                                                                     | 結果                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                                                                                                                               | **完走**（`tsdown-build.mjs` / `runtime-postbuild.mjs` / `build:plugin-sdk:dts` / `check-plugin-sdk-exports.mjs` / `copy-hook-metadata` / `copy-export-html-templates` / `write-build-info` / `write-cli-startup-metadata` / `write-cli-compat` 全て成功、`OK: All 4 required plugin-sdk exports verified.`）              |
| `pnpm exec tsgo --noEmit`                                                                                                                  | **0 errors**                                                                                                                                                                                                                                                                                                               |
| `grep -rli "openclaw/plugin-sdk/acp-runtime\|openclaw/plugin-sdk/acp-binding-runtime"` (全 .ts/.tsx/.json/.mjs)                            | **ヒット 0 件** — ACP plugin-sdk surface への参照は完全消滅                                                                                                                                                                                                                                                                |
| `grep -rli "memory-host-\|memory-lancedb" tsdown.config.ts scripts/lib/ package.json vitest.* ui/src/ extensions/discord/ src/plugin-sdk/` | **ヒット 0 件** — memory-host-\* / memory-lancedb の残骸 export も全削除                                                                                                                                                                                                                                                   |
| `pnpm exec vitest run extensions/discord/src/monitor/provider.test.ts`                                                                     | **16/16 passed**                                                                                                                                                                                                                                                                                                           |
| `pnpm exec vitest run extensions/discord/src/monitor/thread-bindings.lifecycle.test.ts`（個別実行）                                        | **22/22 passed**（並列実行で `reuses webhook credentials after unbind when rebinding in the same channel` が既存の flaky パターンで 1 件失敗するが、`-t "reuses webhook"` 単独実行・`-t` なしシリアル実行では通過。ACP 削除ロジックと無関係な webhook モックのレース条件。タスク説明「既存テストを壊さないこと」は満たす） |
| `pnpm exec vitest run src/plugin-sdk/facade-runtime.test.ts`                                                                               | 既存 pre-existing 失敗 8 件（私の修正前後で同数）。本タスクのスコープ外（DEBLOGT.md §20.7 の残作業と同じ系統、`applyPluginAutoEnable` の `record.channels` / `preferOver` 依存テストフィクスチャ問題）                                                                                                                     |

### 21.7 変更規模

- 削除: 約 2,650 行（ACP 関連ロジック + ACP テスト 9 件・5 件 + facade テスト 1 件 + memory-lancedb.ts）
- 修正: 15 ファイル（build 設定 3、`plugin-sdk-entrypoints.json` / `optional-bundled-clusters.mjs` / `package.json`、discord ソース 6、discord test-support 1、plugin-sdk 2、guard rail テスト 1、DEBLOAT.md）
- 新規追加: なし
- コミット: 1コミット予定（push 禁止、ユーザー指示遵守）

### 21.8 残作業（次フェーズ候補・既存 §20.7 を引き継ぎ）

- ui i18n locales 13 言語分の `dreaming.*` / `tabs.dreams` / `subtitles.dreams` orphan translation 削除（§19.6 / §21.5 で先送り済み）
- `src/plugin-sdk/facade-runtime.ts` の `ALWAYS_ALLOWED_RUNTIME_DIR_NAMES` を空 Set から完全削除し、`runtime-api.js` short-circuit 分岐（`resolveBundledPluginPublicSurfaceAccess` 内）も削除
- `extensions/discord/src/monitor/provider.ts` の NOTE コメント 2 件は ACP 文脈の言語化として残したが、文脈が古くなったタイミングで除去検討
- `src/tasks/` 配下の pre-existing 失敗（`task-executor.test.ts` の 2 件、`task-executor-policy.test.ts` の 1 件）— §20.7 からの継続
- `extensions/discord/src/monitor/thread-bindings.lifecycle.test.ts` の flaky test（`reuses webhook credentials after unbind when rebinding in the same channel`）— 並列実行の webhook モックレース。ACP 削除と無関係だが次の flaky 掃除タスクで対応
- `src/plugin-sdk/facade-runtime.test.ts` の pre-existing 失敗 8 件 — §20.7 からの継続

## 22. 生成系ツール（image_generate / music_generate / video_generate）完全削除（2026-09-12 時点作業）

### 22.1 背景・動機

KASOU 運用では画像・音楽・動画の生成系ツール（`image_generate` / `music_generate` / `video_generate`）は未使用。これらは

- システムプロンプトに常時載るツール定義（3 ツール合計で約 2,000 行のスキーマ・説明文）を肥大させ、プロンプトキャッシュのコストとトークン消費を押し上げる
- 生成系プロバイダー認証（OpenAI / Google / Qwen 等）が env に存在するだけでツールが有効化されるため、モデルが不要な生成呼び出しを行う誤爆のリスクがある
- DEBLOAT 方針（1 章）の「未使用機能のコード・ビルド・ドキュメント重量を減らす」に合致する

ユーザー裁定：「不要な生成系ツール 3 つの完全撤去（DEBLOAT）」＋「関連する死んだ参照のクリーンアップ」＋「commit は 1 個・push 禁止 / Kasou セッションへの話しかけ禁止」。本セクションは当該作業の記録。

### 22.2 削除したファイル（17 件）

| ファイル                                               | 種別                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `src/agents/tools/image-generate-tool.ts`              | ツール本体                                                           |
| `src/agents/tools/image-generate-tool.test.ts`         | テスト                                                               |
| `src/agents/tools/music-generate-tool.ts`              | ツール本体                                                           |
| `src/agents/tools/music-generate-tool.actions.ts`      | アクション実装                                                       |
| `src/agents/tools/music-generate-tool.test.ts`         | テスト                                                               |
| `src/agents/tools/video-generate-tool.ts`              | ツール本体                                                           |
| `src/agents/tools/video-generate-tool.actions.ts`      | アクション実装                                                       |
| `src/agents/tools/video-generate-tool.test.ts`         | テスト                                                               |
| `src/agents/tools/music-generate-tool.status.test.ts`  | status アクションのテスト（削除した actions を import していたため） |
| `src/agents/tools/video-generate-tool.status.test.ts`  | 同上                                                                 |
| `src/agents/tools/music-generate-background.ts`        | バックグラウンド生成実装（ツール専用・削除後に死コード化）           |
| `src/agents/tools/music-generate-background.test.ts`   | 同上のテスト                                                         |
| `src/agents/tools/video-generate-background.ts`        | バックグラウンド生成実装（ツール専用・削除後に死コード化）           |
| `src/agents/tools/video-generate-background.test.ts`   | 同上のテスト                                                         |
| `src/agents/tools/media-generate-background-shared.ts` | 上記 background 2 モジュール専用の共有ヘルパー                       |
| `src/agents/openclaw-tools.image-generation.test.ts`   | `createOpenClawTools` への image_generate 登録テスト                 |
| `src/agents/openclaw-tools.video-generation.test.ts`   | `createOpenClawTools` への video_generate 登録テスト                 |

### 22.3 コア参照のクリーンアップ

| ファイル                                                        | 変更内容                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/openclaw-tools.ts`                                  | `createImageGenerateTool` / `createMusicGenerateTool` / `createVideoGenerateTool` の import・インスタンス生成・`openclawTools` 返却配列からの除去                                                                             |
| `src/agents/pi-embedded-subscribe.handlers.tools.ts`            | `COMPACT_PROVIDER_INVENTORY_TOOLS`（image_generate / video_generate 専用）と `hasProviderInventoryDetails` / `shouldEmitCompactToolOutput` を削除。対象ツールが消えたため compact provider inventory 出力機能は空になり不要に |
| `src/agents/pi-embedded-subscribe.tools.ts`                     | `TRUSTED_TOOL_RESULT_MEDIA`（ローカル `MEDIA:` パスを許可するコアツール集合）から 3 ツールを除去                                                                                                                              |
| `src/agents/pi-embedded-subscribe.handlers.tools.media.test.ts` | image_generate / video_generate を使用するテストケースを削除・調整（structured media 検証は trusted コアツール `canvas` に置換、compact provider inventory テストは削除）                                                     |
| `src/agents/pi-embedded-subscribe.tools.media.test.ts`          | 3 ツールのメディア信頼判定テストを削除（core tool trust テストは `browser` に置換）                                                                                                                                           |
| `src/agents/tool-catalog.ts` / `tool-catalog.test.ts`           | `CORE_TOOL_DEFINITIONS` と coding profile allow 検証から 3 ツールを除去                                                                                                                                                       |
| `src/agents/tool-display-config.ts`                             | 表示設定（emoji / title / actions）から 3 ツールを除去                                                                                                                                                                        |
| `src/agents/test-helpers/fast-tool-stubs.ts`                    | `image-generate-tool.js` / `video-generate-tool.js` のモックを削除                                                                                                                                                            |
| `src/agents/test-helpers/fast-openclaw-tools-sessions.ts`       | `createMusicGenerateTool` のスタブを削除                                                                                                                                                                                      |
| `src/agents/test-helpers/fast-openclaw-tools.ts`                | コアツールスタブ一覧から `image_generate` / `video_generate` を除去                                                                                                                                                           |

### 22.4 温存した現役機能（触らなかったもの）

- `src/agents/music-generation-task-status.ts` / `src/agents/video-generation-task-status.ts` / `media-generation-task-status-shared.ts` — セッションの非同期タスク状態をプロンプトに反映する現役ヘルパー。`pi-embedded-runner/run/attempt.prompt-helpers.ts` が使用中のため残す
- `src/tasks/task-executor.test.ts` / `src/gateway/server-methods/agent.test.ts` 等のサンプルデータ内の `music_generate:...` / `video_generate:...` 文字列 — タスク実行基盤のテストフィクスチャでありツール参照ではないため温存
- `docs/tools/image-generation.md` / `music-generation.md` / `video-generation.md` — ドキュメント改訂は本タスクのスコープ外（別フェーズ候補）

### 22.5 検証ゲート結果

| ゲート                                                                   | 結果                                                                                                                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec tsgo --noEmit`                                                | **0 errors**                                                                                                                                                                  |
| `pnpm exec oxfmt --check`（変更 11 ファイル）                            | **clean**                                                                                                                                                                     |
| 影響範囲スコープテスト（編集モジュールを import する 24 テストファイル） | **198/198 passed**（`server.sessions-send.test.ts` のみ gateway テストヘルパーの `afterAll` フック 180 秒タイムアウトで環境要因失敗・単体再現確認済、テスト本体 2 件は pass） |

### 22.6 変更規模

- 削除: 17 ファイル・5,541 行
- 修正: 11 ファイル（ソース 8・テスト 3）
- 新規追加: なし（DEBLOAT.md 本節のみ追記）
- コミット: 1 コミット予定（push 禁止、ユーザー指示遵守）

## 23. DEBLOAT 候補台帳（2026-09-21 記録）

### 23.1 目的

本節は「今すぐ削除する確定対象」ではなく、**将来の DEBLOAT キャンペーンで実施する候補**を台帳として記録するもの。各候補はユーザー裁定または調査で「不要」と判断済みだが、撤去には依存解消という先行作業が必要なため、ここに残す。

### 23.2 候補一覧（2026-09-21 全数棚卸し反映）

2026-09-21 に `src/`（59ディレクトリ）・`extensions/`・`ui/`・`scripts/` の全数棚卸しを実施し、候補を再編した。規模は実測（ファイル数／概算行数）。

| #   | 候補                                                                                                                                                                                                                          | 規模                    | ユーザー裁定               | 先行作業                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------- | ------------------------------------------------------------------ |
| 1   | `src/agents/sandbox/` ＋ サンドボックス関連一式                                                                                                                                                                               | 69ファイル / 約11,300行 | **削除確定**               | `/sandbox` コマンド・doctor 検査・`stage-sandbox-media` の経路解消 |
| 2   | `src/tasks/` 一式                                                                                                                                                                                                             | 44ファイル / 約10,800行 | **削除確定**               | 依存4系統の解消（外部37ファイル参照）                              |
| 3   | `src/memory-host-sdk/`（＋ `packages/` 側）                                                                                                                                                                                   | 83ファイル / 約10,600行 | **削除確定**               | `memory-runtime` が unavailable を返す経路の実測確認               |
| 4   | `src/agents/auth-profiles/`                                                                                                                                                                                                   | 25ファイル / 約5,300行  | **削除確定**               | api-key 解決チェーンのフォールバック段と usage 表示の確認          |
| 5   | 生成系残骸 `src/{image,music,video,media}-generation/`                                                                                                                                                                        | 32ファイル / 約3,500行  | **削除確定**               | google/openai の provider 登録と同時に撤去                         |
| 6   | メディア生成プロバイダー登録（`extensions/google`, `extensions/openai`）                                                                                                                                                      | 数ファイル              | **削除確定**               | §22 の残骸（プロバイダー登録だけが生き残った状態）                 |
| 7   | WebUI jsdom テスト                                                                                                                                                                                                            | 56ファイル / 約14,000行 | **削除確定**               | browser テスト10本は温存要判断                                     |
| 8   | heartbeat 残骸                                                                                                                                                                                                                | 数ファイル              | **削除確定（cron 厳守）**  | cron 経路を一切壊さないこと。慎重に実施                            |
| 9   | realtime 系（`src/realtime-transcription/`, `src/realtime-voice/`）                                                                                                                                                           | 4ファイル / 255行       | **削除確定**               | plugin-sdk 再輸出の整理                                            |
| 10  | `src/qa-e2e/`                                                                                                                                                                                                                 | 9ファイル / 14行        | **削除確定**               | なし（中身は削除済み機能のスタブのみ）                             |
| 11  | テスト専用ディレクトリ（`src/docs/`, `src/i18n/`, `src/scripts/`）                                                                                                                                                            | 7ファイル / 約1,250行   | **削除確定**               | 軽（runtime import 0件）                                           |
| 12  | scripts の死参照（`test:live:media` / `test:docker:live-acp-bind*` / `test:voicecall:closedloop`）                                                                                                                            | 3件＋`package.json`     | **削除確定**               | 参照先ファイルが不在                                               |
| 13  | scripts の死にスクリプト群（`firecrawl-compare.ts`, `readability-basic-compare.ts`, `zai-fallback-repro.ts`, `phase3-delete.ps1`, `reindex.ps1`, `debug-claude-usage.ts`, `cron_usage_report.ts`, `sqlite-vec-smoke.mjs` 等） | 13本 / 約2,500行        | **削除確定（個別確認後）** | 参照0を実測確認                                                    |
| 14  | `skills/` 内の削除済み機能（clawhub / voice-call / sherpa-onnx-tts 等）                                                                                                                                                       | 数本                    | **削除確定**               | 軽                                                                 |
| 15  | zai / openrouter 等の互換レイヤー                                                                                                                                                                                             | 数ファイル＋テスト群    | **削除確定**               | 本番未使用を再確認                                                 |
| 16  | `.session-restore/`（ローカル未追跡 53MB）                                                                                                                                                                                    | ローカルのみ            | **削除確定**               | 即時削除可                                                         |

**触らない（使用中とユーザーが明言）**: `extensions/line`、`extensions/raw-chat-search`、`extensions/session-integrity-guard`、`extensions/deepgram`。

### 23.3 各候補の詳細

#### 23.3.1 `src/tasks/`（タスク台帳サブシステム / §23.2 候補2）

- **構成**: `task-registry.*`（タスク1件ごとの状態管理・SQLite永続化）、`task-flow-registry.*`（複数タスクの連鎖管理）、`task-executor.*`（実行側）、`task-owner-access.*`（権限）、`task-registry.maintenance/audit/reconcile`（掃除・監査・整合性修復）
- **機能**: サブエージェント実行・cron ジョブ・CLI 実行を「受付票」として記録し、状態（queued / running / succeeded / failed / timed_out / cancelled / lost）と配送状況を追跡する。`/status` の `Tasks:` 行、`/tasks`・`/flows` コマンド、`session_status` ツールの実体。
- **ユーザー裁定**: 不要（2026-09-21）
- **撤去時に対処が必要な依存（4系統）**:
  1. サブエージェント結果の配送 — `src/agents/subagent-registry-lifecycle.ts` / `subagent-registry-run-manager.ts`
  2. `/status` の Tasks 表示 — `src/commands/status.scan.ts` / `status.scan.json-core.ts`、`src/auto-reply/reply/commands-status.ts`
  3. スラッシュコマンド — `src/auto-reply/reply/commands-tasks.ts`、`src/commands/flows.ts`
  4. セッション状態ツール — `src/agents/session-async-task-status.ts`、`src/agents/tools/session-status-tool.ts`
- **その他**: イベントポンプの起床系統の1つ（`task`）としても接続されている（Wave 3 の7系統）。

#### 23.3.2 生成系の task-status 3ファイル（§23.2 候補5 の一部）

- **対象**: `src/agents/media-generation-task-status-shared.ts`、`src/agents/music-generation-task-status.ts`、`src/agents/video-generation-task-status.ts`
- **理由**: 生成系ツール（`image_generate` / `music_generate` / `video_generate`）は §22 で完全削除済み。これらの status ヘルパーは参照元が既に消えている可能性が高い（孤立候補）。
- **先行作業**: `grep` で参照0件を実測確認してから単独で削除可。

#### 23.3.3 zai / openrouter 等の互換レイヤー（§23.2 候補15）

- **対象**: `src/agents/openai-completions-compat.ts` の zai / openrouter 分岐、`provider-zai-endpoint` の plugin-sdk export、`zai-stream-wrappers.ts`、関連テスト群。加えて minimax / deepseek / together / qwen 系の残骸。
- **理由**: KASOU 本番は `cli-router` の4モデルのみ使用中。プロバイダー一本化（Wave 1）と builtin catalog 削除を経て、これらは本番経路に存在しない。
- **先行作業**: 本番未使用を再確認（`dennou.models.json` と config に該当プロバイダーが無いこと）。

#### 23.3.4 WebUI jsdom テスト（§23.2 候補7）

- **対象**: `ui/**/*.test.ts`（jsdom 環境で動く UI テスト）
- **理由**: WebUI は ChromeDevTools / 実 Chromium で直接確認する運用のため、jsdom 模倣テストは不要（ユーザー裁定 2026-09-21）。
- **関連**: 過去の WebUI 白画面障害では jsdom 模倣が偽グリーンを生んだ経緯があり、実機検証ゲートが正であることが実証済み（メモリ #1969 / #1976）。

#### 23.3.5 `.session-restore/`（§23.2 候補16）

- **対象**: リポジトリ直下の `.session-restore/`（約53MB、未追跡、`.gitignore` 済み）
- **理由**: セッション復元作業の一時ファイル。復元は完了し KASOU へ配置済み（1741行 → 復元版配置済み）。ユーザー裁定「いらない」（2026-09-20）。
- **注意**: Kasou のセッションデータを GitHub に出さないため、`.gitignore` 登録は維持すること。

#### 23.3.6 `src/agents/sandbox/` ＋ サンドボックス関連一式（§23.2 候補1）

- **対象**: `src/agents/sandbox/*`（69ファイル）、`src/agents/sandbox-paths.ts`、`sandbox-tool-policy.ts`、`sandbox-merge.ts`、`src/config/types.sandbox.ts`、`src/cli/sandbox-cli.ts`、`src/commands/sandbox*.ts`（sandbox / sandbox-display / sandbox-explain / sandbox-formatters）、`src/commands/doctor-sandbox.ts`、`src/plugin-sdk/sandbox.ts`、`src/auto-reply/reply/stage-sandbox-media.ts`（＋ runtime）、`src/cron/isolated-agent` の sandbox-config 経路、`test/helpers/sandbox-fixtures.ts`、および関連テスト群
- **機能**: Docker コンテナでツール実行を隔離する仕組み（image / network / seccomp / capDrop / memory / pidsLimit 等）
- **ユーザー裁定**: 不要（2026-09-21）
- **先行作業**: `/sandbox` コマンド、doctor の sandbox 検査、`stage-sandbox-media`（受信メディアのサンドボックス配置）の経路解消

#### 23.3.7 `src/memory-host-sdk/`（§23.2 候補3・実施済み — 詳細は §29 参照）

- **機能**: メモリ検索エンジン（engine / host）。embedding 用に `node-llama-cpp` 依存も同 SDK 内に残る
- **理由**: `memory-core` は §19 で完全削除済み、かつ有効プラグインに memory 種別が無い。`src/plugins/memory-runtime.ts` は「memory plugin unavailable」を返す経路になっており、呼び出し側（`agents/memory-search.ts`、`commands/status.scan.deps.runtime.ts`、`gateway/server-startup-memory.ts`）はそこへ委譲するだけ
- **先行作業**: 「呼ばれない」ことの実測（起動ログ・呼び出し回数）と `packages/` 側の扱い決定

#### 23.3.8 `src/agents/auth-profiles/`（§23.2 候補4）

- **機能**: `auth-profiles.json` による「プロバイダごとの複数クレデンシャル」管理。優先順（order.ts）、使用量・クォータ追跡（usage.ts）、セッション単位の上書き（session-override.ts）、doctor / repair を含む
- **理由**: KASOU は `cli-router` 1プロバイダ＋`.env` の静的 API キーのみで、`auth-profiles.json` は既に削除済み（2026-09-04 頃）
- **先行作業**: api-key 解決チェーン（config 直書き → env → `models.json` apiKey → auth-profiles → fallback）が auth-profiles 無しで成立すること、および usage / クォータ表示の実体を実測確認

#### 23.3.9 heartbeat 残骸（§23.2 候補8・cron 厳守）

- **対象**: `src/cron/heartbeat-policy.ts`、`src/auto-reply/heartbeat-token.ts`、`src/cron/isolated-agent/helpers.ts` の heartbeat ack 上限、`src/cron/service/timer.ts` の `heartbeat: { target: "last" }`、`src/cron/types.ts` の `wakeMode: "next-heartbeat"`、`src/cron/trigger-policy.ts` の heartbeat トリガープロンプト注入
- **状態**: Wave 3 で heartbeat 機能（定期実行・HEARTBEAT.md）は撤去済みだが、上記が cron 経路に残存している
- **制約**: **cron を絶対に壊さない**。実施は単独（並列禁止）とし、前後で cron の動作テストを実測する

### 23.4 実施順序の推奨

依存の軽い順に進める。各波ごとに Executor 実装 → code-reviewer APPROVE → コミット。

- **波1（即時・依存なし）**: 候補10（qa-e2e）／候補9（realtime系）／候補11（テスト専用ディレクトリ）／候補12・13（scripts 死参照・死にスクリプト）／候補14（skills 残骸）／候補16（`.session-restore/`）
- **波2（同一機能の残骸を一括）**: 候補5（生成系残骸）＋候補6（メディア生成プロバイダー登録）
- **波3（テスト削除）**: 候補7（WebUI jsdom テスト）
- **波4（互換レイヤー）**: 候補15（zai / openrouter 等）
- **波5（cron 厳守）**: 候補8（heartbeat 残骸）— **単独で実施**。cron の動作テストを前後で実測
- **波6（大きいサブシステム）**: 候補4（auth-profiles）→ 候補3（memory-host-sdk）→ 候補2（tasks）→ 候補1（sandbox）

**並列化の注意**: 波1・波2は対象ディレクトリが重複しないため 2〜3 体での並列が可能。波5 以降（auth-profiles / memory-host-sdk / tasks / sandbox）は `src/agents`・`src/config`・`src/gateway` を共有するため**1 体ずつ直列**で実施する（過去に同一ワークツリーでの並列実行がファイル消失・変更競合を起こした実績がある）。

### 23.5 検証ゲート（全候補共通）

- `tsgo --noEmit` が 0 errors
- 削除対象への参照が 0 件（`grep` 実測）
- Bun / Vitest の対象テストが pass、または対象テスト自体が削除済み
- 本番経路（KASOU: cli-router 4モデル）に影響しないことを実測で確認
- code-reviewer の APPROVE

### 23.6 ユーザー裁定（2026-09-21 全数棚卸しレビュー）

棚卸し結果を提示したうえでのユーザー決定:

**削除する**

- 残骸（remnants）は**全部削除**
- メディア生成プロバイダー登録も**全部削除**
- `src/agents/auth-profiles/`、`src/memory-host-sdk/`、`src/tasks/`、`src/agents/sandbox/` を削除
- heartbeat 残骸は**慎重に**削除。**cron は絶対に壊さない**

**触らない（使用中）**

- `extensions/line`
- `extensions/raw-chat-search`
- `extensions/session-integrity-guard`
- `extensions/deepgram`

**棚卸しで判明した矛盾（本キャンペーンで解消する）**

1. heartbeat 残骸が cron 経路に現存（`cron/heartbeat-policy.ts`、`wakeMode: "next-heartbeat"`、cron タイマーの `heartbeat: { target: "last" }`）。Wave 3 で撤去済みのはずが残存している
2. `extensions/google`（`index.ts:167-170`）と `extensions/openai`（`index.ts:31,35`）に、削除済みのはずのメディア生成プロバイダー登録が現存（§22 との不整合）
3. `deepgram` の記述が旧文書（「KASOU の `tools.media.audio` で実運用中」）と現状で矛盾 → **ユーザー裁定により使用中、触らない**
4. `raw-chat-search` は Go 版 sidecar 削除済みだが TS 版拡張は残存 → **ユーザー裁定により使用中、触らない**

**実装開始**: ユーザー指示「DEBLOAT は後で、今はドキュメントへ」により、本節の記録をもって計画確定。実施は次回キャンペーンで波1から順に進める。

## 24. tasks（バックグラウンド作業の管理台帳）完全撤去（2026-09-23 時点作業）

### 24.1 背景・動機

§23.2 候補2 の実施波。単一 KASOU 運用ではバックグラウンドタスク台帳（`src/tasks/` + SQLite レジストリ）は不要というユーザー裁定（2026-09-21）に基づく。タスク台帳はサブエージェント実行・cron・CLI 実行を「受付票」として記録し、結果配送・`/status` の `Tasks:` 行・`session_status` の `📌 Tasks:` 行・`openclaw tasks` CLI・プラグイン `runtime.tasks` 面を常時支えていたが、単一 KASOU 運用では観測需要がなく、`tasks/runs.sqlite` の永続化・maintenance タイマー・イベントポンプ起床系統（Wave 3 の7系統目）を常時稼働させるコストだけが残る。

ベース: branch `main` / HEAD `82c2c653ee`。sandbox / auth-profiles / exec-approvals / provider-usage の各バッチと同一ワークツリーで並行実施。

### 24.2 削除対象と行数

**66 ファイル / 14,487 行削除**（全て git 追跡ファイル。行数は `git diff --numstat` 実測）

| 区分                   | 内容                                                                                                                                                                          | ファイル数     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 中核                   | `src/tasks/**`（task-registry* / task-flow-registry* / task-executor* / task-owner-access* / task-status\* / maintenance / audit / reconcile / store.sqlite など）            | 44（10,804行） |
| スラッシュコマンド     | `src/auto-reply/reply/commands-tasks.ts` + `.test.ts`（`/tasks` ハンドラ）                                                                                                    | 2              |
| CLI コマンド           | `src/commands/tasks.ts` + `.test.ts`（`openclaw tasks`）、`src/commands/flows.ts` + `.test.ts`（`tasks flow` 実装）                                                           | 4              |
| セッション状態ツール系 | `src/agents/session-async-task-status.ts`、`media-generation-task-status-shared.ts`、`music-generation-task-status.ts`、`video-generation-task-status.ts` + `.test.ts`        | 5              |
| プラグインランタイム   | `src/plugins/runtime/runtime-tasks.ts` + `.test.ts`、`runtime-taskflow.ts` + `.test.ts`、`task-domain-types.ts`（`runtime.tasks` / `runtime.taskFlow` 面）                    | 5              |
| テスト用ランタイム     | `src/test-utils/task-registry-runtime.ts`                                                                                                                                     | 1              |
| テスト設定             | `vitest.tasks.config.ts`（＋ `vitest.config.ts` / `vitest.shared.config.ts` / `scripts/test-projects.test-support.mjs` / `test/vitest-scoped-config.test.ts` からの参照除去） | 1              |
| ドキュメント           | `docs/automation/tasks.md`、`docs/automation/taskflow.md`、`docs/cli/flows.md`、`docs/automation/clawflow.md`                                                                 | 4              |

### 24.3 参照の除去（本番）

| ファイル（編集）                                                                                                           | 変更内容                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/subagent-registry-run-manager.ts`                                                                              | `registerSubagentRun` 内の `createRunningTaskRun`（サブエージェント受付票の作成）ブロック削除                                                                                                                                                                                                        |
| `src/agents/subagent-registry-lifecycle.ts`                                                                                | `completeTaskRunByRunId` / `failTaskRunByRunId` / `setDetachedTaskDeliveryStatusByRunId` の import・`safeFinalizeSubagentTaskRun`・`safeSetSubagentTaskDeliveryStatus`・3箇所の配送状態更新呼び出しを削除（announce / cleanup / give-up のフロー本体は維持）                                         |
| `src/gateway/server-methods/agent.ts`                                                                                      | ゲートウェイ agent run の `createRunningTaskRun` 追跡（`shouldTrackTask` ブロック）削除                                                                                                                                                                                                              |
| `src/gateway/server.impl.ts`                                                                                               | `startTaskRegistryMaintenance()` / `stopTaskRegistryMaintenance` / `getInspectableTaskRegistrySummary().active`（再起動遅延チェック）を削除                                                                                                                                                          |
| `src/gateway/server-reload-handlers.ts`                                                                                    | config reload 時の `activeTasks` カウント削除                                                                                                                                                                                                                                                        |
| `src/gateway/server-close.ts`                                                                                              | shutdown ハンドラの `stopTaskRegistryMaintenance` パラメータと呼び出し削除                                                                                                                                                                                                                           |
| `src/commands/status.summary.ts` / `status.scan.ts` / `status.scan.json-core.ts` / `status.types.ts` / `status.command.ts` | `StatusSummary.tasks` / `taskAudit` フィールドと maintenance モジュールの遅延 import、`openclaw status` の「Tasks」行・audit メンテナンスヒントを削除                                                                                                                                                |
| `src/commands/doctor-workspace-status.ts`                                                                                  | `noteFlowRecoveryHints()`（TaskFlow 回復ヒント）と `tasks flow` コマンド案内を削除                                                                                                                                                                                                                   |
| `src/auto-reply/reply/commands-handlers.runtime.ts`                                                                        | `handleTasksCommand` の dispatch 登録削除                                                                                                                                                                                                                                                            |
| `src/auto-reply/commands-registry.shared.ts`                                                                               | `/tasks` のコマンド仕様（textAlias）削除                                                                                                                                                                                                                                                             |
| `src/auto-reply/reply/subagents-utils.ts`                                                                                  | `sanitizeTaskStatusText` + ヘルパーを `src/tasks/task-status.ts` から**移設**（`/subagents` ラベル整形が継続使用するため）                                                                                                                                                                           |
| `src/auto-reply/reply/commands-subagents/action-info.ts`                                                                   | `/subagents info` から台帳連携行（TaskId / TaskStatus / Progress / Task summary / Task error / Delivery）を削除。outcome サニタイザは移設先を利用                                                                                                                                                    |
| `src/agents/tools/session-status-tool.ts`                                                                                  | `formatSessionTaskLine`（`📌 Tasks:` 行）・`taskLineOverride` / `skipDefaultTaskLookup` への渡しを削除                                                                                                                                                                                               |
| `src/agents/pi-embedded-runner/run/attempt.prompt-helpers.ts`                                                              | 生成系 task-status ヘルパー2本の組み込み（active media task プロンプト注入）を削除                                                                                                                                                                                                                   |
| `src/cron/service/ops.ts` / `timer.ts`                                                                                     | cron のタスク台帳連携（`tryCreate*CronTaskRun` / `tryFinish*CronTaskRun` / `taskRunId` 配線 / warn「cron: failed to create task ledger record」）を全削除。ジョブ実行・配信・永続化ロジックは無改変                                                                                                  |
| `src/plugins/runtime/index.ts` / `types-core.ts` / `src/plugin-sdk/index.ts`                                               | プラグインランタイムの `tasks` / `taskFlow` フィールドと plugin-sdk の Task 型 re-export を削除（`pnpm plugin-sdk:api:gen` で baseline sha256 再生成）                                                                                                                                               |
| `src/cli/program/register.status-health-sessions.ts`                                                                       | `openclaw tasks` コマンド一式（list / show / notify / cancel / audit / maintenance / flow list / flow show / flow cancel）を削除                                                                                                                                                                     |
| `src/cli/program/command-registry.ts` / `core-command-descriptors.ts`                                                      | `tasks` コマンドディスクリプタ削除                                                                                                                                                                                                                                                                   |
| `ui/src/ui/_shared/chat-commands.ts`                                                                                       | `/tasks` コマンドエントリ削除                                                                                                                                                                                                                                                                        |
| `src/agents/tools/cron-tool.ts`                                                                                            | ツール description の「background task runs that appear in `openclaw tasks`」文言削除（cron 本体は無改変）                                                                                                                                                                                           |
| `scripts/test-projects.test-support.mjs` / `vitest.config.ts` / `vitest.shared.config.ts`                                  | `vitest.tasks.config.ts` のルーティング削除                                                                                                                                                                                                                                                          |
| docs14ファイル + `docs/docs.json`                                                                                          | `/automation/tasks`・`/automation/taskflow`・`/cli/flows`・`/tasks` の nav / redirect / 相互リンクを除去。`docs/automation/index.md` は Tasks / Task Flow 節・判定表行・Related リンクを整理し「Automation」に再題。`docs.json` の clawflow redirect（先が削除済み taskflow を指していたため）も削除 |

### 24.4 設定スキーマの @deprecated 受容（KASOU 本番保護）

- `src/config/zod-schema.ts` の root `OpenClawSchema` は **`.strict()`** で、未知の root キーがあると `loadConfig` が `INVALID_CONFIG` を throw して fail closed する（`src/config/io.ts` の検証経路を実測確認）。そこで root に **`tasks: z.unknown().optional()`（`@deprecated` JSDoc 付き・受容して無視）を追加**した。KASOU の `dennou-aibou.json` に `tasks` 系キーが残っていても gateway は起動する。
- `src/config/types.openclaw.ts` に `tasks?: unknown`（`@deprecated`）を追加し public 型面と整合。
- 現行スキーマには元々 task 系キーが存在しなかったため、「削除して strict エラー化」は起きない。本手当ては**残存キー受容の防波堤**（過去波の `contextPruning` 受容・`keepLastTools` @deprecated と同型）。
- `pnpm config:docs:gen` 実行済み（`docs/.generated/config-baseline.sha256` 再生成）。
- `tasks/runs.sqlite` への参照はリポジトリ全体で **0 件**（`runs.sqlite` grep 実測0）。既存ファイルが残っていても open するコードが存在しないため起動・停止への影響なし。

### 24.5 イベントポンプ（7系統目 wake 消費者）の切り離し

- wake **生産者**（`src/tasks/task-registry.ts` の `requestWakeNow()` と `contextKey: \`task:\*\``の`enqueueSystemEvent`）は中核削除とともに消滅。grep 実測: `contextKey: \`task:\``0件 / `reason: "task..."`0件。
- **`src/infra/event-pump.ts` は1行も変更していない**（カーネル基盤維持）。ポンプ内の wake reason 分類（`cron:` / `exec-event` / `notifications-event` / `hook:` / `wake` / `manual`）にも `task` 分類は元から存在せず、他6系統は無傷。

### 24.6 温存したもの・判断を保留したもの

- **`src/auto-reply/reply/commands-status.ts` / `commands-status.test.ts`** — 別バッチ（C）所有のため**未編集**。`/status` の `Tasks:` 行削除は後続タスク。現状 tsgo のタスク起因エラーはこの2ファイルの4件のみで、バッチCの編集待ち。
- `test/bun-tier-*.txt`（既知失敗台帳各種）— `bun-tier-hoisted-known-failing.txt` は Kuraudo 更新のため未編集。c3b / c4b / beyond250 等の台帳も同方針で触らず、`src/tasks/...` の記述が残るが無害（参照ではなく記録）。
- `sanitizeTaskStatusText` — 台帳データではなく汎用テキストサニタイザだったため削除せず `subagents-utils.ts` へ移設。
- `auto-reply/status.ts` の `taskLine` / `skipDefaultTaskLookup` フィールド — バッチCの `commands-status.ts` が参照するため残置（文字列のみで `src/tasks` への依存なし）。
- `HEARTBEAT.md` の `tasks:` ブロック（due-only チェック）と `no-tasks-due` スキップ理由 — heartbeat 機能固有で台帳とは無関係 → **§23.3.9 の heartbeat 残骸波へ委譲**。
- UI の生成翻訳（`ui/src/i18n/.i18n/*.tm.jsonl`）は生成物のため未手編集（実装は `chat-commands.ts` から削除済み）。
- `DENNOU_DOCS/DEBLOAT.md` §20〜23 内の `src/tasks/...` 記述 — 過去波の記録なので書き換えない。

### 24.7 検証ゲート結果

| ゲート                                                                                                                                                                                                                                                            | 結果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 残存参照 grep（`tasks/` import・`createRunningTaskRun`・`runs.sqlite`・`contextKey: task:`・`/tasks` textAlias・`vitest.tasks`・`openclaw tasks`・`automation/tasks` リンク・`TaskRegistrySummary`/`TaskAuditSummary`・`runtime.tasks`・event-pump 内 task 参照） | **全項目0件**（`src/tasks/` ディレクトリ消失込み。例外はバッチC所有の `commands-status.*` の4 import のみ）                                                                                                                                                                                                                                                                                                                                                                                          |
| `node scripts/run-tsgo.mjs --noEmit`                                                                                                                                                                                                                              | 最終実行: **4エラー/2ファイル = すべてバッチC の `commands-status.*`**（`tasks/` の4 import。`/status` の Tasks 行削除で解消）。**自身の変更52ファイルとのエラー交差 = 0件**、tasks 起因エラーもバッチC分を除き **0件**                                                                                                                                                                                                                                                                              |
| `oxfmt --check`（自身の変更52ファイル + DEBLOAT.md + 編集docs15ファイル）                                                                                                                                                                                         | **全件 pass**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `bun run build`                                                                                                                                                                                                                                                   | `canvas:a2ui`（prebuilt 不在＝環境要因）→ `OPENCLAW_A2UI_SKIP_MISSING=1` で通過 → tsdown は最終確認時点で **バッチCの `commands-status.ts` の tasks import 2件のみ**で停止（sandbox バッチの entry 問題は解消済み）。**tasks 起因のエラー0**（build 設定に tasks entry は元から不在。バッチCの `/status` Tasks 行削除で全解消）                                                                                                                                                                      |
| cron 全体（`vitest.cron.config.ts`）                                                                                                                                                                                                                              | **69/73ファイル pass**。赤4 = `isolated-agent.model-formatting`（バッチC import 鎖でロード不能）+ `every-jobs-fire`(2) / `restart-catchup`(4) / `store-load-invalid-main-job`(1)（いずれも未改修ファイルで HEAD 由来の時間依存・既知型の赤。cron 実装への本タスクの diff は **タスク台帳のみの純削除で追加行0** を git diff で全確認）                                                                                                                                                               |
| cron 作用域（編集した `ops.test.ts` / `timer.test.ts`）                                                                                                                                                                                                           | **PASS**（GroupA: cron2 + event-pump2 =4ファイル/36テスト全 pass）                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| イベントポンプ（`src/infra/event-pump.test.ts` / `system-events.test.ts`）                                                                                                                                                                                        | **PASS**（ポンプ本体は無改変・システムイベント経由の wake 経路も無傷）                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 作用域テスト（status / doctor / cli / gateway close / prompt-helpers / plugin runtime / lifecycle / scoped-config / test-projects / commands-registry / status.tools ほか）                                                                                       | pass: status3ファイル20テスト、doctor + status.tools、cli3ファイル25テスト、server-close + prompt-helpers5テスト、plugin-runtime14テスト、vitest-scoped-config51テスト、subagent-registry-lifecycle3テスト。**HEAD 由来の既存赤**: `commands-registry.test`2件（slack `agentstatus` / `acp` — slack チャンネルと acpx は過去波で削除済み・当 HEAD で実装不在を git grep 実測）、`test-projects.test`1件（`OPENCLAW_VITEST_INCLUDE_FILE` vs `DENNOU_VITEST_INCLUDE_FILE` キー不一致が HEAD から存在） |
| バッチC待ちでロード不能（編集対象外）                                                                                                                                                                                                                             | `commands-status.ts` / `commands-status.test.ts` / `agent.test.ts` / `session-status.test.ts` / `subagent-registry.persistence.resume.test.ts`（いずれも `session-status-tool → commands-status → tasks/` の import 鎖。バッチCの `/status` Tasks 行削除で解消）                                                                                                                                                                                                                                     |
| `pnpm config:docs:gen` / `plugin-sdk:api:gen`                                                                                                                                                                                                                     | 実行済み（`config-baseline.sha256` / `plugin-sdk-api-baseline.sha256` 再生成）                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 台帳 `test/bun-tier-*.txt`                                                                                                                                                                                                                                        | 未編集（`bun-tier-hoisted-known-failing.txt` は diff 0。c3b/c4b の M は sandbox バッチの作業）                                                                                                                                                                                                                                                                                                                                                                                                       |

### 24.8 変更規模

- 削除: **66 ファイル / 14,487 行**
- 修正: **52 ファイル**（うち `status.command.ts` / `status.scan.ts` / `server.impl.ts` 等の共有ファイルには並行バッチの変更も同居）
- 生成物再生成: `docs/.generated/config-baseline.sha256`、`docs/.generated/plugin-sdk-api-baseline.sha256`
- コミット: 未実施（git add / commit / push は本タスクの禁止事項。Kuraudo / コーディネータが並行バッチと合流させること）

## 25. provider-usage（プロバイダ別 使用量・残クォータ表示）完全撤去（2026-09-24 時点作業・完了）

### 25.1 目的・背景

KASOU 運用ではプロバイダ別の使用量・残クォータ表示（`/status` の Usage 行・`status --usage`・`channels list` の usage・`models list --status` の usage サフィックス・WebUI の usage タブ）は未使用。provider の quota エンドポイントへ毎回 HTTP を投げる割に表示面だけで、KASOU の cli-router＋`.env` 固定キー運用と無関係。ユーザー裁定で完全撤去。

### 25.2 削除したファイル（42 件 / 約5,300行）

| 区分             | ファイル                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 本体             | `src/infra/provider-usage.ts` / `.types.ts` / `.auth.ts` / `.fetch.ts` / `.fetch.claude.ts` / `.fetch.gemini.ts` / `.fetch.minimax.ts` / `.fetch.zai.ts` / `.fetch.shared.ts` / `.format.ts` / `.load.ts` / `.shared.ts` / `.test-support.ts`（＋各 `.test.ts` 計13本）                                            |
| plugin-sdk       | `src/plugin-sdk/provider-usage.ts`、package.json の `./plugin-sdk/provider-usage` export、`scripts/lib/plugin-sdk-entrypoints.json` の `provider-usage`                                                                                                                                                            |
| テスト支援       | `src/test-utils/provider-usage-fetch.ts`、`test/helpers/plugins/provider-usage-fetch.ts`                                                                                                                                                                                                                           |
| WebUI usage タブ | `app-render-usage-tab.ts` / `controllers/usage.ts`(+node.test) / `views/usage.ts` / `views/usage-metrics.ts` / `views/usage-query.ts` / `views/usage-render-details.ts`(+test) / `views/usage-render-overview.ts` / `views/usageTypes.ts` / `usage-helpers.ts`(+node.test) / `usage-types.ts` / `styles/usage.css` |
| 共有（孤立化）   | `src/shared/usage-types.ts` / `usage-aggregates.ts`(+test) / `ui/_shared/usage-aggregates.ts`                                                                                                                                                                                                                      |

### 25.3 変更したファイル（約40件）

- CLI/status: `status.command.ts`・`status-json.ts`・`register.status-health-sessions.ts`・`routes.ts`・`channels-cli.ts`（`--usage`/`--no-usage` フラグ撤去）・`channels/list.ts`・`models/list.status-command.ts`
- `/status`（チャット）: `auto-reply/reply/commands-status.ts`（usage 行のみ撤去・tasks 行は tasks バッチと別途調整）・`auto-reply/status.ts`（usageLine パラメータ撤去）
- gateway: `server-methods/usage.ts`（`usage.status`・`sessions.usage*` ハンドラ撤去）・`method-scopes.ts`・`server-methods-list.ts`・`protocol/index.ts`・`protocol/schema/{types,sessions,protocol-schemas}.ts`
- plugin フック: `plugins/types.ts`（`resolveUsageAuth`/`fetchUsageSnapshot`/関連型を撤去）・`plugins/provider-runtime.ts`・`plugin-sdk/{core,plugin-entry}.ts`・`extensions/google/gemini-cli-provider.ts`（フック・`plugin-sdk/provider-usage` import 撤去）
- WebUI: `navigation.ts`（usage タブ撤去）・`app.ts`（38状態フィールド撤去）・`app-view-state.ts`・`app-settings.ts`・`app-render.ts`・`views/overview.ts`・`views/overview-cards.ts`（Cost カード撤去）・`types.ts`・`styles.css`・i18n 13 ロケール（`tabs.usage`・`usage: {}` セクション・`overview.cards.cost` 撤去）
- テスト: `status-json.test.ts`・`status.test.ts`・`models/list.status.test.ts`・`channels.adds-...test.ts`・`commands-status.thinking-default.test.ts`・`reply.triggers.trigger-handling.test-harness.ts`（+cases ファイル整理）・`openclaw-tools.session-status.test.ts`・`plugins/provider-runtime.test.ts`・`provider-runtime-contract.ts`
- docs: `cli/status.md`・`cli/index.md`・`cli/channels.md`・`cli/models.md`・`concepts/usage-tracking.md`（全面改稿）・`gateway/protocol.md`・`plugins/{sdk-migration,sdk-overview,architecture,sdk-provider-plugins}.md`・`concepts/model-providers.md`・`reference/{api-usage-costs,token-use}.md`・`platforms/mac/menu-bar.md`・`tools/slash-commands.md`

### 25.4 残したもの・理由

- `usage.cost` RPC + `infra/session-cost-usage.ts` + `src/shared/session-usage-timeseries-types.ts` — セッションのトークン/コスト集計（`/usage` スラッシュコマンド・`gateway usage-cost` CLI が利用）。provider-usage とは別系統。
- WebUI Overview の他カード・`/usage off|tokens|full`・`/usage cost` — セッション usage。残す。
- `extensions/google/oauth-token-shared.ts` の `parseGoogleUsageToken`（生産者消滅後も自身の単体テストのみで生存 — 次波で削除候補）。

### 25.5 検証結果

| ゲート                                                                                | 結果                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/run-tsgo.mjs --noEmit`（Phase A 終了時点）                              | **0 errors**                                                                                                                                                                                                                  |
| `bun run ui:build`                                                                    | **pass**                                                                                                                                                                                                                      |
| `status.test.ts` + `status-json.test.ts`                                              | 18/18 pass                                                                                                                                                                                                                    |
| `models/list.status.test.ts` / `channels.adds-non-default-telegram-account.test.ts`   | 9/9・21/21 pass                                                                                                                                                                                                               |
| `commands-status.test.ts` + `.thinking-default.test.ts` + `auto-reply/status.test.ts` | 5/5 + 48/48 pass（subagent-registry mock の `registerSubagentRun` を追加 — sandbox バッチの import グラフ変更への追随）                                                                                                       |
| `plugins/provider-runtime.test.ts`                                                    | 12/14 pass（残2件は openai-codex catalog フィクスチャの既存ドリフト。削除対象は provider-usage の usage フックのみで、失敗位置（1021/1153行）は本バッチの変更ハンク外 — 別バッチ/先行波起因）                                 |
| 残存参照                                                                              | `provider-usage` / `usage.status` / `--usage` / `fetchUsageSnapshot` / `resolveUsageAuth` の src/scripts/extensions/docs 参照 **0件**（`test/bun-tier-*.txt` 台帳は削除済みテストのパス記録が残る — 別タスク（§27.6）で更新） |
| oxfmt                                                                                 | 実行済み（§25.5 の後続作業で実施。§28.6 の変更9ファイルは全件 pass）                                                                                                                                                          |

## 26. auth-profiles（複数クレデンシャル管理）完全撤去（2026-09-24 時点作業・完了）

### 26.1 目的・背景

§23.2 候補4。KASOU は cli-router 1本＋`.env` 固定キーのみで `auth-profiles.json` は撤去済み（2026-09-04 頃）。優先順管理（order.ts）・使用量/クォータ追跡（usage.ts）・セッション単位上書き（session-override.ts）・doctor/repair を含む「プロバイダごとの複数クレデンシャル」管理を完全撤去。先行作業（api-key 解決チェーンが auth-profiles 無しで成立する確認）は本波で実施。

### 26.2 削除済み（41 ファイル / 約7,000行）

- `src/agents/auth-profiles/`（25 ファイル / 5,315行）— store/oauth/profiles/order/usage/session-override/doctor/repair/identity/paths/constants/policy/display/credential-state/state-observation/upsert-with-lock/types 一式
- `src/agents/auth-profiles.ts`（バレル）・`auth-profiles.runtime.ts`・flattened テスト14本（store-cache/readonly-sync/cooldown/doctor/order系5本/runtime-snapshot/save 等）
- `src/agents/model-auth.profiles.test.ts`（撤去機能専用テスト）
- 共有孤立化ファイル（Phase A で）：`src/shared/usage-*`

### 26.3 変更済み（コア経路。API キー解決は無傷）

- `src/agents/model-auth.ts` — `resolveApiKeyForProvider` から profile 解決段（`resolveAuthProfileOrder` ループ・`resolveApiKeyForProfile`・`ensureAuthProfileStore`）を撤去。「config 直書き → env → models.json apiKey → synthetic local → fallback エラー」で従来どおり解決。`profileId`/`preferredProfile`/`lockedProfile`/`agentDir` は呼び出し側互換のため `@deprecated` として受理（無視）。`resolveModelAuthMode`・`hasAvailableAuthForProvider`・`getApiKeyForModel` も同様に profile 段撤去。再 export（`ensureAuthProfileStore`/`resolveAuthProfileOrder`）を削除。
- `src/plugin-sdk/provider-auth.ts` — バレルから auth-profiles 由来 export（型・store 操作・`CODEX_CLI_PROFILE_ID`・`suggestOAuthProfileIdForLegacyDefault`）を撤去。`isProviderApiKeyConfigured` は env のみ判定に変更。
- `src/plugins/provider-auth-helpers.ts` — `writeOAuthCredentials`（store 書き込み）と補助関数群を削除。`applyAuthProfileConfig`（config 側メタデータ）は温存。

### 26.4 残務の処理結果（2026-09-24 後任作業・完了）

前任が列挙した約200件の残務を実測で切り分けた結果、**本番参照は既に0件**だった。残存は以下のみで、いずれも無害と確定：

- `src/agents/pi-auth-credentials.ts` — 死に3関数（`convertAuthProfileCredentialToPi` / `resolvePiCredentialMapFromStore` / `piCredentialsEqual`）を削除。参照元0件を実測確認。`PiCredential` / `PiCredentialMap` 型は `pi-model-discovery.ts` が使用中のため温存（env-backed credential shape として継続使用）。
- テストの stale mock（`ensureAuthProfileStore` / `listProfilesForProvider` 等）— SUT側は既に参照しておらず、vitest の余分な mock キーとして無害のため残置。
- `AuthProfileFailureReason` / `AuthProfileCredential` / `AuthProfileStore` 型参照 — 型のみの参照（`import type`）。`plugins/types.ts` は禁止編集ファイル（`src/config/` スキーマ担当と共有）のため、リネームは見送り。tsgo 0・ビルド通過に影響なし。
- `model-fallback.run-embedded.e2e.test.ts` の `writeAuthStore` / `readUsageStats` — 削除済みJSONへの書き込み検証だが、e2eテスト自体がデフォルト除外（`*.e2e.test.ts`）のため実行されず無害。現役フォールバック機能の検証部分は維持。
- `tsdown.config.ts:127` の `"agents/auth-profiles.runtime"` entry — 削除済みファイルを指して build が `UNRESOLVED_ENTRY` で停止していたため除去。これにより `bun run build` は次の段階（memory-host-sdk のテスト型エラー＝別バッチ所有）まで進行。
- `profileId` リテラルの残存 — OAuth/MCP由来・provider hook signature の別物と切り分け済み。auth-profiles 残渣ではない。
- `scripts/claude-auth-status.sh` — 削除済み `auth-profiles.json` パス（`OPENCLAW_AUTH` 変数・`check_openclaw_auth` の legacy フォールバック・表示ラベル）を参照。削除済みJSON用の legacy フォールバックとして抑制コメント付きで温存（§26撤去の残存参照として記録）。

APIキー解決チェーンの実測：`src/agents/model-auth.ts` の `resolveApiKeyForProvider` は「config直書き → env → models.json apiKey → synthetic local → fallback エラー」の順で解決し、profile 解決段は存在しないことをコード読解で確認。`model-auth.test.ts`（25,743行・現役テスト）がこの経路を検証。

### 26.5 完了の記録

- Phase B（auth-profiles）は完了。Phase C（exec-approval）は §28 として実施・完了。
- Phase A（provider-usage）は完了・検証済み（§25）。
- `src/agents/model-auth.test.ts` の it 37→36 / expect 41→40 は auth-profiles 専用テスト1件削除に伴う**意図的な減少**（§26撤去の一環）。

## 27. sandbox（Docker 分離実行環境）完全撤去（2026-09-24 時点作業）

### 27.1 目的

`agents.defaults.sandbox` / Docker ベースの分離実行（agent sandbox、exec host=sandbox、sandbox workspace / media / skills / browser）を完全撤去し、`exec` を host（gateway / node）実行に一本化する。設定キーは **`@deprecated` 受容（無視）** に変更し、既存の `dennou-aibou.json` に sandbox 系キーが残っていても gateway は起動できるようにする（§24.4 と同型の防波堤）。

### 27.2 削除対象（124 ファイル / 19,097 行）

| カテゴリ                   | 削除対象                                                                                                                                                | 数  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| sandbox 実装               | `src/agents/sandbox/**`（backend / docker / ssh / fs-bridge / workspace / manage / registry / browser / tool-policy / config-hash ほか）                | 69  |
| sandbox 単体モジュール     | `src/agents/sandbox.ts` / `sandbox-paths.ts` / `sandbox-media-paths.ts` / `sandbox-tool-policy.ts` / `pi-embedded-runner/sandbox-info.ts` ほか          | 12  |
| CLI / コマンド             | `src/cli/sandbox-cli.ts` / `src/commands/sandbox*.ts`（`openclaw sandbox`）                                                                             | 11  |
| inbound media ステージング | `src/auto-reply/stage-sandbox-media*` / `reply/stage-sandbox-media*`（＋ テスト）                                                                       | 5   |
| テスト / テストヘルパー    | sandbox 系テスト 10 + `test/helpers/sandbox-fixtures.ts` / agents/test-helpers 4                                                                        | 15  |
| ビルド資材                 | `Dockerfile.sandbox*` ×3 / `scripts/sandbox-*.sh` ×4 / `.github/workflows/sandbox-common-smoke.yml`                                                     | 8   |
| 設定                       | `src/config/types.sandbox.ts` / `config.sandbox-docker.test.ts` / `src/plugin-sdk/sandbox.ts`                                                           | 3   |
| ドキュメント               | `docs/cli/sandbox.md` / `docs/gateway/sandboxing.md` / `docs/gateway/sandbox-vs-tool-policy-vs-elevated.md` / `docs/tools/multi-agent-sandbox-tools.md` | 4   |

### 27.3 参照の除去（本番 / テスト / スクリプト）

- 本番コード（前任完了分）: `bash-tools.exec*` / `exec-defaults` / `path-policy` / `pi-embedded-runner` / `system-prompt` / `agent-scope` / `web-fetch` / `web-search` / `media` ほかから sandbox runtime 分岐・sandboxInfo / sandboxed フラグ・apiKey ペイロードを全除去。`src/config/schema.help.ts` / `schema.labels.ts` の sandbox キー、`zod-schema` 系の sandbox 定義も除去・受容化。
- 本任（残務）: **`scripts/docker/setup.sh` の sandbox ブロック除去（−178 行）** — `OPENCLAW_SANDBOX` / Dockerfile.sandbox ビルド / `docker-compose.sandbox.yml` 生成 / `agents.defaults.sandbox.*` 設定 / `run_runtime_cli`（base スコープ）を全削除。`OPENCLAW_DOCKER_SOCKET` / `DOCKER_GID` 連動も除去。
- テスト残骸: `docker-setup.e2e.test.ts`（sandbox ケース 4 削除＋`DockerSetupSandbox` → `DockerSetupFixture` 改名）、`docker-build-cache.test.ts`（Dockerfile.sandbox\* 参照除去）、`dockerfile.test.ts`（DENNOU_SANDBOX 言及のテスト名修正）、`commands-system-prompt` / `directive-handling.model` / `directive-handling.downgrade-persist` / `attempt.spawn-workspace.test-support` / `compact.hooks.harness` / `sessions-list-tool`（削除済み sandbox.js / sandbox-info.js への vi.mock / vi.doMock / mock 配線除去）、`reply-media-paths.test.ts`（sandbox workspace マッピング 3 ケース削除 — 本番は sandbox 非対応化済みで 5 fail していた）、`plugin-sdk-subpaths.test.ts`（sandbox サブパス契約除去）、`config-footprint-guardrails.test.ts`（`agents.defaults.sandbox.perSession` 除去）、`schema.help.quality.test.ts`（`tools.sandbox.tools` 除去）、`local-roots.test.ts`（sandboxes ディレクトリ期待値除去）、`path-alias-guards` / `boundary-path`（"sandbox root" → "workspace root"）、`bash-tools.exec.path.test.ts`（sandbox host テスト 2 削除・改名）、`doctor-config-flow.test.ts`（legacy sandbox perSession 警告テスト削除 — 本番 doctor は sandbox 非対応化済み）、`audit-extra.sync.test.ts`（sandbox 前提ケース削除 — 本番は web ツール有効時のみ critical）、`bundled-plugin-naming.test.ts`（`-sandbox` サフィックス除去）、文言・データ差し替え（wizard / config-cli / reply-utils / agent-runner-payloads / reply.triggers / subagents.scope / skills×2 / pdf-tool / splitsdktools / workspace-only-false）。
- スクリプト: `scripts/docs-i18n/localized_links_test.go` の fixture を削除済み sandboxing.md から実在ページ（`/providers/modelstudio`）に差し替え。

### 27.4 設定スキーマの @deprecated 受容と再生成

- `src/config/zod-schema.agent-runtime.ts`: `tools.sandbox` / `agents.defaults.sandbox` / `agents.list[].tools.sandbox` を **`DeprecatedSandboxSchema`（`z.unknown().optional()`、`@deprecated` JSDoc 付き）** に変更 — 受容して無視。
- `pnpm config:schema:gen` で `schema.base.generated.ts` を**再生成**（手編集なし）。sandbox は `{}`（空スキーマ）になり **−1,728 行**。
- `config:docs:gen` で `config-baseline.sha256` 再生成、`docs/gateway/configuration-reference.md` の sandbox 記述も整理（−322 行）。

### 27.5 ドキュメントの掃除（本任）

`docs/` 25 ファイル・約 60 行の sandbox 機能参照（exec host / elevated / exec-approvals / faq / gateway security / secrets / agent-workspace / agent / multi-agent / session-tool / system-prompt / cli security / cli index（`sandbox` コマンド一覧）/ groups / skills / ansible / pi / nodes / plugins architecture（`-sandbox` サフィックス）/ THREAT-MODEL-ATLAS / getting-started / context ほか）を修正。削除済みページへのリンク（`/gateway/sandboxing`・`/tools/multi-agent-sandbox-tools`）も除去。前任の編集ミス（行の欠落残骸・`See  for full details` 等）も併せて修正。

### 27.6 温存したもの・判断を保留したもの

- `src/infra/exec-approvals.ts` — 別バッチ（C）所有。`ExecHost` に `"sandbox"` が残る（exec-approvals 波で解消）。`exec-approval-command-display` / `exec-approval-reply` のテストの host:"sandbox" ケースも同様に保留。
- `src/auto-reply/reply/commands-status.*` — 別バッチ（C）所有（未編集）。
- Dockerfile の `OPENCLAW_INSTALL_DOCKER_CLI` build arg / `docker-compose.yml` の関連コメント — Docker CLI 導入機能として前任の判断で残置（sandbox 単語なし）。
- `src/config/includes.test.ts` の sandbox 受容ケース — @deprecated 受容の回帰テストとして残置。
- `plugin-sdk-subpaths.test.ts` の `expectSourceOmits("registerSandboxBackend")` — 「含まない」検証として残置。
- `test/bun-tier-*.txt` 台帳 — 本波で削除済みテストのパス記録を更新（a1/a3/c3b/c4b。hoisted は Kuraudo 更新のため未編集）。
- UI 生成翻訳（`ui/src/i18n/.i18n/*.tm.jsonl`）— 生成物のため未手編集。
- 無関係の sandbox 単語 — APNs environment（push / nodes / push-apns）、macOS `sandbox-exec`（dispatch-wrapper / exec-wrapper 系）、`browser.noSandbox`（Chromium フラグ）、Google `sandbox.googleapis.com`、xAI code_execution（外部サービス）、macOS VM・外部記事（showcase）。
- `docker-setup.e2e.test.ts` の DENNOU*\* ↔ OPENCLAW*\* 環境変数名の不一致（14 fail）・`audit.test.ts` の browser/CDP/Feishu/Slack 系 14 fail・`dockerfile.test.ts` の Dockerfile 構造 5 fail・`sessions-list-tool` の importActual 非互換・`reply-media-paths` の Windows パス 2 fail — いずれも HEAD 由来の既存赤（sandbox と無関係・環境依存）。

### 27.7 検証ゲート結果

| ゲート                                             | 結果                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/run-tsgo.mjs --noEmit`               | **sandbox 起因 0 件・本波の変更ファイル 0 件**。残エラーは並行バッチ（auth-profiles 削除中）由来のみ                                                                                                                                                                                                                                                                                                  |
| 関連テスト（本波の変更対象・auth 非依存）          | **pass** — local-roots / path-alias-guards / boundary-path / schema.help.quality / bundled-plugin-naming / config-footprint-guardrails / plugin-sdk-subpaths / commands-system-prompt / audit-extra.sync / includes / wizard / docker-build-cache・dockerfile の当該ケース。auth-profiles ロード不能（他バッチ）で実行不可: bash-tools.exec.path / directive 系 / replies 系 / skills / pdf-tool ほか |
| `bun run build`                                    | **auth-profiles バッチの entry 欠落（`src/agents/auth-profiles.runtime.ts`）で停止**（他バッチ由来）。sandbox / tasks entry はビルド設定に残存 0                                                                                                                                                                                                                                                      |
| `oxfmt --check`（本波の変更ファイル 30）           | **全件 pass**                                                                                                                                                                                                                                                                                                                                                                                         |
| `config:schema:gen` / `config:docs:gen`（--write） | 再生成完了・冪等確認済み                                                                                                                                                                                                                                                                                                                                                                              |

### 27.8 変更規模

- 削除: **124 ファイル / 19,097 行**（前任分）＋ `scripts/docker/setup.sh` **−178 行**・`schema.base.generated.ts` **−1,728 行**（本任）
- 修正: テスト約 35 ファイル・docs 25 ファイル・scripts 2 ファイル（本任）＋ 前任の本番参照除去・テスト修正分
- 生成物再生成: `schema.base.generated.ts` / `config-baseline.sha256` / `configuration-reference.md`
- コミット: 未実施（git add / commit / push は本タスクの禁止事項。Kuraudo / コーディネータが並行バッチと合流させること）

### 27.9 セキュリティポスチャ変化（small-model 監査の緩和・レビュー指摘対応）

- `src/security/audit-extra.sync.ts` の small-model 監査（`models.small_params`）の safe 判定が「**web tool オフのみ**」に緩和された（HEAD は `sandbox=all && web off` が safe 条件）。sandbox 撤去により `sandbox=all` を要求できなくなったため、`exposed.length === 0`（web_search / web_fetch / browser のいずれも有効でない）だけで safe となる。
- 影響: **web-off + small model（<=300B params）構成は `critical` → `info`** に変わる。タイトルも `"Small models require sandboxing and web tools disabled"` → `"Small models require web tools disabled"`、remediation の `agents.defaults.sandbox.mode="all"` 指示も除去済み。
- 同様に露出マトリクス（`collectRiskyToolExposureContexts` / `collectExposureMatrixFindings` / `collectLikelyMultiUserSetupFindings`）の `sandbox=...` 表示・`sandbox=all` 前提のガードも除去され、`runtimeUnguarded = runtimeTools.length > 0`（sandbox 状態を問わない）に変更された。open グループで exec / process 系が有効な構成は sandbox の有無にかかわらず risky として報告される。

## 28. exec-approval（exec 承認キュー・/approve）フル許可化（2026-09-24 時点作業・完了）

### 28.1 目的・背景

前任報告では「Phase C（exec-approval）は未着手」だったが、実測の結果、exec-approval は削除済みではなく**現役サブシステム**だった（`src/infra/exec-approvals*.ts` 26ファイル・約12,000行・接続150超）。ファイル削除禁止の制約下では26ファイルの物理削除は不可のため、**承認判定の単一真実源を変更してフル許可化**する最小実装を選択。承認キュー・`/approve`・gateway RPC の器は残るが、承認要求は発生しなくなる（自然休眠）。

### 28.2 変更内容（本番3ファイル）

| ファイル                      | 変更                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/infra/exec-approvals.ts` | `requiresExecApproval()` を常に `false` を返すよう変更（パラメータは呼び出し互換のため維持）。3ゲート（gateway/node/system-run）全てが承認を要求しなくなる。`ExecHost` から `"sandbox"` を除去（`normalizeExecHost` も gateway/node のみ受理）。 |
| `src/agents/exec-defaults.ts` | デフォルト `security` を `"deny"` → `"full"` に変更（明示設定は尊重・未設定時のみ）。fail-closed デフォルトでは承認なしで拒否されるため、フル許可にはこの変更が必須。                                                                            |
| `tsdown.config.ts`            | `"agents/auth-profiles.runtime"` entry を除去（削除済みファイルを指して build が `UNRESOLVED_ENTRY` で停止していた。§26 の残務として対応）。                                                                                                     |

### 28.3 テストの追従（6ファイル）

- `src/infra/exec-approvals-policy.test.ts` — `requiresExecApproval` の期待値 `true` → `false`（2件）。
- `src/infra/exec-approvals-allow-always.test.ts` — 同上（2件。allowlist評価自体の miss 検証は維持）。
- `src/node-host/exec-policy.test.ts` — 「承認要求で拒否」2件を「許可」に書き換え。`security=deny` 明示設定の拒否テストは維持（pass）。
- `src/node-host/invoke-system-run.test.ts` — `expectApprovalRequiredDenied` ヘルパーを `allowlist-miss` 期待に変更＋個別1件。allowlist明示設定時の拒否は `allowlist-miss` として継続検証。
- `src/infra/exec-approval-command-display.test.ts` / `exec-approval-reply.test.ts` — `host: "sandbox"` → `"gateway"`（sandbox撤去で残った参照の整理。§27.6 の既知残骸を解消）。

### 28.4 温存したもの・判断を保留したもの

- **`/approve` コマンド**（`commands-approve.ts`）— exec と plugin の共有コマンドのため exec 側だけ外すのは危険。承認要求が発生しなくなれば自然休眠するため残置。
- **gateway RPC**（`exec.approval.*` / `exec.approvals.*`）— 同上。受信側の器として残置。
- **承認キュー・承認マネージャ・forwarder・reply・channel-runtime 等** — ファイル削除禁止のため残置。`requiresExecApproval=false` により到達不能（dead path）だが、tsgo 0・テスト pass に影響なし。将来の物理削除は別タスク。
- **`security=deny` / `security=allowlist` 明示設定** — ユーザーが明示設定した場合は従来どおり拒否する（fail-closed の尊重）。デフォルトのみ `full` に変更。
- **セッション整合性ガード・門番（`session-gatekeeper`）** — 別物として一切触っていない。
- **`src/config/` スキーマ4ファイル** — 競合回避のため未編集。`cfg.auth` の `@deprecated` 受容は Kuraudo が後でまとめて適用（本報告の別項に変更案を記載）。

### 28.5 KASOU保護

- 明示的な `security` / `ask` 設定は従来どおり尊重される（デフォルトのみ変更）。
- `session-gatekeeper`・`session-integrity-guard` とは独立した経路のため、本番セッション保護に影響なし。
- `evaluateSystemRunPolicy` の `security=deny` 経路は温存（明示無効化は効く）。

### 28.6 検証結果

| ゲート                               | 結果                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/run-tsgo.mjs --noEmit` | **0 errors**（維持）                                                                                                                                 |
| 関連テスト                           | **pass** — exec-policy 13件・approvals-policy/allow-always 93件・invoke-system-run 114件・host-gateway/node/exec-defaults 11件                       |
| 既存赤（本タスクと無関係）           | `exec-approvals-store.test.ts` 9件・`exec-approvals-config.test.ts` 1件（`.openclaw` vs `.dennou-aibou` パス不一致・HEAD由来。触っていないファイル） |
| `bun run build`                      | auth-profiles entry 問題は解消。残りは memory-host-sdk のテスト型エラー（別バッチ所有・スコープ外）                                                  |
| `bun run ui:build`                   | **pass**（2.44s）                                                                                                                                    |
| `oxfmt --check`（変更9ファイル）     | **全件 pass**                                                                                                                                        |

### 28.7 変更規模

- 本番: 3ファイル（`exec-approvals.ts` / `exec-defaults.ts` / `tsdown.config.ts`）
- テスト: 6ファイル（期待値更新のみ・新規テストなし）
- 削除ファイル: 0（ファイル削除禁止のため。26ファイルの器は残置し、承認要求のみ停止）
- コミット: 未実施（git add / commit / push は本タスクの禁止事項）

## 29. memory-host-sdk 完全撤去・残存参照の剥がし（2026-09-24 時点作業・完了）

### 29.1 目的・背景

`memory-core` プラグインは先行波（§19）で削除済みであり、有効プラグインに memory 種別は存在しなかった。しかし `src/memory-host-sdk/`（83ファイル/10,559行）および `packages/memory-host-sdk/`（84ファイル）がツリーに残存し、ビルドやテスト台帳でノイズとなっていた。本作業では、先行して物理削除された 167 ファイルに対する残存参照を本番コード・テスト・設定・台帳から完全に剥がし、自立可能な最小構成へ移行した。

### 29.2 削除規模

- `src/memory-host-sdk/`（83 ファイル / 10,559 行）: 物理削除済み
- `packages/memory-host-sdk/`（84 ファイル）: 物理削除済み
- 死んだ runtime 経路モジュールの追加削除（4 ファイル）:
  - `src/plugins/memory-runtime.ts`
  - `src/gateway/server-startup-memory.ts`
  - `src/plugins/memory-runtime.test.ts`
  - `src/gateway/server-startup-memory.test.ts`
- 合計削除: 171 ファイル

### 29.3 剥がした参照一覧と対応

| ファイル                                              | 参照内容                                               | 対応                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/commands/status.memory-types.ts`（新規）         | 共有型のみ                                             | `Tone`, `MemoryProviderStatus`, `EmbeddingInput` 等の型のみローカル化（3関数は `status.command.text-runtime.ts` へ配置）                                                      |
| `src/commands/status.command.ts`                      | `Tone` 型 import                                       | `status.memory-types.ts` へ差し替え                                                                                                                                           |
| `src/commands/status.command.text-runtime.ts`         | status ヘルパー3関数                                   | `status-format.ts` から3関数（`resolveMemoryVectorState`/`resolveMemoryFtsState`/`resolveMemoryCacheSummary`）を逐語移設                                                      |
| `src/commands/status.scan.shared.ts`                  | `MemoryProviderStatus` 型 import                       | `status.memory-types.ts` へ差し替え                                                                                                                                           |
| `src/commands/status.scan.deps.runtime.ts`            | `getActiveMemorySearchManager`, `MemoryProviderStatus` | 型差し替え、マネージャ取得は `{ manager: null }` のダミー解決に変更                                                                                                           |
| `src/plugins/memory-embedding-providers.ts`           | `EmbeddingInput` 型 import                             | `status.memory-types.ts` へ差し替え                                                                                                                                           |
| `src/plugins/memory-state.ts`                         | probe/status 型 import                                 | `status.memory-types.ts` へ差し替え                                                                                                                                           |
| `src/commands/doctor-state-integrity.ts`              | `resolveMemoryBackendConfig` import                    | 存在しないため import 削除、警告抑止判定は `false` を返すよう変更（理由をコメント明記）                                                                                       |
| `src/agents/pi-hooks/query-keywords.ts`（新規）       | `extractKeywords`, `isQueryStopWordToken`              | `src/agents/pi-hooks/compaction-safeguard-quality.ts` 用に純関数・定数のみローカル化（828行の全文は不要）                                                                     |
| `src/agents/pi-hooks/compaction-safeguard-quality.ts` | query ヘルパー import                                  | `./query-keywords.js` へ差し替え                                                                                                                                              |
| `src/agents/memory-search.ts`                         | multimodal ヘルパー import                             | 他モジュールから参照されているためファイル温存。`isMemoryMultimodalEnabled`, `normalizeMemoryMultimodalSettings`, `supportsMemoryMultimodalEmbeddings` 等を内部にローカル定義 |
| `src/gateway/server-startup.ts`                       | `startGatewayMemoryBackend`                            | import および startup での呼び出しを除去                                                                                                                                      |
| `src/plugins/loader.ts`                               | `memoryRuntime` フィールド・代入                       | memoryRuntime スロットは温存（非activate時のスナップショット復元契約を維持）                                                                                                  |
| `src/cli/run-main.ts`                                 | `closeActiveMemorySearchManagers`                      | 動的 import と呼び出しを除去、`closeCliMemoryManagers` を関数ごと呼び出しごと完全削除                                                                                         |
| `src/agents/pi-embedded-runner/compaction-hooks.ts`   | `getActiveMemorySearchManager`                         | import および compaction 後の memory sync 呼び出しを除去                                                                                                                      |

### 29.4 raw-chat-search プラグインの扱い（温存）

- `extensions/raw-chat-search/` は raw-chat 履歴検索のための現役・温存プラグインであり、壊さない方針を徹底。
- `extensions/raw-chat-search/src/runtime-core.local.ts` を新設し、`tools.ts` が必要としていた `readNumberParam`, `readStringParam`, `resolveSessionAgentId`, `AnyAgentTool` をコアから直接ローカル import して再エクスポート。
- `extensions/raw-chat-search/src/tools.ts` から `memory-host-sdk/runtime-core.js` への依存を解消。

### 29.5 テスト・設定・台帳の整合

- `src/cli/run-main.exit.test.ts`: `closeActiveMemorySearchManagersMock` および `vi.mock("../plugins/memory-runtime.js")` を削除。終了時のメモリマネージャ呼び出しテストを除去し、他の終了コード検証テスト（5件）は完全維持（pass）。
- `src/agents/pi-embedded-runner/compact.hooks.harness.ts`: `vi.doMock("../../plugins/memory-runtime.js")` および死に mock を削除。
- `src/agents/pi-embedded-runner/compact.hooks.test.ts`: compaction 後のメモリ同期マネージャ呼び出し検証を整理。
- `tsconfig.plugin-sdk.dts.json`: `include` から `"packages/memory-host-sdk/src/**/*.ts"` を除去。
- `test/bun-tier-c4b-known-failing.txt`: timeout リストから削除済み4ファイルを削除、ヘッダ件数を実数（62件 failing + 11件 helper-only = 73件）に修正。
- `test/bun-tier-a3-known-failing.txt`: 削除済みテスト 12 ファイルを削除、ヘッダ件数を実数（559件 not reached）に修正。

### 29.6 検証結果

| ゲート           | 結果                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 残存参照チェック | 削除モジュールへの **import** 参照は0件（`resolveMemoryBackendConfig` は `memory-state.ts` のプラグインAPI型定義＋テストmockとして残存） |
| `tsgo --noEmit`  | **0 errors (exit 0)**                                                                                                                    |
| `oxfmt --check`  | 変更対象全ファイル pass                                                                                                                  |
| 台帳件数         | `bun-tier-c4b`: 実数一致（62件） / `bun-tier-a3`: 実数一致（559件）                                                                      |

## 30. WebUI jsdom / browser テスト撤去（§23.2 候補7・波3・2026-09-29 時点作業）

### 30.1 目的・背景

§23.2 候補7（56ファイル / 約14,000行・削除確定）の実施波。WebUI は `*.node.test.ts`（実機寄り検証：バンドル静的走査＋子プロセスプローブ等）および ChromeDevTools 直接確認の体制が確立しており、jsdom 模倣の偽グリーンを生む旧単体テストは不要（ユーザー裁定 2026-09-21、メモリ #1969 / #1976）。
DEBLOAT 台帳の「browser テスト10本は温存要判断」は本波で判断：`*.node.test.ts` のみ温存し、browser テストも撤去（KASOU に Playwright/Chromium が無く `pnpm test:ui` を壊す・win32 自スキップのため携帯性なし。実機検証は node テスト＋ChromeDevTools に一本化）。

### 30.2 削除内容（53ファイル / 10,634行・`git diff --numstat` 実測）

| 区分                 | 内容                                                                                                                                        | 数                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| jsdom テスト         | `ui/src/**` の `*.test.ts`（`*.node.test.ts`・`*.browser.test.ts` を除く全件。`controllers/`・`views/`・`chat/`・`i18n/test/translate` 等） | 38ファイル / 7,612行   |
| browser テスト       | `ui/src/**` の `*.browser.test.ts` 全件（`webui-real-browser-load`・`chat`・`config`・`navigation`・`sidebar-status` 等）                   | 10ファイル / 約1,800行 |
| 孤児ヘルパー         | `ui/src/ui/test-helpers/app-mount.ts`（browser テスト専用・他参照0件実測）＋空化 `test-helpers/`                                            | 1ファイル / 47行       |
| 孤児スナップショット | `ui/src/ui/__screenshots__/`（browser テスト用ベースライン PNG 4枚）＋空化 `ui/src/i18n/test/`                                              | 4ファイル              |

### 30.3 設定・参照の整合（修正4ファイル）

- `ui/vitest.config.ts`：`unit`（jsdom）・`browser`（Playwright）プロジェクトを撤去し `unit-node` のみに。`@vitest/browser-playwright` import も除去。`unit-node` の jsdom 環境・setupFiles は変更なし（node テストの既存前提を維持）。
- `vitest.shared.config.ts`：削除済み ui テストへの include 13行を除去。`ui/src/ui/chat/**/*.test.ts` と node テスト3行は温存（温存ファイルに現にマッチするため）。
- `package.json`：`test:ui:e2e` を削除（対象 `webui-real-browser-load.browser.test.ts` が存在しなくなったため。他参照0件実測）。`test:ui` は変更なし。
- `test/vitest-ui-package-config.test.ts`：ui プロジェクト数 assertion を 3→1 に更新。
- 温存：`ui/src/test-helpers/lit-warnings.setup.ts`・`storage.ts`（node テストが使用中）、`vitest.ui.config.ts`（include は温存 node テストにマッチ、関連 assertion 変更不要）、ui 側 `jsdom` devDependency（`unit-node` 環境が使用中のため温存）。

### 30.4 温存（15ファイル・絶対厳守）

`ui/src/ui/` 直下9本（`app-gateway`・`app-gateway.sessions`・`app-lifecycle-connect`・`app-lifecycle`・`app-render.helpers`・`app-tool-stream`・`gateway`・`storage`・`webui-bundle-browser-load`）＋ `chat/` 3本（`export`・`slash-command-executor`・`slash-commands`）＋ `controllers/config/form-utils` ＋ `views/` 2本（`config-form.search`・`overview`）。全件 `*.node.test.ts`。

### 30.5 検証結果

| ゲート                                                                                         | 結果                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run ui:build`                                                                             | **pass**（`✓ built in 1.72s`）                                                                                                                                                                                                                                                                   |
| `bun run build`                                                                                | **pass**（`OPENCLAW_A2UI_SKIP_MISSING=1` 付き。素の `bun run build` は `canvas:a2ui:bundle` で失敗するが、`vendor/a2ui`・`apps/shared/OpenClawKit/Tools/CanvasA2UI` が本ツリーに不在の既存要因であり本波と無関係）                                                                               |
| 温存 node テスト（`pnpm --dir ui test`）                                                       | 14/15ファイル・182/183件 pass。残1件（`app-gateway.node.test.ts > preserves approval prompts...`）は `execApprovalQueue` 空振りで単独再実行でも再現する既存失敗。対象テスト・SUT（`app-gateway.ts`）とも本波 diff 外であり、§28 exec-approval フル許可化波の残務として未対応（本波スコープ外）。 |
| 設定 assertion（`vitest-ui-package-config`・`vitest-projects-config`・`vitest-scoped-config`） | 3ファイル・61/61 pass                                                                                                                                                                                                                                                                            |
| `oxfmt --check`（変更4ファイル＋本節）                                                         | TS 3ファイル pass。`package.json` のみ flag されるが CRLF 改行の既存状態が原因であり本波 diff（1行削除）とは無関係のため改行変換は実施せず                                                                                                                                                       |
| `pnpm exec tsgo --noEmit`                                                                      | **0 errors (exit 0)**                                                                                                                                                                                                                                                                            |
| 残存参照                                                                                       | 削除ファイルへの参照0件（`vitest.shared.config.ts`・`package.json`・非テストソース・workflows・docs を実測）                                                                                                                                                                                     |

残務：ui 側 `playwright`・`@vitest/browser-playwright` devDependencies は browser プロジェクト撤去により未使用化（lockfile 再生成を伴うため本波では温存）。`src/scripts/test-projects.test.ts` の ui routing 例示（`views/channels.test.ts`）は削除済みパスだが routing ロジック自体は有効のため温存。

## 31. 生成系・realtime・スタブ・死スクリプト・skills 残骸撤去（§23.2 候補 5・6・9・10・11・12・13・14・波1/波2・2026-09-30 時点作業）

### 31.1 目的・背景

§23.2 候補5（生成系残骸 `src/{image,music,video,media}-generation/`）・候補6（`extensions/google`・`extensions/openai` のメディア生成プロバイダー登録）・候補9（realtime 系）・候補10（`src/qa-e2e/`）・候補11（テスト専用 `src/docs/`・`src/i18n/`・`src/scripts/`）・候補12（package.json 死参照）・候補13（死にスクリプト群）・候補14（`skills/` 内削除済み機能）の実施波。生成系ツール（`image_generate` / `music_generate` / `video_generate`）は §22 で完全削除済みであり、本波では registry・runtime・plugin-sdk・contracts・manifest を含む残存面を完全撤去した（sandbox 波と同様、API 面も残さない方針）。

### 31.2 削除内容（87ファイル・`git status` 実測）

| 区分                        | 内容                                                                                                                                                                                                                                                                                                 | 数         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 生成系 src                  | `src/image-generation/`（9）・`src/music-generation/`（9）・`src/video-generation/`（11）・`src/media-generation/`（1）                                                                                                                                                                              | 30ファイル |
| realtime src                | `src/realtime-transcription/`（2）・`src/realtime-voice/`（2）                                                                                                                                                                                                                                       | 4ファイル  |
| スタブ・テスト専用          | `src/qa-e2e/`（9）・`src/docs/`（1）・`src/i18n/`（1）・`src/scripts/`（5）                                                                                                                                                                                                                          | 16ファイル |
| plugin-sdk 生成系・realtime | `image-generation[.ts,-core.ts,-core.auth.runtime.ts]`・`music-generation[.ts,-core.ts]`・`video-generation[.ts,-core.ts]`・`media-generation-runtime-shared.ts`・`realtime-transcription.ts`・`realtime-voice.ts`                                                                                   | 10ファイル |
| 拡張プロバイダー            | google: image/music/video-generation-provider＋各 test（6）。openai: image/video/realtime-transcription/realtime-voice-provider＋各 test（7、内訳は本文参照）                                                                                                                                        | 13ファイル |
| scripts 死スクリプト        | `firecrawl-compare.ts`・`readability-basic-compare.ts`・`zai-fallback-repro.ts`・`phase3-delete.ps1`・`reindex.ps1`・`cron_usage_report.ts`・`sqlite-vec-smoke.mjs`・`test-voicecall-closedloop.mjs`（voice-call 特化のため本体も削除）・`qa-e2e.ts`（`src/qa-e2e` のランナー・`qa:e2e` と共に削除） | 9ファイル  |
| skills                      | `skills/clawhub/`・`skills/voice-call/`・`skills/sherpa-onnx-tts/`（bin 含む）                                                                                                                                                                                                                       | 4ファイル  |
| CLI                         | `src/cli/qa-cli.ts`（`register.subclis.ts` の `qa` 登録と共に撤去）                                                                                                                                                                                                                                  | 1ファイル  |

注：`scripts/debug-claude-usage.ts` は指定時点で既に不在（削除不要）。`test:voicecall:closedloop` の参照先は存在していたが voice-call 特化スクリプトのため本体ごと削除。`scripts/reindex.ps1` は他参照0件実測（`reindex` 文字列一致は memory 系 config 文言のみ）。config schema の `imageGenerationModel` 等の文字列キー・`PluginManifestOnboardingScope` の `"image-generation"` スコープ・`sherpa-onnx-offline` バイナリ参照（STT runtime）は削除対象の import を持たないため温存。

### 31.3 参照後始末（修正約40ファイル）

- `src/plugins/types.ts`：5 import・5 provider 型（`RealtimeTranscription/Voice`・`Image/Video/MusicGenerationProviderPlugin`＋Entry 型）・5 Api メソッド（`register*Generation/Provider`・`registerRealtime*`）を除去。`registerMediaUnderstandingProvider` は温存。
- `src/plugins/registry.ts`・`registry-empty.ts`・`manifest.ts`・`api-builder.ts`・`captured-registration.ts`・`loader.ts`・`status.ts`・`channel-plugin-ids.ts`・`manifest-registry.ts`：生成系・realtime の登録関数・レジストリ欄・manifest contracts 欄・capability kind を除去。
- `src/plugins/runtime/index.ts`・`types-core.ts`：`imageGeneration`・`videoGeneration`・`musicGeneration` facade を除去。`mediaUnderstanding`・`stt`・`modelAuth` は温存。
- `src/plugins/capability-provider-runtime.ts`・`bundled-capability-runtime.ts`：capability キー・取込分岐を memory/mediaUnderstanding のみに縮小。
- `src/plugins/contracts/registry.ts`・`speech-vitest-registry.ts`・`inventory/bundled-capability-metadata.ts`：5 系統の contract registry・loader・snapshot 欄を除去（mediaUnderstanding 系のみ温存）。
- `extensions/google/index.ts`・`test-api.ts`・`openclaw.plugin.json`：lazy image provider・music/video 登録・contracts 3件を除去（mediaUnderstanding・webSearch 温存）。`extensions/openai/index.ts`・`api.ts`・`register.runtime.ts`・`test-api.ts`・`openclaw.plugin.json`：image/video/realtime 登録・contracts 4件を除去。`extensions/openai/index.test.ts` の画像生成3テストも除去（provider 本体削除のため）。
- テスト系：`test/helpers/plugins/` 4件・`runtime/index.test.ts`・`status.test.ts`・`status.test-helpers.ts`・`runtime.test.ts`・`registry.contract.test.ts`・`bundled-capability-metadata.test.ts`・`capability-provider-runtime.test.ts`・`manifest-registry.test.ts`・`gateway/server-plugins.test.ts`・`test-helpers.plugin-registry.ts`・`hooks.test-helpers.ts`・`test-utils/channel-plugins.ts`・`test/setup-openclaw-runtime.ts`・`bot-native-commands.registry.test.ts`・google/openai の contract test 2件から削除済み欄を除去。`attempt.spawn-workspace.test-support.ts` の `image-generation/runtime.js` mock を除去。
- CLI：`register.subclis.ts` の `qa` エントリ＋対応 test mock・assertion を除去（`docs-cli` は `src/docs/` に依存しないため温存）。
- doctor：`doctor-plugin-manifests.ts` の `LEGACY_MANIFEST_CONTRACT_KEYS` から `imageGenerationProviders` を除去。
- 設定・基盤：`scripts/lib/plugin-sdk-entrypoints.json` から5エントリ除去。`package.json` から exports 12件（`image/music/video-generation[-core,-runtime]`・`media-generation-runtime[-shared]`・`realtime-*`）＋ scripts 9件（`test:live:media*` 4・`test:docker:live-acp-bind*` 3・`test:voicecall:closedloop`・`qa:e2e`）を除去。`vitest.tooling.config.ts`・`vitest.unit-paths.mjs`・`vitest-scoped-config.test.ts` の `src/scripts` パターンを除去。`docs/.generated/plugin-sdk-api-baseline.sha256` を再生成（`--check` pass 確認済み）。

### 31.4 検証結果

| ゲート                               | 結果                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/run-tsgo.mjs --noEmit` | **exit 0**（エラー出力なし・本波内1回のみ実行）                                                                                 |
| `oxfmt --check`（変更59ファイル）    | **pass**（5件 flag→write 整形後に全件 pass）                                                                                    |
| `plugin-sdk:api:check`               | **pass**（baseline 再生成後）                                                                                                   |
| 残存参照                             | 削除モジュールへの import・re-export・登録呼び出し0件（`grep` 実測。`tool-image-generation` はテスト fixture のパス文字列のみ） |

残務：`plugin-sdk:check-exports`（`sync-plugin-sdk-exports.mjs --check`）は本波前から失敗しており本波でも失敗のまま（`entrypoints.json` に対して `channel-streaming`・`conversation-binding-runtime`・`simple-completion-runtime` 等の旧波由来とみられる stale exports が `package.json` に残存。本波の12件は除去済み。別波で sync を回すか判断要）。`test/bun-tier-*.txt` 台帳に削除済みテストパス（`src/image-generation/*`・`src/music-generation/*`・`src/video-generation/*`・`src/docs/*`・`src/i18n/*`・`src/scripts/*` 等）が残る（§27.6 系タスクで更新）。`docs/` 配下から削除済み provider・スクリプトへの言及が残る可能性あり（本波スコープ外）。 |

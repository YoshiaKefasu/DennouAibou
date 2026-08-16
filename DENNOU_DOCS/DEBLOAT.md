# DEBLOAT — 大規模削除クリーンアップ計画

> 最終更新: 2026-08-16
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

※ **分類の正確性注記（Phase 1 修正版）**: `microsoft` は **モデルプロバイダーではない**。`extensions/microsoft/index.ts` は `api.registerSpeechProvider()` を呼ぶ **TTS スピーチプロバイダー**（`@openclaw/microsoft-speech`）。削除自体は変わらないが、docs 分類（Phase 5）では msteams チャンネル（残す）の言及と混同しないこと。`microsoft-foundry` はモデルプロバイダー（docs 言及 0 件）。

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

| リスク | 対策 |
|---|---|
| コアの共有 API タイプ（`anthropic-messages` 等）を誤って削除 | 共有タイプは残す。削除前に grep で使用箇所を全て確認 |
| KASOU 設定が未使用プロバイダーを参照 | Phase 1 で `openclaw.json` を確認。デフォルトモデル・fallback は Google / OpenAI のみだが、`auth.profiles` に `openrouter:default` / `kilocode:default` が残留 → Phase 6 で除去 |
| gateway 起動時に未登録プロバイダーの auth.profiles でエラー | Phase 1 で起動テストし、エラーが出る場合は profile 除去を Phase 6 より前倒し |
| plugin-sdk facade の type-import で `pnpm build:plugin-sdk:dts` が失敗 | `dennou-removed-plugin-facades.d.ts` に declare module を追加（既存パターン）。**ollama は `api.js` と `runtime-api.js` の 2 エントリ必要**（5.7 章） |
| 上流 `[SYNC]` で削除フォルダが復活 | merge 時の再削除運用を確立。削除対象フォルダの一覧を本ドキュメントで管理 |
| デフォルトモデル文字列（`anthropic/claude-*`）が参照エラー | モデル名は文字列なので残す。プロバイダー登録と独立 |
| ビルドが extension の型を参照 | Phase 4 でクリーンビルド。失敗箇所を特定して修正 |
| メモリ（embedding）設定が削除プロバイダーに依存 | **修正（Phase 1）**: ollama embedding は `plugin-sdk/ollama-runtime.ts` の eager 定数経由で extensions/ollama に依存している（モデルプロバイダーとは独立ではない）。Phase 2 で embedding path を除去（5.11 章）。mistral 等の他 embedding backend はコア自己完結なので影響なし |
| コアの削除対象プロバイダー専用コードを誤って削除（LIVE コード） | 5.12 章の分類に従う。minimax-stream-wrappers / moonshot-stream-wrappers / minimax-vlm / anthropic-vertex-stream / provider-usage.fetch.minimax は **本番 import あり**（kept の google / openai が利用）— 削除しない |
| 契約テストが削除対象 extension を import | 5.13 章の fixture（provider-runtime / provider-discovery / provider-auth contract）を google / openai に書き換え（RED 解消済み）。`plugin-registration.*.contract.test.ts` は削除済み manifest を要求し FAIL したため、死んだ provider 契約テスト 25 + 11 ファイルを削除（Phase 4 / 2026-08-16 フォローアップ） |
| 将来また使いたくなる | git 履歴から復元可能。必要なら別ブランチで退避する |
| テストが削除対象プロバイダーをモック参照 | テストデータは文字列なので基本影響なし。影響あるテストのみ修正 |
| KASOU `tts` 設定が削除対象（elevenlabs）を参照 | Phase 6 で `tts` 設定の elevenlabs ブロックを除去。除去後の TTS 利用可否を確認 |
| extensions/ ルートの live-test が削除対象を import | `extensions/music-generation-providers.live.test.ts` / `video-generation-providers.live.test.ts` はフォルダ削除では消えない — Phase 3 で明示削除（`vydra` import は存在しない stale） |

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

- 5.13 章の「plugin-registration.* は仮想ケースなので壊れない」が **実測で否定**（12 ファイルが削除済み manifest を要求し FAIL）
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


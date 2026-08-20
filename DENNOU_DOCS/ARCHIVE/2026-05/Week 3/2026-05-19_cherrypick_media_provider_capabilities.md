# [SYNC] Media Provider Capabilities (cherry-pick)

**上流コミット:** `cd5b1653f6`
**DennouAibou:** `4ea02a3139`
**日付:** 2026-05-19

## 変更内容

各プロバイダーが動画・音楽の生成能力（`generate`/`imageToVideo`/`videoToVideo`/`edit`）を
明示的に宣言する仕組みに変更。従来は数値の有無から暗黙推測していた。

## 取り込んだプロバイダー（5つ）

- **xAI（Grok）** — 動画
- **Runway** — 動画
- **OpenAI（Sora）** — 動画
- **Google** — 動画 + 音楽
- **Comfy** — 動画 + 音楽

## スキップしたプロバイダー（7つ）

Alibaba/Qwen、BytePlus、Fal、Minimax、Together、Vydra — 元コード維持。
能力宣言がないため `generate` モードのみ利用可能。

## あわせて修正

- `types.agent-defaults.ts`: `includeSystemPromptSection` 重複削除
- `video-generate-tool.actions.ts`: `listSupportedVideoGenerationModes` import追加

## コードレビュー後の修正（`9104056649`）

コードレビューでBLOCKER/BUG計6件発見 → 全件修正。

### Fix 1（🚨 HIGH）
`src/video-generation/runtime.ts:72` — override解決がextensions側の間違ったファイルに当たってた。
→ `const caps = provider.capabilities.generate ?? provider.capabilities;`

### Fix 2（🚨 HIGH）
`src/agents/tools/video-generate-tool.ts:271` — 入力バリデーションが新形式プロバイダーで効かない。
→ 同上のフォールバックパターン。

### Fix 3（⚠️ MED）
`src/video-generation/duration-support.ts:21-28` — duration解決が新形式プロバイダーで動かない。
→ `modeCaps = caps?.generate ?? caps;`

### Fix 4（⚠️ MED）
`src/agents/tools/video-generate-tool.actions.ts:24` + `music-generate-tool.actions.ts:24` — スキッププロバイダーの能力表示が空。
→ `const generate = provider.capabilities.generate ?? provider.capabilities;`

### Fix 5（⚠️ MED）
`extensions/video-generation-core/src/runtime.ts` — 誰も使ってない死んだ重複を削除（`a6482b7fd4`）。
SDKのentry pointは`src/plugin-sdk/video-generation-core.ts`から`src/video-generation/`を参照しており影響なし。

### パターン
全て同じ修正: `const caps = provider.capabilities.generate ?? provider.capabilities;`
更新プロバイダーでは`.generate`を、スキッププロバイダーでは平坦なcapabilitiesを読む。

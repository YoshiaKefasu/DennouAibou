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

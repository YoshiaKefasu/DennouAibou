# 電脳架電（Dennou Kaden）通話パイプライン設計仕様書

## 1. 目的と概要

Discord のボイスチャンネルを活用し、Kasou（電脳相棒）と Yosia が双方向音声通話（電話）を行えるシステムを構築する。
複雑な独自インフラや外部アプリ新設を避け、すでに存在する Discord 公式通話機能（`@discordjs/voice`）と、既存の単一不滅マスターセッション（`agent:main:main`）を KISS（Keep It Simple, Stupid）原則で結合する。

---

## 2. アーキテクチャとパイプライン

```text
[Yosia のマイク入力 (Discord Voice)]
         │
         ▼
[DiscordVoiceManager (受信 & 1000ms無音検知)]
         │
         ▼ (WAV 一時ファイル: mkdtemp 30分TTL)
[STT: mediaUnderstanding.transcribeAudioFile]
         │
         ▼ (テキストプロンプト)
[in-process: agentCommandFromIngress]
 (sessionKey: entry.route.mainSessionKey ?? entry.route.sessionKey)
         │
         ▼ (返答テキスト)
[TTS: OpenRouter /api/v1/audio/speech (Fish Audio S2.1)]
 (model: fish-audio/s2.1-pro-free:free / fetchWithSsrFGuard)
         │
         ▼ (一時 MP3 音声ファイル)
[createAudioResource ＆ entry.player.play()]
 (Discord ボイスチャンネルで即座に音声再生！)
```

---

## 3. 実装の要件と技術的解決（KISS 原則）

### 3.1 依存ライブラリの補強（音声暗号化と FFmpeg）

- `@discordjs/voice` の音声送信（`player.play()`）において、Discord サーバーが要求する暗号化モード（`aead_xchacha20_poly1305_rtpsize` 等）に対応するため、純 JS 製の `@noble/ciphers`（`^2.1.1`）を `extensions/discord/package.json` の `dependencies` に追加し、`pnpm-lock.yaml` を更新する。
- 音声変換には環境上の `ffmpeg`（KASOU 実機 `/usr/bin/ffmpeg` 確認済み）を使用する。

### 3.2 セッションと記憶の一本化（マスターセッション直接ルーティング）

- `DiscordVoiceManager.processSegment` における `agentCommandFromIngress` の呼び出し時、`sessionKey` に `entry.route.mainSessionKey ?? entry.route.sessionKey` を指定し、最初から Kasou のマスターセッション（`agent:main:main`）へ直接ルーティングする（プロジェクト規則 #2032 準拠）。
- これにより、ボイスチャンネルテキストとのセッション共有は放棄しつつ、Telegram DM や Discord DM のテキストと完全に連続した文脈を保つ。JSONL の事後合体や親リンク破損リスクを構造的に排除する。
- テストフィクスチャ（`manager.e2e.test.ts`）にも `mainSessionKey` を反映する。

### 3.3 音声返答（Egress）とバージイン

- `DiscordVoiceManager.processSegment` において、`agentCommandFromIngress` から得られた返答テキストを OpenRouter 音声合成 API（`https://openrouter.ai/api/v1/audio/speech`、モデル: `fish-audio/s2.1-pro-free:free`、`fetchWithSsrFGuard` 使用）経由で一時ファイル（`mkdtemp` 30分後自動クリーンアップ）として音声化し、`createAudioResource` で再生する。
- API キーは `OPENROUTER_API_KEY`（または `channels.discord.voice.tts`）から解決する。
- ユーザーの発話が始まった場合は、既存の `entry.player.stop(true)` により再生を即時中断し、聞き役に回る。`VoiceSessionEntry` に `generation: number` を保持し、発話開始時にインクリメント、再生直前に不一致なら破棄して遅延再生の被りを防ぐ。
- 万が一 TTS や音声再生が失敗した場合は、チャンネルへのテキスト投稿に安全にフォールバックし、通話キューを停止させない（フェイルオープン）。

---

## 4. 変更対象ファイル

- `extensions/discord/package.json`: `@noble/ciphers`（`^2.1.1`）追加
- `pnpm-lock.yaml`: 依存関係のロック
- `extensions/discord/src/voice/manager.ts`: `mainSessionKey` ルーティング、世代管理、TTS 音声生成・再生パイプライン
- `extensions/discord/src/voice/manager.e2e.test.ts`: ルーティングおよび再生モックのテスト同期

---

## 5. 移行・検証ゲート

1. `bun --check`: 型エラー 0 件。
2. 機械判定: `bun -e 'const r=require("@discordjs/voice").generateDependencyReport(); if(r.includes("@noble/ciphers: not found")) process.exit(1)'`: 暗号化ライブラリが正常認識されること。
3. `bun test extensions/discord`: ボイス関連テストの通過。
4. `bun fmt --check`: フォーマット準拠。

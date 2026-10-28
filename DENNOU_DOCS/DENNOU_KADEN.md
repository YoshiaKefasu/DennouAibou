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
         ▼ (WAV 一時ファイル)
[STT: mediaUnderstanding.transcribeAudioFile]
         │
         ▼ (テキストプロンプト)
[in-process: agentCommandFromIngress]
 (sessionKey: entry.route.mainSessionKey 経由で agent:main:main へ直接ルーティング)
         │
         ▼ (返答テキスト)
[TTS: Fish Audio S2.1 (OpenRouter / audio/speech API)]
         │
         ▼ (一時 MP3/WAV 音声ファイル)
[createAudioResource ＆ entry.player.play()]
 (Discord ボイスチャンネルで即座に音声再生！)
```

---

## 3. 実装の要件と技術的解決（KISS 原則）

### 3.1 依存ライブラリの補強（音声暗号化と FFmpeg）

- `@discordjs/voice` の音声送信（`player.play()`）において、Discord サーバーが要求する暗号化モード（`aead_xchacha20_poly1305_rtpsize` 等）に対応するため、純 JS 製の `@noble/ciphers`（`^2.1.1`）を `extensions/discord/package.json` の `dependencies` に追加する。
- 音声変換には環境上の `ffmpeg`（KASOU 実機 `/usr/bin/ffmpeg` 確認済み）を使用する。

### 3.2 セッションと記憶の一本化（マスターセッション直接ルーティング）

- `DiscordVoiceManager.processSegment` における `agentCommandFromIngress` の呼び出し時、`sessionKey` に `entry.route.mainSessionKey` を指定し、最初から Kasou のマスターセッション（`agent:main:main`）へ直接ルーティングする（プロジェクト規則 #2032 準拠）。
- これにより、ボイスチャンネルテキストとのセッション共有は放棄しつつ、Telegram DM や Discord DM のテキストと完全に連続した文脈を保つ。JSONL の事後合体や親リンク破損リスクを構造的に排除する。
- テストフィクスチャ（`manager.e2e.test.ts`）にも `mainSessionKey` を反映する。

### 3.3 音声返答（Egress）とバージイン

- `DiscordVoiceManager.processSegment` において、`agentCommandFromIngress` から得られた返答テキストを Fish Audio S2.1（OpenRouter `https://openrouter.ai/api/v1/audio/speech`）経由で一時ファイル（30分後自動クリーンアップ）として音声化し、`createAudioResource` で再生する。
- ユーザーの発話が始まった場合は、既存の `entry.player.stop(true)` により再生を即時中断し、聞き役に回る（世代カウンタにより古い非同期返答の再生も破棄する）。
- 万が一 TTS や音声再生が失敗した場合は、チャンネルへのテキスト投稿に安全にフォールバックし、通話キューを停止させない（フェイルオープン）。

---

## 4. 変更対象ファイル

- `extensions/discord/package.json`: `@noble/ciphers`（`^2.1.1`）追加
- `extensions/discord/src/voice/manager.ts`: `mainSessionKey` ルーティング、TTS 音声生成・再生パイプライン、世代管理
- `extensions/discord/src/voice/manager.e2e.test.ts`: ルーティングおよび再生モックのテスト同期

---

## 5. 移行・検証ゲート

1. `bun --check`: 型エラー 0 件。
2. `bun -e 'console.log(require("@discordjs/voice").generateDependencyReport())'`: 暗号化ライブラリが認識されること。
3. `bun test extensions/discord`: ボイス関連テストの通過。
4. `bun fmt --check`: フォーマット準拠。

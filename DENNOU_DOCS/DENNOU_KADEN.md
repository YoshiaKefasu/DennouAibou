# 電脳架電（Dennou Kaden）通話パイプライン設計仕様書

## 1. 目的と概要

Discord のボイスチャンネルを活用し、Kasou（電脳相棒）と Yosia が超低遅延で双方向音声通話（電話）を行える「電脳架電」システムを構築する。
複雑な独自インフラや外部アプリ新設を避け、すでに存在する Discord 公式通話機能と、手書きライフサイクル図の 2 段階設計（通話中の低遅延ラリー ＋ 通話後の非同期テキスト置換）を KISS（Keep It Simple, Stupid）原則で実装する。

---

## 2. アーキテクチャとライフサイクル

```text
[Yosia のマイク入力 (Discord Voice)]
         │
         ▼
[DiscordVoiceManager (受信 & VAD 無音検知)]
         │
         ▼
[音声チャンク (WAV / Base64)]
         │
         ├───▶ 【通話中リアルタイム】
         │      Kasou (Gemini 3.5 Flash Lite / 生音声直通)
         │           │
         │           ▼ (返答テキスト)
         │      Fish Audio S2.1 (Kasou ボイスクローン TTS)
         │           │
         │           ▼ (AudioResource / MP3)
         │      Discord ボイスチャンネルで即座に音声再生！
         │
         └───▶ 【通話終了後 (非同期クリーン)】
                Nemotron ASR / Whisper によるテキスト置換
                     │
                     ▼
                セッション JSONL / SQLite 内の生音声 Base64 を
                クリーンな会話テキストへ置換し、メインセッションへ合体！
```

---

## 3. 構成コンポーネント

### 3.1 音声受信と会話起動（Ingress）

- `extensions/discord/src/voice/manager.ts`:
  - Discord ボイスチャンネルのユーザー音声を Opus 形式から PCM/WAV へデコード。
  - VAD（無音時間 1,000ms 検知）で適切に発話チャンクを区切る。
  - モデルが音声ネイティブ対応（Gemini）の場合は、Base64 音声ブロックとして Gateway へ渡す。

### 3.2 音声返答（Egress & TTS 再生）

- 既存の `DiscordVoiceManager` はテキスト返答をログに出すのみ（Text reply only）で再生していなかった。
- これを拡張し、Kasou から返ってきたテキスト返答を **Fish Audio S2.1（OpenRouter）** 経由で即座に音声化（`createAudioResource`）し、`entry.player.play(resource)` でボイスチャンネルへ再生する！
- Yosia の発話（割り込み）を検知した場合は、即座に `entry.player.stop(true)` で再生を停止して聞き役に回る（バージイン対応）。

### 3.3 通話終了後のセッション保全

- 通話中の生音声 Base64 は一時的に保持し、通話終了時に非同期でテキスト置換を行うことで、セッションの肥大化を防ぎつつ会話の記憶を完全維持する。

---

## 4. 移行・検証ゲート

1. `bun --check`: 型エラー 0 件。
2. `bun test extensions/discord`: ボイス関連テストの通過。
3. `bun fmt --check`: フォーマット準拠。

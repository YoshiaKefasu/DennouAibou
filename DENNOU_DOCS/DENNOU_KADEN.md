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
 (マスターセッション agent:main:main へ直接ルーティング)
         │
         ▼ (返答テキスト)
[TTS: OpenRouter /api/v1/audio/speech (Fish Audio S2.1)]
 (response_format: "mp3", fetchWithSsrFGuard, release() ガード)
         │
         ▼ (一時 MP3 音声ファイル: WAV と同一 temp dir)
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
  - ※ `entry.route.mainSessionKey` は本番では常に存在するが、テストダブル互換のためにフォールバックを残す。
- これにより、ボイスチャンネルテキストとのセッション共有は放棄しつつ、Telegram DM や Discord DM のテキストと完全に連続した文脈を保つ。JSONL の事後合体や親リンク破損リスクを構造的に排除する。
- テストフィクスチャ（`manager.e2e.test.ts`）にも `mainSessionKey` を反映する。

### 3.3 音声返答（Egress）とバージイン

- **世代カウンタの管理**:
  - `VoiceSessionEntry` に `generation: number`（初期値 `0`）を追加する。世代はセッション（ギルド）単位とし、1:1 通話を前提とする。
  - ユーザーの発話開始時（`handleSpeakingStart` 内、`botUserId` 自己フィルタ直後・`activeSpeakers` ガード通過後）に **`entry.generation++`** をインクリメントし、**発話開始時点の世代（`const segmentGeneration = entry.generation`）を `processSegment` へ引数として渡す**。
  - プレイヤーが再生中の場合は既存の `entry.player.stop(true)` も同時に実行する。
  - `processSegment` 冒頭（STT 前）および STT 完了直後（`manager.ts:581` 直後）の両方で `if (entry.generation !== segmentGeneration) return;` を検証し、早期リターンにより無駄な STT・LLM 呼び出しや TTS 合成をスキップする。
- **TTS 音声生成（OpenRouter）**:
  - 返答テキスト（`channels.discord.voice.tts.maxTextLength ?? 1_500` 文字で打ち切り）を OpenRouter 音声合成 API（`https://openrouter.ai/api/v1/audio/speech`）へ投げる。
  - 試行ループ前に `const startedAt = Date.now()` を記録し、各試行直前に `const elapsed = Date.now() - startedAt;` を計算。タイムアウトは `timeoutMs: Math.max(1_000, (channels.discord.voice.tts.timeoutMs ?? 15_000) - elapsed)` とする。
  - モデル: `fish-audio/s2.1-pro-free:free`（429/402/5xx エラー時は `fish-audio/s2.1-pro` へフォールバックし、2試行目も失敗なら即テキストフォールバック。それ以外の 4xx エラーは即テキストフォールバック）。
  - パラメータ: `response_format: "mp3"`, `input: replyText`（`channels.discord.voice.tts.providers.openrouter.voice` が設定されている場合は付与）。
  - ネットワーク: `fetchWithSsrFGuard` を使用。
    ```ts
    let response: Response | undefined;
    let release: (() => Promise<void>) | undefined;
    try {
      const res = await fetchWithSsrFGuard({ url, init, timeoutMs });
      response = res.response;
      release = res.release;
      if (!response.ok) { ... }
      const mp3 = Buffer.from(await response.arrayBuffer());
    } finally {
      await response?.body?.cancel().catch(() => {});
      await release?.();
    }
    ```
  - API キー: `resolveConfiguredSecretInputString(channels.discord.voice.tts.providers.openrouter.apiKey) ?? process.env.OPENROUTER_API_KEY?.trim()` から安全に解決。
- **再生と破棄**:
  - 生成した MP3（WAV と同一の tempDir に保存、既存 `scheduleTempCleanup` を再利用）の再生直前に、セッション破棄チェック（`this.sessions.get(entry.guildId) !== entry`）および世代不一致チェック（`entry.generation !== segmentGeneration`）を同一同期ブロック内（`await` を挟まない）で判定し、無効なら再生せず破棄する。有効時のみ `createAudioResource` で再生する。
- **フェイルオープン**:
  - TTS や音声再生が失敗した場合は、チャンネルへのテキスト投稿（`this.params.client.rest.post(Routes.channelMessages(entry.channelId), ...)`）に安全にフォールバックし、通話キューを停止させない。

---

## 4. 変更対象ファイル

- `extensions/discord/package.json`: `@noble/ciphers`（`^2.1.1`）追加
- `pnpm-lock.yaml`: 依存関係のロック
- `extensions/discord/src/voice/manager.ts`: `mainSessionKey` ルーティング、世代管理、TTS 音声生成・再生パイプライン、テキストフォールバック
- `extensions/discord/src/voice/manager.e2e.test.ts`: ルーティング、再生モック、新規ガード（世代不一致破棄・セッション破棄・429フォールバック・400即テキスト・`maxTextLength` 切り詰め・`mainSessionKey` 優先ルーティング）のテスト同期（テストフィクスチャに `generation: 0`, `segmentGeneration: 0`, `player: { play, stop }` を補完し、`fetchWithSsrFGuard` をモック可能にする）

---

## 5. 移行・検証ゲート

1. `bun --check`: 型エラー 0 件。
2. 機械判定: リポジトリルートで `bun -e 'const r=require("@discordjs/voice").generateDependencyReport(); if(r.includes("@noble/ciphers: not found")) process.exit(1)'`: 暗号化ライブラリが正常認識されること。
3. `bun test extensions/discord`: ボイス関連テストおよび TTS 失敗時テキストフォールバックの通過。
4. `bun fmt --check`: フォーマット準拠。

# 電脳架電（Dennou Kaden）通話パイプライン設計仕様書

## 1. 目的と概要

Discord のボイスチャンネルを活用し、Kasou（電脳相棒）と Yosia が双方向音声通話（電話）を行えるシステムを構築する。
複雑な独自インフラや外部サーバー新設を避け、すでに存在する Discord 公式通話機能（`@discordjs/voice`）と、既存の単一不滅マスターセッション（`agent:main:main`）を KISS（Keep It Simple, Stupid）原則で結合する。
通話経路は Discord 標準機能のみで自立し、音声認識（STT）は Groq Whisper（一次・超爆速）と Google Gemini 3.5 Transcribe Live（二次・高精度フォールバック）を組み合わせ、自前サーバー負荷ゼロの完全クラウド低遅延パイプラインとする。

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
 (一次: Groq whisper-large-v3-turbo / 0.1〜0.3秒
  二次: Google gemini-3.5-transcribe-live / 高精度フェイルオープン)
         │
         ▼ (テキストプロンプト)
[in-process: agentCommandFromIngress]
 (マスターセッション agent:main:main へ直接ルーティング)
         │
         ▼ (返答テキスト)
[TTS: OpenRouter /api/v1/audio/speech (Fish Audio S2.1)]
 (response_format: "mp3", fetchWithSsrFGuard, release() ガード, ttsAbort 即時キャンセル)
         │
         ▼ (一時 MP3 音声ファイル: path.dirname(wavPath) に保存)
[createAudioResource ＆ entry.player.play()]
 (Discord ボイスチャンネルで即座に音声再生！)
```

---

## 3. 実装の要件と技術的解決（KISS 原則）

### 3.1 依存ライブラリの補強と STT 2段構え設計

- **暗号化と FFmpeg**:
  - `@discordjs/voice` の音声送信（`player.play()`）において、Discord サーバーが要求する暗号化モード（`aead_xchacha20_poly1305_rtpsize` 等）に対応するため、純 JS 製の `@noble/ciphers`（`^2.1.1`）を `extensions/discord/package.json` の `dependencies` に追加し、`pnpm-lock.yaml` および `scripts/lib/kasou-nm-closure.json`（`@noble/hashes` の直前）を更新する。
  - 音声変換には環境上の `ffmpeg`（KASOU 実機 `/usr/bin/ffmpeg` 確認済み）を使用する。
- **超高速 STT 2段構え (KISS 設計)**:
  - 自前サーバーを一切立てず、既存の `tools.media.audio.models[]` で一次に Groq Whisper、二次に Google Gemini 3.5 Transcribe Live を設定する。
  - 設定例（KASOU 側の `dennou-aibou.json`）:
    ```jsonc
    "tools": {
      "media": {
        "audio": {
          "models": [
            { "provider": "groq", "model": "whisper-large-v3-turbo" },
            { "provider": "google", "model": "gemini-3.5-transcribe-live" }
          ]
        }
      }
    }
    ```
  - 一次（Groq）が 0.1〜0.3秒で爆速文字起こしを行い、万が一 Groq がレート制限（429）やエラーで失敗した場合は、既存の `runner.ts` 継続ループ（`outcome: "failed"`）により、二次の Google（`gemini-3.5-transcribe-live`）へ自動でフォールバックする（フェイルオープン）。
  - 万が一全 STT エントリが失敗、または空の transcript となった場合は、`manager.ts` で警告ログ（`discord voice: no transcript produced (all providers failed or returned empty)`）を出力し、原因追跡を可能にする。

### 3.2 セッションと記憶の一本化（マスターセッション直接ルーティング）

- `DiscordVoiceManager.processSegment` における `agentCommandFromIngress` の呼び出し時、`sessionKey` に `entry.route.mainSessionKey ?? entry.route.sessionKey` を指定し、最初から Kasou のマスターセッション（`agent:main:main`）へ直接ルーティングする（プロジェクト規則 #2032 準拠）。
  - ※ `entry.route.mainSessionKey` は本番では常に存在するが、テストダブル互換（フィクスチャは unknown キャストで型を外すため）のためにフォールバックを残す。
- これにより、ボイスチャンネルテキストとのセッション共有は放棄しつつ、Telegram DM や Discord DM のテキストと完全に連続した文脈を保つ。JSONL の事後合体や親リンク破損リスクを構造的に排除する。
- テストフィクスチャ（`manager.e2e.test.ts`）にも `mainSessionKey` を反映する。

### 3.3 音声返答（Egress）とバージイン

- **世代カウンタとセッション生存の管理**:
  - `VoiceSessionEntry` に `generation: number`（初期値 `0`）および `ttsAbort?: AbortController` を追加する。世代はセッション（ギルド `DiscordVoiceManager#sessions` Map）単位とし、1:1 通話を前提とする。
  - プライベートメソッド `private isStaleSegment(entry: VoiceSessionEntry, segmentGeneration: number): boolean`（`this.sessions.get(entry.guildId) !== entry || entry.generation !== segmentGeneration`）を定義する。
  - ユーザーの発話開始時（`handleSpeakingStart` 内、`activeSpeakers.add(userId)` 直後・`const voiceSdk` 宣言より前）で無条件に **`const segmentGeneration = ++entry.generation;`** を同期実行して世代を進めつつ捕捉し、**進行中の TTS 合成があれば `entry.ttsAbort?.abort()` で即時キャンセルする**（プレイヤー再生中なら `entry.player.stop(true)` も実行。※ `MIN_SEGMENT_SECONDS` 未満の短い物音でも先行セグメントの遅延再生は確実に破棄される設計トレードオフとする）。
  - `leave()` の `stop()` 呼び出し時にも `entry.ttsAbort?.abort()` を実行し、退出後の宙ぶらりんリクエストを防止する。
  - `processSegment` 内 3 箇所（`authorizeDiscordVoiceIngress` 完了後の STT 直前、`transcribeAudio` 完了直後の `if (!transcript)` 直前、`agentCommandFromIngress` 完了直後の `const replyText` 直前）で `if (this.isStaleSegment(entry, segmentGeneration)) return;` を検証し、早期リターンにより無駄な STT・LLM 呼び出しや TTS 合成をスキップする。
- **TTS 音声生成（OpenRouter）**:
  - 返答テキストを OpenRouter 音声合成 API（`https://openrouter.ai/api/v1/audio/speech`）へ投げる。
  - API キー: `openclaw/plugin-sdk/config-runtime` の `resolveConfiguredSecretInputWithFallback` を使用して解決する。**`apiKey` が未解決の場合は無駄な 401 往復やテキストフォールバックを行わず、verbose ログを出して早期 return する（チャンネル汚染防止）**。
  - 試行ループ前に新規 `abortController = new AbortController()` を立て `entry.ttsAbort` に保持する。`startedAt = Date.now()` を記録し、各試行直前に `const elapsed = Date.now() - startedAt;` を計算。タイムアウトは `timeoutMs: Math.max(1_000, (channels.discord.voice.tts.timeoutMs ?? 15_000) - elapsed)` とする（2 試行固定かつ最小 1,000ms を前提とし、総所要時間の上限は `Math.max(1_000, timeoutMs) + 1_000ms`）。
  - モデル: `fish-audio/s2.1-pro-free:free`（429/402/5xx エラー時は `fish-audio/s2.1-pro` へフォールバックし、2試行目も失敗なら即テキストフォールバック。それ以外の 4xx エラーは即テキストフォールバック。abort 済みなら再試行せず即終了）。
  - パラメータ: `response_format: "mp3"`, `input: replyText.slice(0, channels.discord.voice.tts.maxTextLength ?? 1_500)`（`typeof voice === "string" && voice.trim()` の場合のみ `voice` を付与）。
  - ネットワーク: `fetchWithSsrFGuard` を使用（`signal: abortController.signal` を伝播）。
    ```ts
    let response: Response | undefined;
    let release: (() => Promise<void>) | undefined;
    try {
      const res = await fetchWithSsrFGuard({ url, init, timeoutMs, signal });
      response = res.response;
      release = res.release;
      if (!response.ok) { ... }
      const mp3 = Buffer.from(await response.arrayBuffer());
    } finally {
      await response?.body?.cancel().catch(() => {});
      await release?.().catch(() => {});
    }
    ```
- **再生と破棄**:
  - 生成した MP3 は WAV と同一の `path.dirname(wavPath)` に保存する（WAV 作成時に設定済みの既存 30 分タイマーが両方を削除するため、`scheduleTempCleanup` の追加呼び出しは行わない）。
  - 音声リソースの生成には `loadDiscordVoiceSdk().createAudioResource` を使用する。
  - 再生直前に、`this.isStaleSegment(entry, segmentGeneration)` を同一同期ブロック内（`await` を挟まない）で判定し、無効なら再生せず破棄する（※世代不一致による破棄時はバージインのためテキストフォールバックは行わない）。有効時のみ `entry.player.play(resource)` で再生する。
- **フェイルオープン**:
  - TTS や音声再生が失敗（エラー）した場合は、直前に世代破棄判定 `if (this.isStaleSegment(entry, segmentGeneration)) return;` を行った上で、チャンネルへのテキスト投稿（`this.params.client.rest.post(Routes.channelMessages(entry.channelId), { body: { content: replyText.slice(0, 2_000) } })`）に安全にフォールバックし、通話キューを停止させない。

---

## 4. 変更対象ファイル

- `extensions/discord/package.json`: `@noble/ciphers`（`^2.1.1`）追加
- `pnpm-lock.yaml`: 依存関係のロック
- `scripts/lib/kasou-nm-closure.json`: `@noble/ciphers`（`@noble/hashes` の直前に昇順で追加）
- `extensions/discord/src/voice/manager.ts`: `Routes` / `fetchWithSsrFGuard` / `resolveConfiguredSecretInputWithFallback` の import、`mainSessionKey` ルーティング、世代管理、`ttsAbort` による即時キャンセル、`isStaleSegment`、TTS 音声生成・再生パイプライン、2000文字テキストフォールバック、STT 失敗時 warn ログ
- `extensions/discord/src/voice/manager.e2e.test.ts`:
  - 既存の `resolves.not.toThrow()` を Bun 互換の `resolves.toBeUndefined()` に修正。
  - テスト用 `wavPath` は一時ディレクトリ（`fs.mkdtemp`）配下の安全なパスを使用し `afterEach` で後始末を行う。
  - `createAudioResourceMock` を `vi.hoisted` へ引き上げ、テスト側から検証可能にする。
  - `client.rest: { post: vi.fn(async () => ({ id: "m1" })) }` モックを追加。
  - `entry` は `(manager as unknown as { sessions: Map<string, unknown> }).sessions.set("g1", entry)` に登録したオブジェクトと同一参照を使用し、`generation: 0`, `player: { play: vi.fn(), stop: vi.fn(), state: { status: "idle" } }`, `activeSpeakers: new Set<string>()`, `connection: createConnectionMock()`, `route: { mainSessionKey: "agent:main:main", ... }` を補完する（バージイン検証時は `entry.player.state.status = "playing"` に差し替えて `player.stop(true)` を検証）。
  - `ProcessSegmentInvoker` 型および `processSegment(...)` 呼び出しに `segmentGeneration: number`（通常テスト時は `0`）を追加。
  - `openclaw/plugin-sdk/ssrf-runtime` を部分モックし、正常系再生テスト（TTS 成功 → `createAudioResource` / `player.play` 呼び出し）および新規ガードケース（発話検知時 generation++ ＆ バージイン・ttsAbort 即時中断、世代不一致破棄、セッション破棄、429→有料モデルフォールバック、400即テキスト、apiKey 未設定時静的スキップ、2000文字上限テキストフォールバック、`mainSessionKey` 優先ルーティング）をテスト検証。

---

## 5. 移行・検証ゲート

1. `bun --check`: 型エラー 0 件。
2. 機械判定: リポジトリルートで `bun -e 'const r=require("@discordjs/voice").generateDependencyReport(); if(r.includes("@noble/ciphers: not found")) process.exit(1)'`: 暗号化ライブラリが正常認識されること。
3. `bun test extensions/discord/src/voice/`: ボイス関連テストおよび TTS 失敗時テキストフォールバックの全通過。
4. `bun fmt --check`: フォーマット準拠。

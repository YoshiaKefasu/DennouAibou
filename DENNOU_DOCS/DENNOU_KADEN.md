# 電脳架電（Dennou Kaden）通話パイプライン設計仕様書

## 1. 目的と概要

Discord のボイスチャンネルを活用し、Kasou（電脳相棒）と Yosia が双方向音声通話（電話）を行えるシステムを構築する。
複雑な独自インフラや外部アプリ新設を避け、すでに存在する Discord 公式通話機能（`@discordjs/voice`）と、既存の単一不滅マスターセッション（`agent:main:main`）を KISS（Keep It Simple, Stupid）原則で結合する。
通話経路自体は Discord 標準機能のみで自立して動作し、重い音声認識（ASR）のオフロードは既存の `tools.media.audio.models[]` エントリ単位の `baseUrl` を活用した任意の低遅延オプションとして位置づける。

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
 (tools.media.audio.models[] のエントリ単位 baseUrl で Windows RTX 2060 へオフロード、
  未設定または失敗時は次エントリのクラウドプロバイダへ安全にフェイルオープン)
         │
         ▼ (テキストプロンプト)
[in-process: agentCommandFromIngress]
 (マスターセッション agent:main:main へ直接ルーティング)
         │
         ▼ (返答テキスト)
[TTS: OpenRouter /api/v1/audio/speech (Fish Audio S2.1)]
 (response_format: "mp3", fetchWithSsrFGuard, release() ガード)
         │
         ▼ (一時 MP3 音声ファイル: path.dirname(wavPath) に保存)
[createAudioResource ＆ entry.player.play()]
 (Discord ボイスチャンネルで即座に音声再生！)
```

---

## 3. 実装の要件と技術的解決（KISS 原則）

### 3.1 依存ライブラリの補強と ASR オフロード設計

- **暗号化と FFmpeg**:
  - `@discordjs/voice` の音声送信（`player.play()`）において、Discord サーバーが要求する暗号化モード（`aead_xchacha20_poly1305_rtpsize` 等）に対応するため、純 JS 製の `@noble/ciphers`（`^2.1.1`）を `extensions/discord/package.json` の `dependencies` に追加し、`pnpm-lock.yaml` および `scripts/lib/kasou-nm-closure.json`（`@noble/hashes` の直前）を更新する。
  - 音声変換には環境上の `ffmpeg`（KASOU 実機 `/usr/bin/ffmpeg` 確認済み）を使用する。
- **低遅延 ASR オフロード (KISS 設計)**:
  - 新規設定スキーマを発明せず、既存のコア機能 `tools.media.audio.models[]` でエントリ単位の `baseUrl` を指定する（※トップレベルの `tools.media.audio.baseUrl` は全エントリ共通の既定値となってフォールバック先も書き換えてしまうため、必ずモデルエントリ単位で定義する）。
  - 設定例（KASOU 側の `dennou-aibou.json`）:
    ```jsonc
    "tools": {
      "media": {
        "audio": {
          "models": [
            { "provider": "openai", "model": "whisper-1", "baseUrl": "http://192.168.100.32:9000/v1" },
            { "provider": "deepgram", "model": "nova-3" }
          ]
        }
      }
    }
    ```
  - Windows RTX 2060 側の OpenAI 互換サーバー（`/audio/transcriptions`、`allowPrivateNetwork: true` 内蔵）が稼働している場合は、WAV セグメントが自動で LAN 直通オフロードされ、クラウド往復遅延を回避して高速にテキスト化される。
  - 外部サーバーが未設定、または接続拒否・5xx エラー等で失敗した場合は、既存の `runner.ts` エラー時継続ループ（`outcome: "failed"`）により、次のクラウドプロバイダ（Deepgram / OpenAI 等）へ自動でフォールバックする（フェイルオープン）。
  - 万が一全 STT エントリが失敗した場合は、`manager.ts` で警告ログ（試行結果 `attempts` 付き）を出力し、無言のまま通話が停止しないようにする。

### 3.2 セッションと記憶の一本化（マスターセッション直接ルーティング）

- `DiscordVoiceManager.processSegment` における `agentCommandFromIngress` の呼び出し時、`sessionKey` に `entry.route.mainSessionKey ?? entry.route.sessionKey` を指定し、最初から Kasou のマスターセッション（`agent:main:main`）へ直接ルーティングする（プロジェクト規則 #2032 準拠）。
  - ※ `entry.route.mainSessionKey` は本番では常に存在するが、テストダブル互換（フィクスチャは unknown キャストで型を外すため）のためにフォールバックを残す。
- これにより、ボイスチャンネルテキストとのセッション共有は放棄しつつ、Telegram DM や Discord DM のテキストと完全に連続した文脈を保つ。JSONL の事後合体や親リンク破損リスクを構造的に排除する。
- テストフィクスチャ（`manager.e2e.test.ts`）にも `mainSessionKey` を反映する。

### 3.3 音声返答（Egress）とバージイン

- **世代カウンタとセッション生存の管理**:
  - `VoiceSessionEntry` に `generation: number`（初期値 `0`）を追加する。世代はセッション（ギルド `DiscordVoiceManager#sessions` Map）単位とし、1:1 通話を前提とする。
  - プライベートメソッド `private isStaleSegment(entry: VoiceSessionEntry, segmentGeneration: number): boolean`（`this.sessions.get(entry.guildId) !== entry || entry.generation !== segmentGeneration`）を定義する。
  - ユーザーの発話開始時（`handleSpeakingStart` 内、`activeSpeakers.add(userId)` 直後・`const voiceSdk` 宣言より前）で無条件に **`const segmentGeneration = ++entry.generation;`** を同期実行して世代を進めつつ捕捉し（プレイヤー再生中なら `entry.player.stop(true)` も実行）、その `segmentGeneration` を `processSegment` へ引数として渡す（※ `MIN_SEGMENT_SECONDS` 未満の短い物音でも先行セグメントの遅延再生は確実に破棄される設計トレードオフとする）。
  - `processSegment` 内 3 箇所（`authorizeDiscordVoiceIngress` 完了後の STT 直前、`transcribeAudio` 完了直後の `if (!transcript)` 直前、`agentCommandFromIngress` 完了直後の `const replyText` 直前）で `if (this.isStaleSegment(entry, segmentGeneration)) return;` を検証し、早期リターンにより無駄な STT・LLM 呼び出しや TTS 合成をスキップする。
- **TTS 音声生成（OpenRouter）**:
  - 返答テキスト（`channels.discord.voice.tts.maxTextLength ?? 1_500` 文字で打ち切り）を OpenRouter 音声合成 API（`https://openrouter.ai/api/v1/audio/speech`）へ投げる。
  - 試行ループ前に `const startedAt = Date.now()` を記録し、各試行直前に `const elapsed = Date.now() - startedAt;` を計算。タイムアウトは `timeoutMs: Math.max(1_000, (channels.discord.voice.tts.timeoutMs ?? 15_000) - elapsed)` とする（2 試行固定かつ最小 1,000ms を前提とし、総所要時間の上限は `Math.max(1_000, timeoutMs) + 1_000ms`）。
  - モデル: `fish-audio/s2.1-pro-free:free`（429/402/5xx エラー時は `fish-audio/s2.1-pro` へフォールバックし、2試行目も失敗なら即テキストフォールバック。それ以外の 4xx エラーは即テキストフォールバック）。
  - パラメータ: `response_format: "mp3"`, `input: replyText`（`typeof voice === "string" && voice.trim()` の場合のみ `voice` を付与）。
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
  - API キー: `openclaw/plugin-sdk/config-runtime` の `resolveConfiguredSecretInputWithFallback` を使用して解決する：
    ```ts
    const apiKey = (
      await resolveConfiguredSecretInputWithFallback({
        config: this.params.cfg,
        env: process.env,
        value: this.params.discordConfig.voice?.tts?.providers?.openrouter?.apiKey,
        path: "channels.discord.voice.tts.providers.openrouter.apiKey",
        readFallback: () => process.env.OPENROUTER_API_KEY?.trim(),
      })
    ).value;
    ```
    ※ `apiKey` が未解決の場合は Authorization を付与せず、401 エラーから即テキストフォールバックに移行する。
- **再生と破棄**:
  - 生成した MP3 は WAV と同一の `path.dirname(wavPath)` に保存する（WAV 作成時に設定済みの既存 30 分タイマーが両方を削除するため、`scheduleTempCleanup` の追加呼び出しは行わない）。
  - 音声リソースの生成には `loadDiscordVoiceSdk().createAudioResource` を使用する。
  - 再生直前に、`this.isStaleSegment(entry, segmentGeneration)` を同一同期ブロック内（`await` を挟まない）で判定し、無効なら再生せず破棄する（※世代不一致による破棄時はバージインのためテキストフォールバックは行わない）。有効時のみ `entry.player.play(resource)` で再生する。
- **フェイルオープン**:
  - TTS や音声再生が失敗（エラー）した場合は、直前に世代破棄判定 `if (this.isStaleSegment(entry, segmentGeneration)) return;` を行った上で、チャンネルへのテキスト投稿（`this.params.client.rest.post(Routes.channelMessages(entry.channelId), ...)`）に安全にフォールバックし、通話キューを停止させない。

---

## 4. 変更対象ファイル

- `extensions/discord/package.json`: `@noble/ciphers`（`^2.1.1`）追加
- `pnpm-lock.yaml`: 依存関係のロック
- `scripts/lib/kasou-nm-closure.json`: `@noble/ciphers`（`@noble/hashes` の直前に昇順で追加）
- `extensions/discord/src/voice/manager.ts`: `Routes` / `fetchWithSsrFGuard` の import、`mainSessionKey` ルーティング、世代管理、`isStaleSegment`、TTS 音声生成・再生パイプライン、テキストフォールバック、STT 失敗時 warn ログ
- `extensions/discord/src/voice/manager.e2e.test.ts`:
  - 既存の `resolves.not.toThrow()` を Bun 互換の `resolves.toBeUndefined()` に修正。
  - テスト用 `wavPath` は一時ディレクトリ（`fs.mkdtemp`）配下の安全なパスを使用し `afterEach` で後始末を行う。
  - `createAudioResourceMock` を `vi.hoisted` へ引き上げ、テスト側から検証可能にする。
  - `client.rest: { post: vi.fn(async () => ({ id: "m1" })) }` モックを追加。
  - `entry` は `(manager as unknown as { sessions: Map<string, unknown> }).sessions.set("g1", entry)` に登録したオブジェクトと同一参照を使用し、`generation: 0`, `player: { play: vi.fn(), stop: vi.fn(), state: { status: "idle" } }`, `activeSpeakers: new Set<string>()`, `connection: createConnectionMock()`, `route: { mainSessionKey: "agent:main:main", ... }` を補完する（バージイン検証時は `entry.player.state.status = "playing"` に差し替えて `player.stop(true)` を検証）。
  - `ProcessSegmentInvoker` 型および `processSegment(...)` 呼び出しに `segmentGeneration: number`（通常テスト時は `0`）を追加。
  - `openclaw/plugin-sdk/ssrf-runtime` を `importOriginal` 併用で部分モックし、正常系再生テスト（TTS 成功 → `createAudioResource` / `player.play` 呼び出し）および新規ガードケース（発話検知時 generation++ ＆ バージイン、世代不一致破棄、セッション破棄、429→有料モデルフォールバック、400即テキスト、`maxTextLength` 切り詰め、`mainSessionKey` 優先ルーティング）をテスト検証。

---

## 5. 移行・検証ゲート

1. `bun --check`: 型エラー 0 件。
2. 機械判定: リポジトリルートで `bun -e 'const r=require("@discordjs/voice").generateDependencyReport(); if(r.includes("@noble/ciphers: not found")) process.exit(1)'`: 暗号化ライブラリが正常認識されること。
3. `bun test extensions/discord/src/voice/`: ボイス関連テストおよび TTS 失敗時テキストフォールバックの全通過。
4. `bun fmt --check`: フォーマット準拠。

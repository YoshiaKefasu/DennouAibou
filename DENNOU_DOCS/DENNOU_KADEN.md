# 電脳架電（Dennou Kaden）通話パイプライン設計仕様書

## 0. 実装状況（2026-10-29 時点）

### 0.1 実装済み

- **完全 Go 言語製バイナリプラグイン基盤（`extensions/dennou-kaden`）** の scaffold。
  - `dennou.plugin.json`（`kind: "binary"`, `executable: "./bin/kaden"`）＋ `main.go`（stdio JSON-RPC 2.0 デーモン）＋ `build.mjs`（クロスビルド）。
  - ホスト側は `src/plugins/binary-runner.ts` の stdio JSON-RPC ブリッジで接続し、`registerService` による起動・正常終了と、ツール呼び出しの中継を行う。
  - `initialize` が広告する capabilities は現時点では `["tools"]` のみ（音声パイプライン実装時に `"voice"` を追加する）。
- **パーソナル話者フィルタ（`extensions/dennou-kaden/audio`）** を実装済み。
  - `audio/personal_filter.go`: 標準ライブラリ（`math` 等）のみ・CGO 不要の純 Go 実装。VAD ＋ 正規化自己相関ピッチ ＋ 話者プロファイル追跡の3段パイプラインを 16 ms フレーム単位で実行する（詳細は §6）。
  - `audio/personal_filter_test.go`: 合成サイン波（120 Hz / 200 Hz / 帯域外 400 Hz）、ホワイトノイズ、無音、48 kHz ステレオ、登録フェイルクローズ、`Reset()`、`too_far`、アロケーション 0 を検証。
  - `go test -race ./...` が全パス。ただし**デーモン本体（`main.go`）にはまだ配線していない**（受信音声経路の実装時に接続する）。
- **ツール 2 種**（実装済みの範囲のみを公開）:
  - `kaden_status`: デーモン状態・Go ランタイム情報・設定値のレポート。
  - `kaden_call`: `action: "status" | "ping"`（JSON Schema の `enum` で制限）。未知の action はエラーにせず案内メッセージを返す。

### 0.2 今後の実装計画

音声送受信・STT/TTS ストリーミングパイプラインは**未実装**であり、以下を段階的に Go デーモン完結型へ移行する計画とする。

0. **パーソナル話者フィルタの配線**: `audio.Filter` は完成済みだが未接続。受信音声（PCM）を `Filter.Process` に通し、`Verdict.IsUser == false` のフレームを STT へ流さない（＝他話者・雑音・遠距離音を送信しない）ゲートとして組み込む。
1. **音声入出力の Go 側移行**: Discord voice の受信（Opus デコード）・送信（Opus エンコード）を Go デーモン内に取り込み、`@discordjs/voice` 依存を縮小する。
2. **STT/TTS ストリーミング**: 無音検知 → STT（Groq Whisper 一次 / Gemini Transcribe Live 二次）→ マスターセッション → TTS（OpenRouter Fish Audio）を、WAV/MP3 の一時ファイル経由ではなくストリームで接続する。
3. **capabilities の更新**: 上記が動作した時点で `initialize` の capabilities に `"voice"` を追加する。

> 以降の §2〜§5 は、**初回実装時に Discord 拡張（`extensions/discord`）側で試作したパイプラインの参照設計**である。当該試作は Go デーモン完結型へ移行するため revert 済み（commit `b7a75086f8`）であり、§4 の Discord 側変更対象ファイルは将来の移行フェーズで再適用する際の設計メモとして扱う。

---

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
- **能動記憶（memo）と過去ログ検索（chat_search）の同期**:
  - メインセッションに蓄積されている `<active-memos>`（能動記憶）は、通話セッション（`entry.route.mainSessionKey`）にも完全に自動同期・注入される（Kasou は通話中でも約束や大事なメモを把握できる）。
  - 通話中のド忘れを防ぐため、過去ログ検索ツール（`chat_search`）は通話セッションでも利用可能とする。
  - サブエージェント側は独立した作業セッションとなるため `memo` は同期せず、勝手な書き換えを防ぐため `memo` ツールも除外される。
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

---

## 6. パーソナル話者フィルタ（`audio` パッケージ）

### 6.1 目的

Krisp のようなノイズ抑制ではなく、**「登録した本人の声だけを通す」** ための軽量ゲート。通話中に混ざる他話者・環境音・遠くの話し声を STT へ渡さないことで、誤認識と無駄な API 課金を構造的に防ぐ。外部依存ゼロ・CGO 不要・純 Go 標準ライブラリのみで、リアルタイム音声経路から呼べることを最優先の設計制約とする。

### 6.2 3段パイプライン

```text
PCM (int16 interleaved)
   │  48 kHz → 3:1 平均間引き / ステレオ → (L+R)/2
   ▼
[16 kHz モノラル 256 サンプル = 16 ms フレーム]
   │
   ├─ ① VAD: RMS ＋ ZCR ＋ 指数移動ノイズフロア
   │      → Voiced=false なら Reason="silence" で終了
   ├─ ② ピッチ: 512 サンプル鏡像リングバッファ上の正規化自己相関
   │      → F0Hz, Periodicity。Periodicity<VoicingMin なら "unvoiced"
   │      → F0 が 80〜350 Hz の外なら "pitch_out_of_band"
   └─ ③ 話者追跡: 登録プロファイル（μ・σ・基準音量）との照合
          → IsUser / Score / Reason ("enrolling" | "too_far" | "pitch_out_of_band" | "user")
```

#### ① VAD（`RMS` ＋ `ZCR` ＋ ノイズフロア）

- `RMS` はフレームの二乗平均平方根（フルスケール int16 を 1.0 に正規化）。
- `ZCR` はゼロ交差率。ホワイトノイズは約 0.5 に張り付き、音声ははるかに低い。`zcrNoiseMax = 0.55` を超えるフレームは VAD で落とす。
- ノイズフロアは指数移動平均で追跡する（`noiseFloorAlpha = 0.12`）。**VAD が棄却したフレームでのみ更新**するため、発話がフロアを押し上げて自分自身を無音判定にする事故が起きない。
- 有声条件: `RMS >= max(vadAbsMin, noiseFloor*3.0)` かつ `ZCR <= 0.55`。

#### ② ピッチ（正規化自己相関）

- 512 サンプル（32 ms）の鏡像リングバッファ（`ring` は 1024 要素、書き込みは `pos` と `pos+512` の二箇所）により、**コピーなしで**直近 512 サンプルの連続スライスを得る。
- ラグ範囲は `27〜200` サンプル。下限は `pitchSearchMaxHz = 600 Hz` から決めており、`MaxF0Hz` を超える高い声を「折り返して 1/2 のサブハーモニック（例: 400 Hz → 200 Hz）」と誤認せず、**帯域外として正しく棄却**するための余裕である。
- 相関は固定長 `corrLen = 512 - maxLag = 312` サンプルで計算する（ラグごとに正規化条件を揃え、長いラグが有利にならないようにする）。
- 最大ピークだけでなく **「全体最大の 90% 以上ある最も短いラグの局所ピーク」** を採用し、周期の 2 倍・3 倍への誤ロックを防ぐ。
- ピーク位置は放物線補間するため、120 Hz 付近で ±0.5 Hz 程度の分解能が出る。
- `Periodicity` は採用ピークの正規化相関値（0〜1）。`VoicingMin = 0.35` 未満は無声として棄却。

#### ③ 話者プロファイル追跡

- **登録フェーズ**: 有声かつ帯域内のフレームを `EnrollFrames = 30` 個集めて候補配列を満たす。ただし登録ウィンドウは `EnrollFrames × enrollSettleFactor(3) = 90` フレーム（約 1.5 秒）まで開いたままで、その間は **「最も静かな候補」をより音量の大きいフレームで置き換え続ける**。90 フレーム目で `finalizeProfile()` が走ってプロファイルが凍結される。この待ち時間があるため、登録プロファイルは自然と至近距離の発話へ寄り、VAD をすり抜けた室内雑音の影響を受けにくい。
- **プロファイル**: `μ`（F0 平均）、`σ`（F0 標準偏差、`minSigmaHz = 8 Hz` と `μ` の 3% を下限とする）、`refRMS`（音量平均）。
- **照合**: 許容帯は `max(σ, max(8 Hz, 0.03μ)) × PitchSigmas(2.5)`。外れたら即 `pitch_out_of_band`。音量が `refRMS × 0.12`（−18 dB）未満なら `too_far`。
- **スコア**: `0.65 × ピッチ近さ ＋ 0.35 × 音量近さ`（各 0〜1）。
- **ヒステリシス**: 参入 `0.60` / 離脱 `0.45`。境界でのパタパタ切り替えを防ぐ。
- **EMA 更新**: `IsUser` のフレームのみ `μ`/`σ` を `0.02`、`refRMS` を `0.05` で緩やかに追従させ、声の調子や距離の変化に耐える。
- **登録はフェイルクローズ**: 登録完了までは `IsUser = false`（`Reason = "enrolling"`）。未検証の声を「本人」と見なさない。
- 無音・無声・帯域外を検出するとヒステリシス状態を即座にリセットする。

### 6.3 `Verdict`

| フィールド    | 型      | 意味                                                                            |
| ------------- | ------- | ------------------------------------------------------------------------------- |
| `Voiced`      | bool    | VAD 段の結果                                                                    |
| `F0Hz`        | float64 | ピッチ周波数（無声は 0）                                                        |
| `RMS`         | float64 | 正規化エネルギー                                                                |
| `ZCR`         | float64 | ゼロ交差率                                                                      |
| `Periodicity` | float64 | 正規化自己相関ピーク（0〜1）                                                    |
| `IsUser`      | bool    | 最終パーソナル判定                                                              |
| `Score`       | float64 | 話者スコア（0〜1）                                                              |
| `Reason`      | string  | `silence` / `unvoiced` / `pitch_out_of_band` / `too_far` / `user` / `enrolling` |

`Score` がヒステリシス下限を割った場合は、ピッチ成分と音量成分のどちらがより失敗しているかで `pitch_out_of_band` / `too_far` を出し分ける（`Reason` の語彙を増やさずに原因を伝えるため）。

### 6.4 パラメータ表（`Config`）

| フィールド     | 既定値  | 意味                                                                         |
| -------------- | ------- | ---------------------------------------------------------------------------- |
| `SampleRate`   | `16000` | 入力レート。`48000` は内部で 3:1 平均間引き。それ以外は `NewFilter` がエラー |
| `Channels`     | `1`     | インターリーブ数。`2` は `(L+R)/2` でモノラル化。1/2 以外はエラー            |
| `FrameMS`      | `16`    | 解析フレーム長。16 kHz で 256 サンプル。`16` のみ対応                        |
| `MinF0Hz`      | `80.0`  | 受理するピッチ帯の下限                                                       |
| `MaxF0Hz`      | `350.0` | 受理するピッチ帯の上限                                                       |
| `EnrollFrames` | `30`    | 登録候補配列のサイズ。登録ウィンドウは `×3 = 90` フレーム（約 1.5 秒）       |
| `PitchSigmas`  | `2.5`   | 登録 `μ` から許容する標準偏差数                                              |
| `VoicingMin`   | `0.35`  | 有声判定の自己相関下限                                                       |

内部定数（`personal_filter.go`）: `vadAbsMin=0.0035`、`vadFactor=3.0`、`zcrNoiseMax=0.55`、`noiseFloorAlpha=0.12`、`minSigmaHz=8.0`、`sigmaRelativeMin=0.03`、`volumeGateRatio=0.12`、`enterThreshold=0.60`、`exitThreshold=0.45`、`pitchWeight=0.65`、`levelWeight=0.35`、`profileAlphaPitch=0.02`、`profileAlphaLevel=0.05`、`enrollSettleFactor=3`、`ringSize=512`、`pitchSearchMaxHz=600`。

### 6.5 API と性能特性

| 関数                                                     | 役割                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NewFilter(cfg Config) (*Filter, error)`                 | 全バッファを一度に確保。設定検証もここ                                                                                                                       |
| `(*Filter).Process(samples []int16, emit func(Verdict))` | PCM を流し込み、完成した 16 ms フレームごとに `emit` を呼ぶ。`emit` は nil 可（nil でも 3 段パイプラインは実行され、登録・ノイズフロア・ヒステリシスは進む） |
| `(*Filter).FrameSamples() int`                           | 1 フレーム分の入力サンプル数（16 kHz モノラル=256、48 kHz ステレオ=1536）                                                                                    |
| `(*Filter).Reset()`                                      | プロファイル・VAD・ヒステリシスを破棄して再登録待ちに戻す                                                                                                    |
| `(*Filter).Enrolled() bool` / `Config() Config`          | 状態確認                                                                                                                                                     |

- **アロケーション 0**: バッファは `NewFilter` で確保済み。`Process` は `testing.AllocsPerRun` で 0 回/フレームをテストで固定している（`TestProcessIsAllocationFree`）。
- **計算量**: 1 フレームあたり自己相関が `312 × 174 ≒ 54k` 回の積和。16 kHz で毎秒 62.5 フレームなので約 340 万積和/秒。単一コアで十分に余裕がある。
- **窓の遅延**: 自己相関窓は 512 サンプル（32 ms）のため、話者が瞬時に切り替わった場合、切り替え直後の 2 フレームは旧話者のピッチを含む。テストではこの 2 フレームを遷移フレームとして除外している。

### 6.6 検証ゲート

1. `gofmt -l .` が無出力（フォーマット準拠）。
2. `go vet ./...` がエラー 0。
3. `go test -race ./...` が全パス（`main` パッケージと `audio` パッケージの双方）。
4. `node build.mjs` で `bin/kaden`（Windows は `bin/kaden.exe`）が生成され、stdio JSON-RPC の `initialize` / `tool.execute` / `shutdown` が正常応答する。

# Gemini CLI Provider レイテンシ分析

**日付:** 2026-05-19
**環境:** KASOU (Debian MiniPC) → Gemini API
**ベース:** OpenClaw v2026.4.5 (DennouAibou v0.6.0)

## 概要

OpenClaw 経由の Gemini API 呼び出しが、同じ Gemini API を直接叩くクライアントより
明らかに遅い。体感として「ターンごとに間がある」。

以下、ソースコード調査で特定したボトルネックを優先度順に列挙する。

---

## 優先度: 高（体感レイテンシの大半を占める）

### #1: 毎リクエスト DNS 解決

**ファイル:** `src/infra/net/ssrf.ts:312-356`
**効果:** 🔴 高
**リスク:** 🟡 中
**タグ:** `[SYNC]`

**内容:**
`fetchWithSsrFGuard()` は毎回 `resolvePinnedHostnameWithPolicy()` → `dnsLookup(hostname, { all: true })`
を呼び出し、全解決IPに対して `isPrivateIpAddress()` でプライベートチェックを行う。

直接APIを叩くクライアントはOSのDNSキャッシュが効くが、OpenClawはSSRF対策のため
**独自に毎回DNS解決**している。Gemini API は固定ホスト (`generativelanguage.googleapis.com`)
のため、初回以降のDNS解決は純粋なオーバーヘッドになる（推定10-50ms/回）。

**改善案:** 信頼できるAPIホストのDNS結果をキャッシュする。TTLを尊重しつつ、
hostname + resolved IPs のMapを保持する。

---

### #2: HTTP Agent の使い捨て（コネクションプール未再利用）

**ファイル:** `src/infra/net/fetch-guard.ts:290`
**効果:** 🔴 高
**リスク:** 🟡 中
**タグ:** `[SYNC]`

**内容:**
`createPinnedDispatcher()` がリクエストごとに `new Agent({...})` または
`new EnvHttpProxyAgent({...})` を生成。リクエスト終了時に `closeDispatcher()` で即破棄。

つまり **TCP keep-alive が一切機能しない**。毎回 TLS ハンドシェイク + TCP 接続を
やり直している。地理的に遠い Google サーバー（インドネシア→US/JP）では特に影響大。

**改善案:** Agent をホスト単位でキャッシュする。idle timeout での自動破棄、
メモリリーク防止のライフサイクル管理が必要。

---

## 優先度: 中（セッションが長いほど効いてくる）

### #3: ツールスキーマの二重クリーニング

**ファイル:**
- `src/agents/pi-tools.ts:662` — `normalizeToolParameters()` → `cleanSchemaForGemini()`
- `src/agents/pi-embedded-runner/run/attempt.ts:552` — `normalizeProviderToolSchemas()` → 再度 `cleanSchemaForGemini()`
- `src/plugin-sdk/provider-tools.ts:141` — `normalizeGeminiToolSchemas()` → さらに `cleanSchemaForGemini()`

**効果:** 🟡 中
**リスク:** 🟢 低
**タグ:** `[SYNC]`

ツール定義が複数パスで同じ `cleanSchemaForGemini()` を通過する。
20-50+ ツールがある場合、再帰的スキーマ走査が2回走る分のCPU時間が無駄になる。

**改善案:** 二重呼び出しを排除（クリーニングは冪等なので結果に影響なし）。

---

### #4: 全メッセージ履歴の逐次変換

**ファイル:** `src/agents/google-transport-stream.ts:276-409`（`convertGoogleMessages()`）

**効果:** 🟡 中
**リスク:** 🟡 中
**タグ:** `[SYNC]`

毎APIリクエストでセッション履歴の全メッセージを走査し、各コンテンツブロックに対して:
- `sanitizeTransportPayloadText()` の正規表現実行
- プロバイダ/モデル同一性のチェック
- toolResult → functionResponse 変換

履歴が長いほど線形にコストが増大する。739kトークン（現状のセッション）では
無視できない時間になる。

**改善案:** 変換結果をキャッシュするか、差分のみ変換する。

---

### #5: Prompt Cache 事前API呼び出し

**ファイル:** `src/agents/pi-embedded-runner/google-prompt-cache.ts:367-378`

**効果:** 🟡 中
**リスク:** 🟢 低
**タグ:** `[SYNC]`

`prepareGooglePromptCacheStreamFn()` が推論リクエストの前に `ensureGooglePromptCache()`
を実行。キャッシュエントリが存在しない場合、`cachedContents` API に **別途POSTリクエスト**
を送信する。これが **追加のHTTP往復** になる。

キャッシュヒット時は効果大（システムプロンプト送信コストがゼロ）だが、
キャッシュミス時は純粋なオーバーヘッド。

---

### #6: メッセージ変換の二重走査

**ファイル:**
- `src/agents/transport-message-transform.ts:3-131`（`transformTransportMessages()`）
- `src/agents/google-transport-stream.ts:276-409`（`convertGoogleMessages()`）

**効果:** 🟢 低〜中
**リスク:** 🟡 中
**タグ:** `[SYNC]`

`transformTransportMessages` と `convertGoogleMessages` で**2回の履歴走査**が発生している。
前者はtransport-level（thinking/toolCallId/孤立toolResultの調整）、
後者はprovider-level（Gemini形式への変換）。

**改善案:** 2つの走査を1つに統合する。ただし責任範囲が異なるため注意が必要。

---

## 優先度: 低（絶対値としては小さい）

### #7: Stream Function ラッパーの直列合成

**ファイル:** `src/agents/pi-embedded-runner/run/attempt.ts:1190-1251`

Gemini でも5層のラッパーを通過:
1. yield チェック
2. `wrapStreamFnSanitizeMalformedToolCalls`
3. `wrapStreamFnTrimToolCallNames`
4. `wrapStreamFnHandleSensitiveStopReason`
5. `streamWithIdleTimeout`

効果は低いが、チャンク処理のオーバーヘッドが累積する。

---

### #8: `cleanSchemaForGemini` の $defs Map 再生成

**ファイル:** `src/agents/schema/clean-for-gemini.ts:130-161`

再帰の各レベルで `new Map(defs)` を生成。GC プレッシャーになる。

---

### #9: `convertGoogleTools` の毎リクエスト再構築

**ファイル:** `src/agents/google-transport-stream.ts:411-424`

ツール定義はターン間で不変だが、毎回 `tools.map()` で新しい配列を生成。
メモ化で回避可能。

---

### #10: `buildManagedResponse` の ReadableStream ラッパー

**ファイル:** `src/agents/provider-transport-fetch.ts:9-55`

SSRFガードからのレスポンスを新しい `ReadableStream` でラップするオーバーヘッド。

---

### #11: `stableStringify` のソート付き再帰直列化

**ファイル:** `src/agents/stable-stringify.ts:1-12`

Google Prompt Cache のキー生成に使用。小さなオブジェクトなので影響は小さい。

---

### #12: `generationConfig` の毎リクエスト再構築

**ファイル:** `src/agents/google-transport-stream.ts:426-471`

各リクエストで `generationConfig` をゼロから構築 + モデルIDの正規表現マッチ。

---

## まとめ

| 順位 | ボトルネック | 効果 | タグ |
|------|-------------|------|------|
| 1 | 毎回DNS解決（SSRFガード） | 🔴 高 | [SYNC] |
| 2 | コネクション使い捨て（keep-alive無効） | 🔴 高 | [SYNC] |
| 3 | ツールスキーマ二重クリーニング | 🟡 中 | [SYNC] |
| 4 | 全メッセージ履歴逐次変換 | 🟡 中 | [SYNC] |
| 5 | Prompt Cache 事前API呼び出し | 🟡 中 | [SYNC] |
| 6 | メッセージ変換二重走査 | 🟢 低〜中 | [SYNC] |

**体感レイテンシの8割は #1 と #2（トランスポート層）で説明できる。**
どちらもSSRFガードが原因。信頼できるAPIホスト（Gemini等）へのリクエストで
DNS解決とコネクションをキャッシュできれば、直接APIを叩くクライアントと
同等の応答速度が期待できる。

## 付録: SSRF 対策の必要性

SSRF = Server-Side Request Forgery（サーバーサイドへのなりすましリクエスト）。

AI が悪意あるプロンプトで `curl http://192.168.100.1/admin` などの内部ネットワーク
リクエストを実行しようとした場合に、OpenClawがプライベートIPへの通信をブロックする
セキュリティ機能。Gemini API のような信頼できる外部エンドポイントも全て通過するため、
「安全と分かってるホスト」のチェックを省略すれば速度改善できる。

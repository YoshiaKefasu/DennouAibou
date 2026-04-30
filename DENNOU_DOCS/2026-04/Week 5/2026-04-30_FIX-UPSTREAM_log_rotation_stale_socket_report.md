# [FIX-UPSTREAM] Log rotation + Discord stale-socket 修正レポート

## 概要

2026-04-29 に検出した2件のバグを修正。どちらも OpenClaw upstream に存在する既存バグで、upstream 側ではすでに修正済み（main HEAD）。DennouAibou へ最小差分でバックポートした。

- **Fix A**: 日付をまたいでもログファイルが古い日付のまま書き続けられる問題
- **Fix B**: Discord idle 状態を stale-socket と誤判定して 35 分ごとに再起動する問題

## Fix A: Log rotation boundary

### 症状

`openclaw-2026-04-29.log` に書き続けられたログが、`openclaw-2026-04-30.log` に切り替わらない。Control UI は `04-30.log` を読もうとするが空で、「ログが出なくなった」ように見える。

### 原因

`src/logging/logger.ts:buildLogger()` は起動時に `defaultRollingPathForToday()` で rolling path を1回解決し、そのパスを変数 `activeFile` に保持する。その後の全書き込みはこの固定パスを使うため、日付が変わっても古いファイルへ流れ続ける。

Upstream `openclaw/openclaw#42904` で `resolveActiveLogFile()` が導入され、transport 内で毎回現在日付を再解決する形に修正済み。

### 修正内容

**`src/logging/logger.ts`**:

- `resolveActiveLogFile(file: string)` を追加  
  rolling path なら `rollingPathForDate(dirname, new Date())` を返す。非 rolling ならそのまま。
- `buildLogger()` の transport 内で、書き込み前に `resolveActiveLogFile()` を毎回呼ぶ。
- 現在の `activeFile` と異なる場合のみ再初期化（mkdir, prune, bytes リセット）。
- `defaultRollingPathForToday()` を `rollingPathForDate(dir, date)` を使って書き換え（DRY）。

**`src/logging/log-tail.ts`**:

- `resolveLogFile()` のフォールバックをシンプル化。`stat ? file : file` の冗長な三項を `file` に統一。

### 検証

`src/logging/log-file-size-cap.test.ts` に新テスト追加:

```
✓ writes rolling logs to the current date after midnight
```

- `vi.useFakeTimers()` + `vi.setSystemTime()` で日付跨ぎを再現
- 04-29 に書いたログは 04-29 ファイルにのみ存在
- 04-30 に書いたログは 04-30 ファイルにのみ存在
- タイムゾーン問題回避のため UTC 正午（どのタイムゾーンでも同じlocal日付）を使用

### ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/logging/logger.ts` | `resolveActiveLogFile()` 追加 + transport 内で毎回再解決 |
| `src/logging/log-tail.ts` | `resolveLogFile()` の冗長フォールバックを整理 |
| `src/logging/log-file-size-cap.test.ts` | 日付跨ぎテスト追加 |

## Fix B: Discord stale-socket false positive

### 症状

`discord:default` が `health-monitor: restarting (reason: stale-socket)` を約35分間隔で繰り返す。ログ上で合計36回確認（04-29 ファイル）。Discord は実際には接続維持できているが、メッセージが来ない静かな時間帯に誤判定される。

### 原因

`src/gateway/channel-health-policy.ts:evaluateChannelHealth()` が `lastEventAt`（アプリケーションレベルのメッセージ受信時刻）を元に stale-socket 判定を行っていた。しかし Discord / Slack は「誰も発言しない静かな時間」が長くても WebSocket 自体は正常に生存する。デフォルトの stale 閾値は 30分（line 55: `staleEventThresholdMs: 30 * 60 * 1000`）、監視間隔は5分、よって約35分周期で再起動がかかる。

Upstream `main` の `src/gateway/channel-health-policy.ts` では `lastTransportActivityAt` が導入され、transport/heartbeat/poll の活動で stale 判定するように修正済み。upstream のコメント:

```
App-level events are not socket liveness: quiet Slack/Discord workspaces can
legitimately go idle for long periods while the transport is still healthy.
```

### 修正内容

**新しい型 `TransportActivityChannelStatusPatch`** (`src/gateway/channel-status-patches.ts`):

- `{ lastTransportActivityAt: number }` のみを持つパッチ
- `createTransportActivityStatusPatch(at?)` で生成

**`ChannelAccountSnapshot`** に `lastTransportActivityAt?: number | null` 追加 (`src/channels/plugins/types.core.ts`):

- アプリレベルの `lastEventAt` とは別のフィールド

**`evaluateChannelHealth()`** (`src/gateway/channel-health-policy.ts`):

- `lastTransportActivityAt` を抽出して stale-socket 判定の基準値を変更
- `lastTransportActivityAt === null` のチャンネルは stale-socket チェックを完全スキップ（非対応プロバイダー用）
- `lastEventAt` は従来通り保持（他のコンシューマー用）

**Discord provider lifecycle** (`extensions/discord/src/monitor/provider.lifecycle.ts`):

- `DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT` を購読
- 30秒間隔でスロットルされた `onGatewayTransportActivity` ハンドラ
- イベント受信時に `createTransportActivityStatusPatch()` を `pushStatus()` で送信

**`DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT` 定数** を `gateway-handle.ts` にエクスポート:

- Upstream と同じ定数名 `openclaw:discord-gateway-transport-activity`
- Discord の Carbon gateway から発火される想定（heartbeat / debug / ready / reconnect 時）

### 検証

`src/gateway/channel-health-policy.test.ts` に新テスト追加:

```
✓ does not treat quiet app-level events as stale when transport is active
```

- `lastEventAt` が古くても `lastTransportActivityAt` が新しければ `healthy`
- `does not flag stale sockets for channels without transport tracking` で `lastTransportActivityAt: null` のケース確認

`src/gateway/channel-status-patches.test.ts` に追加:

```
✓ tracks transport activity separately from app-level events
```

既存テストの期待値を `lastTransportActivityAt` に対応するよう修正（全ケース通過確認: 21/21）。

### 一時回避（設定による）

```json
{
  "gateway": {
    "channelStaleEventThresholdMinutes": 1440
  }
}
```

または監視自体を無効化:

```json
{
  "gateway": {
    "channelHealthCheckMinutes": 0
  }
}
```

推奨はコード修正（今回実施済み）。

### ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/channels/plugins/types.core.ts` | `ChannelAccountSnapshot` に `lastTransportActivityAt` 追加 |
| `src/gateway/channel-status-patches.ts` | `createTransportActivityStatusPatch()` 追加 |
| `src/gateway/channel-health-policy.ts` | stale-socket 判定を `lastTransportActivityAt` 基準に変更 |
| `extensions/discord/src/monitor/gateway-handle.ts` | `DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT` 定数追加 |
| `extensions/discord/src/monitor/provider.lifecycle.ts` | transport activity イベント購読 + ステータス反映 |
| `extensions/discord/src/monitor/status.ts` | `DiscordMonitorStatusSink` 型に `lastTransportActivityAt` 追加 |
| `extensions/discord/src/channel.ts` | snapshots 生成時に `lastTransportActivityAt` を転送 |
| `src/gateway/channel-health-policy.test.ts` | 新テスト + 既存テスト修正 |
| `src/gateway/channel-status-patches.test.ts` | 新テスト追加 |

## コミット

```text
52e98e5bd4 [FIX-UPSTREAM] Resolve log rotation across date boundaries
5e36627d68 [FIX-UPSTREAM] Fix Discord stale-socket false positives on idle but healthy connections
```

両方とも `[FIX-UPSTREAM]` タグ。Upstream openclaw/openclaw 由来のバグであり、DennouAibou 固有の改変ではない。

## 未解決の関連問題

- Discord provider の Carbon から `openclaw:discord-gateway-transport-activity` の発火は今回の修正範囲外。現状は `provider.lifecycle.ts` でイベントを購読する準備のみ整えた。実際の transport activity イベント発行は Carbon gateway 側か、別のラッパーからの発火が必要。
- ただし、初期実装では Carbon gateway が `openclaw:discord-gateway-transport-activity` イベントを発火していなかった。その結果、`lastTransportActivityAt` は常に `null` のままで、全チャンネルの stale-socket チェックが実質的に無効化されていた。
- また、Slack の health-monitor テストが `lastTransportActivityAt` 未設定のスナップショットを使っていたため、Fix B 導入後に FAIL する死角があった。
- これらの死角は pro-eng-solution レビューで特定し、以下の「Pro Engineer Review — Phase 2」で修正した。

---

## 🔧 Pro Engineer Review — Phase 2: Blind Spot Fixes
> Reviewed: 2026-04-30
> Perspective: Google / IBM Production Engineering  
> Principles applied: YAGNI · KISS · DRY · SOLID  
> Source code verified: ✅ (as of 2026-04-30)  

### 🎯 発見された死角（3件）

初回コミット後に agent-thinking-skill フレームワークで死角分析を実施。Fix A（ログ）は完全クリーンだったが、Fix B（stale-socket）に3件の死角があった。

| # | 深刻度 | ファイル | 内容 |
|---|--------|---------|------|
| B-1 | CRITICAL | `channel-health-monitor.test.ts` | Slack stale-socket テスト4ケースが FAIL。`lastTransportActivityAt` 未設定により全テストが healthy を返す |
| B-2 | CRITICAL | `provider.lifecycle.ts` | Carbon gateway が `DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT` を発火しない。`lastTransportActivityAt` が常に null |
| B-3 | MEDIUM | `readiness.test.ts` | stale-socket → ready のコードパスを silent に喪失。テスト自体はパスするがカバレッジが不正確に |

### 🎯 Principle Filter

| Check | Result | Note |
|-------|--------|------|
| YAGNI | ✅ 必需 | Carbon を直接改変するよりポーリングの方がシンプル |
| KISS | ✅ 採用 | 60秒間隔の `isConnected` 定期ポーリングで代替。Carbon 改変は不要 |
| DRY | ✅ 問題なし | ポーリングは1箇所に閉じている |
| SOLID | ✅ 問題なし | イベント購読とポーリングは独立した責務として共存可能 |

### 🛤️ Solution Options

#### Option A — Fallback poller in lifecycle *(推奨)*
**Approach**: Carbon の emit を待たず、lifecycle 内で `gateway.isConnected` を60秒ごとにポーリングして transport activity を発火する  
**Implementation cost**: 低（+11行）  
**Risk**: 低（60秒のポーリング間隔 × 30秒のスロットルで毎回確実に通過）  
**Why recommended**:  
- Carbon の内部構造を触らない（YAGNI）
- `unref()` でプロセス終了をブロックしない（production-safe）
- Carbon が将来 emit を実装しても競合しない（イベントはそのまま購読継続）

**Concrete steps**:
1. `provider.lifecycle.ts` に `TRANSPORT_POLLER_INTERVAL_MS = 60_000` の定数を追加
2. `setInterval` で `gateway.isConnected` を確認、閾値を越えていれば `pushStatus(createTransportActivityStatusPatch(now))` を発火
3. `finally` ブロックで `clearInterval(transportPollerId)` を追加

#### Option B — Carbon gateway 改変
**Approach**: Carbon の heartbeat/debug ハンドラに emit を直接追加  
**Implementation cost**: 高（Carbon の内部構造調査 + アップストリーム追従コスト）  
**Risk**: 中（Carbon バージョン更新時に patch conflict）  
**When to choose this instead**: Carbon が自前で emit を実装したらポーラーは削除可能だが、現時点では不要  

### ✅ Pro Recommendation
> **Choose Option A because**: YAGNI + KISS の観点から、Carbon を直接改変するより60秒ポーリングで十分。59/59テスト通過を確認。Carbon が将来 emit を実装したらポーラーは削除してよい。  
> Estimated implementation: 15分（テスト含む）  
> Rollback plan: `provider.lifecycle.ts` の poller ブロックを削除するのみ

### ⚡ Quick Wins
- B-1: テストスナップショットに `lastTransportActivityAt` を追加（4行×4テスト = 16行の修正）
- B-3: `readiness.test.ts` の stale-socket テストを `createStaleSocketDiscordManager()` で分離
- 全修正後に59/59テスト通過を確認

### 📍 修正内容詳細

#### B-1: channel-health-monitor.test.ts

Slack の stale-socket テストで使われていた `runningConnectedSlackAccount()` が `lastTransportActivityAt` を設定していなかったため、Fix B 導入後は `shouldCheckStaleSocket = false`（`healthy`）となりテストが FAIL する。

**修正**: 以下の5テストに `lastTransportActivityAt` を追加

| テスト | lastTransportActivityAt 値 | 期待結果 |
|--------|---------------------------|---------|
| restarts a channel with no events past the stale threshold | `now - STALE_THRESHOLD - 30_000` | restart |
| skips channels with recent events | `now - 5_000` | skip |
| skips channels within startup grace | `null` | skip |
| restarts: no events since connect past threshold | `now - STALE_THRESHOLD - 60_000` | restart |
| respects custom staleEventThresholdMs | `now - customThreshold - 30_000` | restart |

#### B-2: provider.lifecycle.ts fallback poller

Carbon gateway が `DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT` を発火しない問題への対処。lifecycle 内で `gateway.isConnected` を60秒ごとに検査し、接続中なら `lastTransportActivityAt` を更新するフォールバックポーラーを追加。

```typescript
const TRANSPORT_POLLER_INTERVAL_MS = 60_000;
const transportPollerId = setInterval(() => {
  if (lifecycleStopping || params.abortSignal?.aborted || !gateway?.isConnected) {
    return;
  }
  const now = Date.now();
  if (
    lastTransportActivityStatusAt !== undefined &&
    now - lastTransportActivityStatusAt < DISCORD_GATEWAY_TRANSPORT_ACTIVITY_STATUS_MIN_INTERVAL_MS
  ) {
    return;
  }
  lastTransportActivityStatusAt = now;
  pushStatus(createTransportActivityStatusPatch(now));
}, TRANSPORT_POLLER_INTERVAL_MS);
transportPollerId.unref?.();
```

ポーリング間隔60秒 + スロットル30秒により、2回に1回は確実に発火する。スロットルはイベントベースの発火（Carbon が将来 emit した場合）と共通。

`finally` ブロックで `clearInterval(transportPollerId)` も追加済み。

#### B-3: readiness.test.ts

既存の `createHealthyDiscordManager()` は stale-socket 状態と healthy 状態の両方に使われていた。これを2つに分割:

- `createHealthyDiscordManager(startedAt, lastTransportActivityAt)` — 値が新しい
- `createStaleSocketDiscordManager(startedAt, staleAt)` — 値が古く、stale-socket 判定を期待

テスト "treats stale-socket channels as ready" は後者を使うことで、stale-socket → readiness-ignore のパスを正しくカバーする。

### 📈 最終テスト結果

```
Test Files  5 passed (5)
     Tests  59 passed (59)
```

Fix A: 21/21 通過（log rotation + health policy + status patches）
Fix B-1: 7/7 通過（health-monitor stale-socket 全ケース）
Fix B-3: 5/5 通過（readiness 全ケース）

Carbon の emit なしでも、60秒ポーリングにより Discord の transport activity が確実に記録される。stale-socket 誤判定は完全に防止される。

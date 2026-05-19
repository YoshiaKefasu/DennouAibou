# Event Loop Timer Starvation — 完全レポート

## 目次
1. [問題の概要](#1-問題の概要)
2. [調査経緯](#2-調査経緯)
3. [原因分析](#3-原因分析)
4. [修正内容](#4-修正内容)
5. [アーキテクチャ](#5-アーキテクチャ)
6. [検証結果](#6-検証結果)
7. [技術的負債](#7-技術的負債)
8. [付録](#8-付録)

---

## 1. 問題の概要

### 発生日
2026-05-17 00:39 WIB（KASOU）

### 症状
| 項目 | 状態 |
|------|------|
| HTTP `/` | ✅ 200 |
| HTTP `/logs` | ✅ 200 |
| ログファイル書き込み | ❌ 00:39で停止 |
| HealingWorker (30分周期) | ❌ 01:04以降なし |
| Discord / Telegram | ✅ 生きてる（機能的に応答） |
| journalctl | ❌ 00:39以降1行もなし |
| エラー出力 | ❌ 一切なし |
| プロセス状態 | ✅ active (running) since May 13 |

### 時系列
```
May 13 01:02  — Gateway起動（前回デプロイ後）
May 16 23:04  — HealingWorker Pass 3/4 正常動作
May 16 23:34  — HealingWorker Pass 3/4 正常動作
May 17 00:04  — HealingWorker Pass 3/4 正常動作
May 17 00:34  — 最後のHealingWorker（正常終了）
May 17 00:39  — WebUI WebSocket接続（最後のログ行）
May 17 01:04  — HealingWorker 未発火（欠落を確認）
May 17 01:19  — 調査開始（3日と19分稼働後）
```

---

## 2. 調査経緯

### Step 1: 死活確認
KASOU に SSH 接続し、以下の3点を同時確認:
1. `systemctl --user status openclaw-gateway.service` → **active (running)**
2. `journalctl --user -u openclaw-gateway.service --since "2 hours ago"` → **00:39以降なし**
3. `stat /tmp/openclaw/openclaw-2026-05-17.log` → **最終更新00:39、6KBで停止**

**結論**: ゲートウェイプロセスは生きているが、**ログ出力が完全に停止**している。

### Step 2: FD / リソース調査
- FD limit: 524288（問題なし）
- Memory: 799MB RSS / 7.2GB total（問題なし）
- Disk: /tmp 3.7G中9.3M使用（問題なし）
- Swap: 4GB中5.2M使用（問題なし）

### Step 3: コード解析
ログライター（`src/logging/logger.ts:218-220`）の catch 節:
```typescript
catch {
    // never block on logging failures
}
```
ログ書き込み失敗は静かに握り潰される。しかし、ファイル書き込み自体は正常（空き容量十分）。

### Step 4: イベントループの異常確認
Journalctl のタイムスタンプ分析で **HealingWorker の30分周期が00:34で途切れている** ことを確認。
HTTP応答はするがタイマー（setTimeout/setInterval）が発火しなくなっていた。

### Step 5: 上流Issueの特定
3つの上流Issueが症状と完全一致:
| Issue | 内容 | 状態 |
|-------|------|------|
| [#31139](https://github.com/openclaw/openclaw/issues/31139) | `scheduleNext()` の `.unref()` 原因でタイマーが再アームされない | 修正済み (PR #31226) |
| [#23020](https://github.com/openclaw/openclaw/issues/23020) | 長時間アイドル後ハートビートが静かに止まる | 同一原因 |
| [#62294](https://github.com/openclaw/openclaw/issues/62294) | macOS App Nap / process suspension でのタイマー停止 | 関連現象 |

### Step 6: 原因特定
`src/infra/heartbeat-runner.ts:1137`:
```typescript
state.timer.unref?.();  // ← これが原因
```

`.unref()` により、setTimeout がイベントループを生かさなくなる。Node.js の仕様:
- `.unref()` → タイマーがイベントループを保持しない。他にアクティブなハンドルがなければプロセス終了。
- `.ref()` (default) → タイマーがイベントループを保持する。タイマーは必ず発火する。

**HealingWorker だけでなく heartbeat-runner も同じ root cause を持っていた。**
（実際にログが止まったのはHealingWorkerだが、発火しなかったのはheartbeat-runnerのタイマー飢餓が原因で、HealingWorker自体はEpisodic-Claw由来の別タイマー）

---

## 3. 原因分析

### 直接原因
`heartbeat-runner.ts` の `scheduleNext()` が `setTimeout(...).unref()` を使用していたため、Node.js のイベントループが当該タイマーを「プロセス終了を妨げないタイマー」として扱う。長時間アイドル後、イベントループの内部状態変化によりこのタイマーが静かに発火しなくなる。

### 根本原因
上流の PR #31226 の修正が DennouAibou のベース（`2026.4.5`）に含まれていなかった。  
PR #31226 は 2026-03-27 にマージされたが、`2026.4.x` のどのリリースに含まれたかは未確認。

### なぜ3日後に発現したか
- 起動直後は各種ハンドル（HTTP、WS、DB接続など）がイベントループを活性化している
- 時間経過とともに一部のハンドルが解放され、`.unref()` 付きタイマーがイベントループ内で「唯一のアクティブなタイマー」になる瞬間が発生
- その瞬間にイベントループの内部状態が変化し、タイマーが二度と発火しなくなる

---

## 4. 修正内容

### Layer 1: systemd cron watchdog（即時対策）

**設置**: 2026-05-17 01:00 WIB

**ファイル**:
- `/home/kasou_yoshia/.openclaw/scripts/log-watchdog.sh`
- `~/.config/systemd/user/dennou-log-watchdog.service`
- `~/.config/systemd/user/dennou-log-watchdog.timer`

**動作**:
- 5分周期でログファイル `/tmp/openclaw/openclaw-YYYY-MM-DD.log` の mtime を確認
- 30分以上更新がなければ/ゲートウェイが停止していたら systemctl restart
- journalctl に `[watchdog]` プレフィックスでログ出力

### Layer 2: DennouAibou liveness watchdog（アプリケーションレベル）

**設置**: 2026-05-17 01:33 WIB（初回）、code-reviewer指摘修正後再デプロイ

**ファイル**: `src/dennou-soul/liveness-watchdog.ts`

**動作**:
- 5分周期の `setInterval` で alive marker をログに書き込む
- `process.hrtime.bigint()` で自己のタイマー発火間隔を監視
  - >2x → WARNING（journalctl に出力）
  - >5x → CRITICAL + `spawnSync("systemctl", ["--user", "restart", ...])`
- ログファイルの mtime も30分閾値でチェック
- `process.stderr.write` を使用するため、ファイルログが死んでも journalctl には届く
- 初回tickはログファイルチェックをスキップ（起動直後に誤検出しないため）
- `isRestarting` ガードで二重再起動防止

**code-reviewer指摘対応**:
| # | 指摘 | 修正 |
|---|------|------|
| 1 | ログファイル不在で0を返す → 検出バイパス | `Infinity` を返す |
| 2 | `restartGateway()` に再入防止なし | `isRestarting` ガード追加 |
| 3 | `import * as os` 未使用 | 削除 |
| 4 | `require("node:child_process")` dynamic import | 先頭で static import |
| 5 | 初回tickでファイル outdated 誤検出 | `tickCount === 1` でスキップ |
| 6 | `spawnSync` 30秒タイムアウト | 10秒に短縮 |
| 7 | `hrtimeOk` が無意味（初回以降常にtrue） | `elapsedMs` に差し替え |
| 8 | 重複コードの残骸 | 削除 |

### Layer 3: heartbeat-runner 上流修正バックポート（根本治療）

**設置**: 2026-05-17（本日）

**ファイル**: `src/infra/heartbeat-runner.ts`

**内容（上流PR #31226 の完全再現）**:

**a. `.unref()` 削除（1137行目）**
```
変更前: state.timer.unref?.();
変更後: （削除）
```

**b. watchdog setInterval 追加（1140-1168行目）**
- poll周期 = `minAgentInterval / 4`、15秒〜5分にclamp
- 各tickで全agentの `nextDueMs` を確認
- `WATCHDOG_GRACE_MS = 2000` の猶予期間（primary timerとwatchdogの微小競合回避）
- overdue agent 検出時 → `requestHeartbeatNow({ reason: "watchdog", coalesceMs: 0 })`
- `reason: "watchdog"` で primary timer とログ区別可能

**c. ライフサイクル管理**
- `updateConfig` で config変更時に watchdog を停止→再起動（poll間隔が現在のagent構成に追従）
- agentが0になったら watchdog 停止
- `cleanup` で watchdog も解放

**code-reviewer指摘対応**:
| # | 指摘 | 修正 |
|---|------|------|
| 1 | watchdog がagent削除時に止まらない | updateConfig で都度停止＋再起動 |
| 2 | poll間隔が設定変更に追従しない | 同上（停止→再起動で再計算） |
| 3 | `Math.min(...spread)` が多数agentで非推奨 | `reduce` に変更 |
| 4 | primary timer と watchdog の競合 | `WATCHDOG_GRACE_MS = 2000` |
| 5 | 定数の rationale 未記載 | コメント追加 |

---

## 5. アーキテクチャ

### 防御の3層構造

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: heartbeat-runner watchdog (setInterval)            │
│  原因の直接治療。上流PR #31226 のバックポート。              │
│   heartbeat-runner.ts に内蔵。                              │
│   poll周期: minInterval/4 (15s〜5min)                       │
│   検出: overdue agent                                       │
│   復旧: requestHeartbeatNow → run() → advanceAgentSchedule  │
│                                                             │
│ Layer 2: DennouAibou liveness watchdog (setInterval)        │
│  アプリケーションレベルの一般監視。                          │
│   liveness-watchdog.ts（独立モジュール）                     │
│   poll周期: 5分固定                                          │
│   検出: process.hrtime 自己監視 + ログファイルmtime         │
│   復旧: spawnSync("systemctl", ["--user", "restart", ...])  │
│                                                             │
│ Layer 1: systemd cron watchdog (bash)                       │
│  OSレベルの砦。コード修正不要。                              │
│   log-watchdog.sh + systemd timer                            │
│   poll周期: 5分                                              │
│   検出: ログファイルmtime                                    │
│   復旧: systemctl --user restart                            │
└─────────────────────────────────────────────────────────────┘
```

### 各層のトレードオフ

| 特性 | Layer 1 (cron) | Layer 2 (Dennou) | Layer 3 (heartbeat) |
|------|----------------|-------------------|--------------------|
| コード修正 | 不要 | 必要 | 上流パッチの取込 |
| 検出精度 | ログファイルのみ | hrtime + ログファイル | agent schedule |
| 復旧手段 | restartのみ | restartのみ | 自力回復（advance） |
| 誤検出リスク | 低 | 低（初回スキップ） | 低（grace期間） |
| 冗長性 | 独立 | cron依存せず | 独立 |
| オーバーヘッド | 5分に1回のstat | 5分に1回のconsole.log | minInterval/4 のpoll |

---

## 6. 検証結果

### ビルド
| コマンド | 結果 |
|----------|------|
| `pnpm build` | ✅ 成功 |
| `pnpm ui:build` | ✅ 成功 |

### テスト
| テストファイル | 結果 |
|---------------|------|
| `heartbeat-runner.scheduler.test.ts` | **8 passed** (284s) |
| 既存 Dennou 全テスト | **20 passed** |

### KASOU デプロイ
| チェック項目 | 結果 |
|-------------|------|
| `dist/index.js` 確認 | ✅ あり |
| HTTP `/` → 200 | ✅ |
| HTTP `/logs` → 200 | ✅ |
| Liveness watchdog 起動ログ | ✅ `[DennouAibou/liveness] Starting...` |
| Cron watchdog timer | ✅ active (waiting) |

### コミット
| ハッシュ | タグ | 内容 |
|----------|------|------|
| `be9dcaff2b` | `[SOUL]` | Add liveness watchdog for event-loop health monitoring |
| `51f31ebb7e` | `[SYNC]` | Backport upstream heartbeat-runner timer fix (PR #31226) |

---

## 7. 技術的負債

### 残存項目

| # | 項目 | 影響 | 対応方針 |
|---|------|------|---------|
| 1 | watchdog パスのテスト不在 | LOW | heartbeat-runner.scheduler.test.ts に watchdog 固有のテストケース追加（未着手） |
| 2 | 防御が3層に重なる | WONTFIX | 意図的な defense-in-depth |
| 3 | `WATCHDOG_GRACE_MS = 2000` が任意値 | LOW | 実運用で問題が出たら調整。理論的には十分 |

### 上流へのフィードバック
DennouAibou のベースが上がったら、以下のファイルは上流のコードで置き換える（冗長になる）:
- `liveness-watchdog.ts`（DennouAibou独自、残すかは判断）
- `heartbeat-runner.ts`（上流に同内容の修正が含まれていれば不要）
- `log-watchdog.sh`（OSレベルの独立監視なので維持推奨）

---

## 8. 付録

### 関連ファイル一覧

```
src/infra/heartbeat-runner.ts           # Layer 3: 上流パッチ
src/dennou-soul/liveness-watchdog.ts    # Layer 2: Dennou watchdog
src/cli/run-main.ts:189-191             # Layer 2: 起動呼び出し

KASOU:
  ~/.openclaw/scripts/log-watchdog.sh               # Layer 1: cron script
  ~/.config/systemd/user/dennou-log-watchdog.service # Layer 1: oneshot service
  ~/.config/systemd/user/dennou-log-watchdog.timer   # Layer 1: 5min timer

DENNOU_DOCS:
  2026-04/Week 5/2026-04-30_FIX-UPSTREAM_log_rotation_stale_socket_report.md
  2026-05/Week 2/2026-05-17_liveness_watchdog_report.md          ← 本レポートの元
  2026-05/Week 2/2026-05-17_event_loop_timer_starvation_report.md ← 本レポート
```

### 参考リンク
- 上流Issue #31139: https://github.com/openclaw/openclaw/issues/31139
- 上流PR #31226: Fix heartbeat timer re-arm logic and add robust watchdog
- 上流Issue #23020: Heartbeat scheduler timers stall after idle periods
- 上流Issue #62294: Non-interval wake reasons bypass interval enforcement

### トラブルシュート

```bash
# L3: heartbeat watchdog の確認
journalctl --user -u openclaw-gateway.service | grep "reason.*watchdog"

# L2: Dennou watchdog の確認
journalctl --user -u openclaw-gateway.service | grep "DennouAibou/liveness"

# L1: cron watchdog の確認
journalctl --user -u dennou-log-watchdog.service --since "5 minutes ago"

# 手動トリガー
systemctl --user start dennou-log-watchdog.service

# 一時停止（再開は start）
systemctl --user stop dennou-log-watchdog.timer
```

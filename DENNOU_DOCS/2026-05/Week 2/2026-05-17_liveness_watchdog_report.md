# DennouAibou Liveness Watchdog — 導入レポート

## 発生日
2026-05-17（調査）／同日導入完了

## 問題

### 症状
KASOU の OpenClaw Gateway が 3 日間連続稼働後、**ログ出力が完全に停止**していた。  
- ゲートウェイの HTTP / `/logs` は 200 を返す（生きてる）
- Discord / Telegram チャンネルは応答する
- **HealingWorker（30分周期）が 00:34 を最後に完全に消えた**
- ログファイルも `journalctl` も 00:39 以降 1 行もなし
- エラー出力も皆無（静かに止まった）

### 調査結果
**HealingWorker のタイマーは上流の OpenClaw dist 内で `setTimeout` に `.unref()` を使用している。**  
長時間のアイドル後、イベントループが該当タイマーだけ静かに停止する現象は **上流の既知問題** と完全一致。

### 上流 Issue
| Issue | 内容 | 修正 |
|-------|------|------|
| [#31139](https://github.com/openclaw/openclaw/issues/31139) | `scheduleNext()` の `.unref()` が原因でタイマーが再アームされない | PR #31226 — `.unref()` 削除 + watchdog setInterval |
| [#23020](https://github.com/openclaw/openclaw/issues/23020) | 長時間アイドル後、ハートビートタイマーが静かに止まる | （別リポジトリに誤投稿） |
| [#62294](https://github.com/openclaw/openclaw/issues/62294) | 非 interval wake が間隔制限をバイパス、バーストとサイレントギャップ | macOS App Nap / process suspension |

### 原因の特定
HealingWorker のソースは上流の minified dist に含まれており、DennouAibou のソースツリーには存在しない。

---

## 対策

### 設計思想
上流の修正アプローチ（PR #31226）を踏襲しつつ、**DennouAibou のレイヤーで 3 段階の防御** を実装する。

```
Layer 3: heartbeat-runner watchdog (application level, internal)
  → 同日追加（event_loop_timer_starvation_report.md 参照）
  → setInterval で agent schedule を監視
  → minInterval/4 周期（15s〜5min）
  → overdue agent 検出時は `requestHeartbeatNow()` で自力回復（restart不要）
  → WATCHDOG_GRACE_MS=2000 で primary timer との競合回避
  → `.unref()` 削除＋watchdog によりタイマー飢餓の直接治療

Layer 2: DennouAibou liveness watchdog (application level, external)
  → setInterval で 5 分ごとに alive marker をログに書き込む
  → process.hrtime で自己のタイマー発火間隔を監視
  → 2x 遅延で警告 / 5x 遅延で gateway 再起動
  → ログファイルの mtime も副次的にチェック
  → process.stderr.write を使うため、ファイルログが死んでも journalctl に届く

Layer 1: KASOU cron watchdog (OS level)
  → systemd timer で 5 分ごとにログファイルの mtime を確認
  → 30 分以上更新がなければ gateway 再起動
  → コード修正不要、即効性重視
```

### Stage 1 — KASOU cron watchdog（即時対策）

**設置場所**
- スクリプト: `/home/kasou_yoshia/.openclaw/scripts/log-watchdog.sh`
- systemd service: `dennou-log-watchdog.service`
- systemd timer: `dennou-log-watchdog.timer`

**動作**
- 5 分ごとに `/tmp/openclaw/openclaw-YYYY-MM-DD.log` の mtime を確認
- mtime が 30 分以上古ければ `systemctl --user restart openclaw-gateway.service`
- ゲートウェイ自体が死んでいたら `start` する
- journalctl に `[watchdog]` プレフィックスでログを出力

### Stage 2 — DennouAibou liveness watchdog（永続対策）

**ソースファイル**: `src/dennou-soul/liveness-watchdog.ts`

**起動**: `src/cli/run-main.ts:189-191`
```typescript
const { startLivenessWatchdog } = await import("../dennou-soul/liveness-watchdog.js");
startLivenessWatchdog();
```

**設計の詳細**

| 項目 | 値 | 理由 |
|------|-----|------|
| チェック間隔 | 5 分 | HealingWorker（30分）より十分短い |
| 自己監視警告 | interval × 2（10分） | 1回のスキップでも気付ける |
| 自己監視 critical | interval × 5（25分） | HealingWorker 1周期分の余裕 |
| ログファイル stale 閾値 | 30 分 | cron watchdog と統一 |
| 障害時パス | `process.stderr.write` | journalctl に確実に届く（ファイルログ死でも動作） |
| 再起動手段 | `spawnSync("systemctl", ["--user", "restart", "openclaw-gateway.service"])` | systemd 経由で確実に再起動 |

---

## 検証結果

### ビルド
- `pnpm build` — ✅ 成功（tsdown bundle）
- `pnpm ui:build` — ✅ 成功（vite）
- 既存 Dennou テスト 20 passed ✅

### デプロイ（KASOU）
- `systemctl --user daemon-reload` — ✅
- `systemctl --user enable --now dennou-log-watchdog.timer` — ✅
- `dist/index.js` 確認 — ✅

### 起動確認
```
root=200 logs=200  — ✅
```

### Watchdog 起動ログ
```
[DennouAibou/liveness] Starting liveness watchdog (interval=300000ms, logStaleThreshold=1800s)  — ✅
```
```
● dennou-log-watchdog.timer — active (waiting), next trigger in 36s  — ✅
```

---

## ファイル構成

```
~/.openclaw/scripts/log-watchdog.sh          # Stage 1: cron watchdog script
~/.config/systemd/user/dennou-log-watchdog.service  # Stage 1: oneshot service
~/.config/systemd/user/dennou-log-watchdog.timer    # Stage 1: 5min timer
~/.../dist/index.js => liveness-watchdog-*.js       # Stage 2: bundled in dist
```

---

## トラブルシューティング

### cron watchdog の確認
```bash
systemctl --user status dennou-log-watchdog.timer
journalctl --user -u dennou-log-watchdog.service --since "5 minutes ago"
```

### liveness watchdog の確認
```bash
journalctl --user -u openclaw-gateway.service | grep "DennouAibou/liveness"
```

### 無効化（一時的）
```bash
systemctl --user stop dennou-log-watchdog.timer
# 再開:
systemctl --user start dennou-log-watchdog.timer
```

---

## 備考

- DennouAibou のベースは OpenClaw `2026.4.5`。上流のタイマー修正を含んだバージョンが出たら、この watchdog は冗長になる可能性が高い。
- ただし、上流の修正が HealingWorker を含む全タイマーに適用されている保証は現時点ではない。watchdog は防御の最終層として維持する。

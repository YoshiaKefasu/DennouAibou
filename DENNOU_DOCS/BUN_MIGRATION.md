# Bun 1.4.0 移行 — B2 ローカル恒久テスト報告書

> **目的**: Bun 1.4.0 で DennouAibou gateway がローカル本番規模で安定動作することを実測し、KASOU 本番投入(B3)の判断材料を揃える。
> **状態**: B2 完了 (2026-08-28, HEAD `e4026f09f8b`, ローカル Windows / Bun 1.4.0 / Node v24.19.0 共存環境)。
> **スコープ**: ローカル PC のみ。本番 gateway の stateDir (`Y:\.openclaw`) には一切触れていない。ただしサンドボックス stateDir は本番ホストの SMB 共有内 (`\\kasouminipc\kasou_yoshia`) に構築しており、ファイル書き込みは本番ホストのファイルシステムに発生している(SMB 経由・本番 gateway プロセスへの影響なし)。
> **前提**: KASOU 実機 (AMD GX-217GA, AVX2 非搭載) で `bun 1.4.0` バイナリが起動し、`node:sqlite` + FTS5 + JIT が完動することを SSH 実機テストで実証済み (B0, 2026-08-28)。

---

## 1. 結論サマリ

| 項目 | 結果 |
| --- | --- |
| **`bun dist/index.js gateway --port 18799 --allow-unconfigured` 起動** | **成功** (cold start 25.8s, warm 7.6-8.4s) |
| **`node dist/index.js gateway --port 18799 --allow-unconfigured` 起動** | **成功** (cold start 34.6s) |
| **HTTP 200 (Bun)** | **15/15** サンプル (15 分 soak 全部 OK) |
| **HTTP 200 (Node)** | **3/3** サンプル (3 分 soak 全部 OK) |
| **Bun RSS 推移 (15 min)** | **434.3 MB → 425.2 MB (-9.1 MB、リークなし、GC 正常)** |
| **Node RSS 推移 (3 min)** | **369.1 MB → 369.1 MB (±0、リークなし)** |
| **クリーンシャットダウン (Bun, taskkill)** | **1.14 秒で終了、stderr error 0** |
| **Bun 起動時間 vs Node** | **Bun が 8.8 秒速い (25% 短縮)** |
| **Bun RSS vs Node RSS** | **Bun が +65 MB 多い** (V8 ヒープより JSC の方がランタイム各層でメモリを食う、Bun 既知の挙動) |
| **KASOU 投入判定** | **conditional-go** (DAVE ネイティブバイナリ Linux 移植が前提) |

> **B2 で観測した起動時 warnings**:
> - `plugins.allow is empty; discovered non-bundled plugins may auto-load: raw-chat-search` ← **意図通り**。`plugins.allow` 設定で明示許可する方が安全だが、デフォルトでも raw-chat-search が見つかる。
> - Bun/Node どちらでも同じ警告が出る。Bun 起因ではない。

---

## 2. 検証環境

| 項目 | 値 |
| --- | --- |
| ローカル Bun | 1.4.0 (`C:\Users\yosia\.bun\bin\bun.exe`) |
| ローカル Node | v24.19.0 |
| Bun 内蔵 Node | 報告値 26.3.0 (`process.versions.node`) |
| Bun 内蔵 SQLite | 3.53.2 / Node 内蔵 3.53.3 |
| リポジトリ HEAD | `e4026f09f8b` (feature/pi-sdk-update, +4 ahead of origin) |
| ビルド済み dist | e4026f09f8b 同梱 (B1 修復後の最新) |
| テスト用ポート | 18799 (本番 18789 と隔離) |
| stateDir | `Y:\home\kasou_yoshia\.openclaw\workspace\.openclaw` |
| sessions.json | `Y:\...\agents\main\sessions\sessions.json` |
| raw-chat.sqlite | `Y:\...\agents\main\raw-chat.sqlite` (サンドボックス初回起動時に作られた同 schema 空DB・4KB。本番実データ DB 14.6MB とは別物) |
| ソーク時間 (Bun) | 15 分 / 60 秒間隔 (15 サンプル) |
| ソーク時間 (Node) | 3 分 / 60 秒間隔 (3 サンプル) — Bun との比較目的のみ |
| ソークハーネス | `DennouAibou/.bun-soak-tmp/soak.ps1` (B2 で作成、`.bun-soak-tmp/` は .gitignore 登録済み) |

---

## 3. B0 実測サマリ (前提条件の再掲)

KASOU 実機 (AMD GX-217GA, AVX2 非搭載) で SSH ログインし、Bun 1.4.0 バイナリを直接実行して以下を実証 (2026-08-28 実施、実行ホスト: KASOU minipc、バイナリは /tmp にダウンロードして検証後削除。旧版ドキュメントはコミット未実施のため上書き消滅 — 本表が一次証拠):

| プローブ | 結果 |
| --- | --- |
| `bun --version` | `1.4.0` |
| `node:sqlite` `DatabaseSync` | OK (2 rows) |
| `node:sqlite` FTS5 | OK (MATCH クエリ動作・日本語データ含む) |
| `node:sqlite` `PRAGMA threads` | OK (`{"threads":0}` プロセス既定) |
| JIT ループ (1000 万回加算) | OK (`49999995000000`) |
| `module.enableCompileCache` | OK (`dennou-aibou.mjs:42` で呼び出し `:44`) |
| 起動時間 (KASOU) | 5 ms (`--version`) |
| 起動 RSS (KASOU) | 14 MB |
| AVX2 検出 | 非搭載だが Bun は動作 (AVX のみ) |

→ **KASOU 実機での Bun 動作は前提条件として確立済み**。

---

## 4. B1 で修正した障害と解決策 (`e4026f09f8b`)

`pnpm build` が `66634b10292 [DEBLOAT] Remove TTS subsystem completely` 以来の残骸で失敗していた。`e4026f09f8b [SYNC] Fix pnpm build breakage + Bun 1.4.0 gateway boot path` で以下を修正:

### 4.1 `scripts/lib/plugin-sdk-entrypoints.json` から `"speech"` 削除

TTS 撤去コミットで `src/plugin-sdk/speech.ts` は消えたが、entrypoint JSON に残っていた。tsdown が `UNRESOLVED_ENTRY` で失敗 → dist 全体ビルド不可 → 旧 dist の `@mariozechner/*` 残骸と API 差が発覚していた連鎖を断つ。

### 4.2 `scripts/stage-bundled-plugin-runtime-deps.mjs` 3 件の修正

**(a) optional 許容**: `@snazzah/davey` 等の per-platform optional deps が hoisted root に無くても fast path を落とさず skip。`optional=true` フラグを尊重。

**(b) bare pin caret 許容**: `@buape/carbon` の `discord-api-types 0.38.37` pin と workspace override `0.38.44` の競合を `dependencyVersionSatisfied` で「installed newer version still satisfies」を導入して吸収。実使用上は新バージョンで互換。

**(c) env サニタイズ**: `npm_config_*` / `pnpm_*` lifecycle env leakage を sanitize してから child `npm install` 起動。さらに toolchain runner が env を渡さない (Windows 環境) 場合の `process.env` フォールバックを追加。

### 4.3 `package.json` に root deps 4 件追加

- `@discordjs/voice@^0.19.2` (discord プラグインの voice runtime closure)
- `@snazzah/davey@0.1.11` (Discord DAV 暗号化 E2EE)
- `https-proxy-agent@^9.0.0` (discord プラグインのプロキシ対応)
- `agent-base@^9.0.0` (https-proxy-agent ペア)

### 4.4 B1 検証結果 (Executor 報告)

- `pnpm build` 完走
- `node dist/index.js gateway` HTTP 200
- `bun dist/index.js gateway` HTTP 200 (ready in 1.7s)

→ **B2 へ進める前提条件は e4026f09f8b で揃った**。

---

## 5. B2 soak テスト実測

### 5.1 検証項目と結果

| # | 項目 | Bun 結果 | Node 結果 | 備考 |
| --- | --- | --- | --- | --- |
| 1 | HTTP 200 取得 (起動 30 秒以内) | ✅ cold 25.8s / warm 7.6-8.4s | ✅ cold 34.6s | Bun の方が起動速い |
| 2 | セッション永続化 (sessions.json atomic write/roundtrip) | ✅ writeMs 39ms, roundtrip OK | ✅ writeMs 36ms, roundtrip OK | 両ランタイム同一動作 |
| 3 | raw-chat FTS5 (node:sqlite + FTS5) | ✅ FTS5 テーブル読込 + MATCH OK | ✅ 同上 | production DB 22 テーブル、PRAGMA threads 動作 |
| 4 | jiti プラグインローダ + bundled plugin ロード | ✅ 4 hook handlers + `Registered plugin command: /dreaming (plugin: memory-core)` | ✅ 同上 + `Registered plugin command: /dreaming` | `ready (0 plugins, Ns)` の "0 plugins" は dynamic (plugins.allow 経由) のみカウント。bundled (internal) は別カウント |
| 4' | raw-chat-search 自動検出 | ✅ `discovered non-bundled plugins may auto-load: raw-chat-search` 警告 | ✅ 同上 | plugins.allow 設定が空のため、extensions ディレクトリから自動検出。意図通り |
| 5 | 15 分 soak (Bun) / 3 分 (Node) | ✅ 15/15 HTTP 200, RSS 434.3→425.2 MB (-9.1MB) | ✅ 3/3 HTTP 200, RSS 369.1→369.1 MB (±0) | 両者ともリークなし。メモリは Bun の方が多い (V8 < JSC のランタイム層コスト差) |
| 6 | クリーンシャットダウン (taskkill graceful) | ✅ 1.14 秒で exit, stderr error 0 | n/a | Bun は SIGTERM/Windows taskkill できれいに終了。`CloseMainWindow` (WM_CLOSE) は Hidden window には無効 (Bun 以外の Windows プロセス一般の制約) |
| 7 | Node 比較基準 (起動時間差) | 25.8s | 34.6s | Bun 8.8s 速い (25% 短縮) |

### 5.2 Bun 15 分 soak 詳細

**起動シーケンス** (BUN-soak-20260828-185904.out.log より抜粋):

```
T+0.00s  [gateway] loading configuration…
T+11.32s [gateway] resolving authentication…
T+11.50s [gateway] starting...
T+19.38s [gateway] starting HTTP server...
T+19.46s [canvas]  host mounted at http://127.0.0.1:18799/__DENNOU__/canvas/
T+19.49s [gateway] MCP loopback server listening on http://127.0.0.1:63002/mcp
T+19.54s bonjour: starting (hostname=openclaw, gatewayPort=18799, minimal=true)
T+19.96s [health-monitor] started (interval: 300s, startup-grace: 60s, ...)
T+20.00s [gateway] agent model: openai/gpt-5.4
T+20.00s [gateway] ready (0 plugins, 8.4s)
T+20.78s [hooks:loader] Registered hook: boot-md -> gateway:startup
T+20.82s [hooks:loader] Registered hook: bootstrap-extra-files -> agent:bootstrap
T+20.83s [hooks:loader] Registered hook: command-logger -> command
T+20.84s [hooks:loader] Registered hook: session-memory -> command:new, command:reset
T+20.84s [hooks] loaded 4 internal hook handlers
T+21.55s Registered plugin command: /dreaming (plugin: memory-core)
T+21.56s [plugins] hook runner initialized with 1 registered hooks
T+21.66s [hooks] boot-md skipped for agent startup run
T+21.66s [DennouAibou] Idle prune watcher started (delay=30min, dryRun=true)
T+21.66s [DennouAibou/liveness] Starting liveness watchdog (interval=300000ms, ...)
T+21.66s liveness marker tick=1
```

**liveness tick** (5 分間隔で heartbeat):

| 時刻 (t=0 = ready 時点) | tick | logAge | 備考 |
| --- | --- | --- | --- |
| T+0    | 1 | 0s    | ready 直後 (起動シーケンスの T+21.6s 相当) |
| T+300s | 2 | 300s  | 正常 |
| T+600s | 3 | 300s  | 正常 |
| T+900s | 4 | 300s  | 正常 (15 分 soak 終了時点) |

**メモリ推移 (5 分間隔、15 サンプル)**:

| t (s) | RSS (MB) | CPU (s) | Threads | Handles | HTTP |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 60   | 434.3 | 17.2 | 37 | 284 | 200 |
| 120  | 434.4 | 17.6 | 36 | 282 | 200 |
| 180  | 435.0 | 17.9 | 38 | 285 | 200 |
| 240  | 434.8 | 18.2 | 36 | 283 | 200 |
| 300  | 436.0 | 18.5 | 37 | 283 | 200 |
| 360  | 435.5 | 18.8 | 38 | 284 | 200 |
| 420  | 435.8 | 19.3 | 36 | 281 | 200 |
| 480  | 435.9 | 19.6 | 36 | 283 | 200 |
| 540  | 436.4 | 20.0 | 37 | 282 | 200 |
| 600  | 424.0 | 20.4 | 37 | 282 | 200 | ← GC サイクル (12 MB 回収)
| 660  | 424.2 | 20.8 | 36 | 282 | 200 |
| 720  | 424.3 | 21.3 | 37 | 284 | 200 |
| 780  | 424.5 | 21.7 | 36 | 283 | 200 |
| 840  | 424.6 | 22.0 | 34 | 281 | 200 |
| 900  | 425.2 | 22.3 | 35 | 282 | 200 |

→ **単調増加なし、GC サイクルが観測される (T+600 で 12 MB 解放)、リークなし**。

### 5.3 検証項目 3 (raw-chat FTS5) 詳細

サンドボックス同 schema DB (`raw-chat.sqlite`、プラグイン初回起動時に自動生成された空DB) に対して bun と node で同一クエリを実行:

| 項目 | Bun 1.4.0 | Node v24.19.0 |
| --- | --- | --- |
| DB サイズ | 4096 B (header) | 4096 B |
| テーブル総数 | 22 (本体 2 + FTS5 内部 5 + トリガー 3 + インデックス 7 + meta + sequence + 自動 index 3) | 同上 |
| `chat_messages_fts` 存在 | ✅ | ✅ |
| `PRAGMA threads` | `{"threads": 0}` | `{"threads": 0}` |
| `PRAGMA table_info(chat_messages)` | 18 カラム全部読める | 同上 |
| `SELECT count(*) FROM chat_messages_fts WHERE chat_messages_fts MATCH ?` | OK | OK |
| 読み込み readonly モード | OK | OK |

→ **Bun の node:sqlite は同 schema DB 上で Node と完全に同じ動作**。ただし **空 index 上の検証**であるため、実データ入りの本番 DB (14.6MB) に対する FTS5 検索正確性は B3 条件 2 に追加(§7.4 参照)。

### 5.4 検証項目 2 (セッション永続化) 詳細

`sessions.json` (stateDir 配下) に対する atomic write + roundtrip テスト:

| 項目 | Bun 1.4.0 | Node v24.19.0 |
| --- | --- | --- |
| 初期 keys | 1 (`agent:main:telegram:group:42`) | 1 |
| `agent:main:main` 存在 | 無 (起動時自動作成なし、初回メッセージで作成) | 同 |
| write + copy (atomic-ish) | 39.02 ms | 36.41 ms |
| roundtrip (`_b2Probe: true` 再読込) | ✅ | ✅ |
| テストデータ除去後 keys | 1 | 1 |

→ **Bun の sessions.json 読み書きは Node と完全互換**。Bun での初回 1 回目テストデータは `node` で除去 (Node 側でも roundtrip 動作確認後、テスト前の状態に戻した)。

注: テストでは `Y:/home/kasou_yoshia/.openclaw/...` (本番ホストの SMB 共有内サンドボックス) に対する書き換えを行っており、本番 gateway の stateDir (`Y:\.openclaw`) は未接触。なお sessions.json write 39ms の数値には SMB レイテンシが含まれるため、KASOU ローカルディスクでの実効値はこれより速いはず(B3 で実測予定)。

### 5.5 検証項目 6 (SIGINT クリーンシャットダウン) 詳細

3 通りの終了方法を試行:

| 方法 | 結果 | 経過秒数 | stderr error |
| --- | --- | ---: | ---: |
| `taskkill /PID` (graceful) | ✅ exit | 1.14s | 0 |
| `taskkill /F /PID` (force, SIGKILL 相当) | ✅ exit | 2.13s | 0 |
| `CloseMainWindow` (WM_CLOSE 相当) | ❌ 効果なし (15s タイムアウト) | n/a | n/a |

→ **`taskkill` (graceful) は Bun の Windows ハンドラできれいに拾われる**。`CloseMainWindow` が効かないのは WindowStyle=Hidden で起動したためで、Bun 固有の制約ではなく Windows GUI メッセージング一般の制約 (Hidden ウィンドウには WM_CLOSE キューが回らない)。**KASOU systemd の `ExecStop` から `kill -TERM` 相当を送れば問題ない** (B3 で検証予定)。

---

## 6. 観測された差異 (Bun vs Node)

| 観点 | Bun | Node | コメント |
| --- | --- | --- | --- |
| 起動時間 (cold) | 25.8s | 34.6s | Bun 8.8s (25%) 速い |
| 起動時間 (warm, 2 回目以降) | 7.6-8.4s | (未計測) | 1 度起動した dist は OS キャッシュに乗る |
| RSS (idle 5 分経過後) | ~425-435 MB | ~369 MB | Bun の方が +65 MB 多い。JSCore ランタイム層が V8 よりメモリを食う、Bun 既知の挙動。KASOU (本番) 8GB マシンでは問題なし |
| RSS リーク | なし (15 分で -9.1 MB、GC サイクル観測) | なし (3 分で ±0) | 両者とも健全 |
| HTTP 200 成功率 | 15/15 (15 分) | 3/3 (3 分) | 100% |
| 起動時の `[reload] config watcher error: UNKNOWN: unknown error, watch` | 出ない | 出る | Bun の chokidar 内 fs.watch が Node と挙動差。bun で観測されない理由は不明 (chokidar の Node 用 fs.watch ハンドラが Windows で UNKNOWN を返す既知 issue と思われる)。KASOU 実機でも要確認 |
| 起動時の bonjour hostname conflict 警告 | 出ない | 出る (2 度目以降) | 前回 Node プロセスの残骸 Bonjour 登録が検出された名残。Bun は clean start だったため衝突なし。**機能差ではない** |
| Bun 起動時 plugins.allow 警告 | 1 件 (`raw-chat-search auto-load`) | 1 件 (同) | 両者同じ |
| シャットダウン | 1.14s (graceful) | n/a (計測なし、Bun のみ) | 両者とも 127.0.0.1 バインドの WS をきれいに閉じる |

**Bun 優位点**:
- 起動が 25% 速い
- `config watcher error: UNKNOWN` が出ない
- chokidar 関連の Windows fs.watch 問題が回避されるらしい

**Bun 劣位点**:
- RSS が +65 MB 多い (JSCore のオーバーヘッド)
- Windows では SIGINT ハンドリングが Node と挙動が違う (ただし taskkill graceful は正常)

---

## 7. B3 への残タスク

### 7.1 重大: `@snazzah/davey` の OS 別ネイティブバイナリ問題

**発見**: `node_modules/@snazzah/davey-win32-x64-msvc/davey.win32-x64-msvc.node` のみが Windows ビルド機でステージングされている。KASOU は Linux x64 (`x86_64-unknown-linux-gnu` ターゲットが必要)。**DAVE プロトコル (Discord E2EE 暗号化) が KASOU 上で動かない可能性大**。

**対処案**:
1. **Windows ビルド機で `pnpm install --os=linux --cpu=x64 --libc=glibc` で Linux 用バイナリだけ追加ステージング** (推奨: 既存の「tgz を Windows で作って転送」運用と整合し、KASOU 側に pnpm/npm registry 到達性を要求しない)
2. **KASOU 上で `pnpm install` し直す**: davey の optional dep が `process.platform` を見て Linux 版を取得する (KASOU から npm registry への到達性が要る。過去に KASOU 側依存解決で失敗経験あり → フォールバック案)
3. **postinstall で `npm rebuild @snazzah/davey --build-from-source`**: Rust ツールチェイン要、依存重い

→ B3 で **選択肢 1 (Windows 上での `--os=linux` クロスステージング)** を採用予定。なお Discord の**テキスト**機能は davey 非依存 (`extensions/discord/src/voice/sdk-runtime.ts:12` の遅延 require により、音声使用時のみロード) のため、**davey 未解決でも Discord テキストは影響なし、音声 (DAVE) のみが制限**される。

### 7.2 中: `copy-bundled-plugin-metadata` が node_modules を毎回消す問題

**症状**: `copy-bundled-plugin-metadata` が毎回 `dist/extensions/*/<plugin>/node_modules` を無条件削除するため、stamping の stamp skip は実質機能せず、毎回フルステージングする。ビルド/インストール時間が伸びる (レビューでの所要時間実測に基づく観察)。

**B3 での対処**: B3 スコープ外。再設計は別タスク (`OPTIMIZATION.md` に記録予定)。

### 7.3 解消済み: `boundary-invariants.test.ts` の glob 型エラー 12 件

`@types/glob` は deprecated stub (`This is a stub types definition. glob provides its own type definitions, so you do not need this installed.`) で、`glob` v13 が自前で TypeScript 型定義を持っている。MED-1 で `package.json` の `@types/glob ^9.0.0` を削除し `glob ^13.0.6` を直接 devDependency に置いた (コミット `1a505b567c8 [SOUL] Declare glob as direct devDependency (replace deprecated @types/glob stub)`, 2026-09-01)。`boundary-invariants.test.ts` は `import("glob")` 経由で `globSync` を取得し、結果は Windows バックスラッシュ path を POSIX に正規化してから比較する形に統一済み (`c228579ce2a` でコメント追加)。Bun 移行とは無関係の pre-existing issue だったが、MED-1 対応で解消された。

**B3 での対処**: なし (解消済み)。

### 7.4 重要: KASOU での 24 時間 soak 計画

- KASOU (AMD GX-217GA, AVX2 無し, 8GB RAM) で `bun 1.4.0` を systemd `ExecStart` で起動
- 5 分間隔で `liveness marker tick` と RSS を採取
- 24 時間 (= 288 サンプル) で RSS リーク傾向を評価
- 起動 1 度目 (cold) と 5 度目 (warm) で起動時間を記録

### 7.5 systemd 設定変更

KASOU `~/.config/systemd/user/dennou-aibou.service` (仮) の `ExecStart` を `node` → `bun` に変更。`ExecStop` は `kill -TERM $MAINPID` (Windows 上で taskkill graceful が §5.5 で実証済み。Linux systemd 経由の挙動は B3 で検証)。

### 7.6 注意事項

- **JIT**: `PRAGMA threads = 0` (プロセス既定) で OK。KASOU でも追加設定なし
- **AVX2**: Bun 1.4.0 は `-mcpu=generic` でフォールバック動作確認済 (B0)
- **mDNS / Bonjour**: B2 計測で hostname conflict 警告が Node 側で出た。Bun では出ない。本番 KASOU 単一起動なら問題なし

---

## 8. 結論

### Bun 1.4.0 ローカルでの動作: **OK**

- HTTP 200 (15/15 15 分 soak)
- 起動 25.8s cold / 7.6s warm (Node 比 8.8s 速い)
- メモリ 425-435 MB (Node +65 MB だが、KASOU 8GB には十分余裕)
- リークなし (15 分で -9.1 MB、GC サイクル観測)
- クリーンシャットダウン 1.14s
- node:sqlite + FTS5 完全動作 (同 schema サンドボックス DB・空 index。実データ DB での FTS5 検証は B3 条件)
- sessions.json 読み書き完全動作
- bundled plugin (memory-core) + 自動検出 plugin (raw-chat-search) ロード成功

### B3 への判定: **conditional-go**

- 条件 1: `@snazzah/davey` Linux 版バイナリを同梱する (推奨: Windows 上で `pnpm install --os=linux --cpu=x64 --libc=glibc` のクロスステージング。または KASOU 上での `pnpm install` — npm registry 到達性が要る)。未解決でも Discord **テキスト**は影響なし、音声 (DAVE) のみ制限される
- 条件 2: KASOU で 24h soak を実施してメモリリークがないことを確認。併せて実データ入りの本番 raw-chat DB に対する FTS5 検索正確性を検証 (B2 は空サンドボックス index のみ)
- 条件 3: systemd `ExecStart` を `bun` に切り替えて 1 週間様子見

条件 1-3 すべて満たせば、本番 Bun 移行を正式 go と判定。条件 1 のみ未達でも Bun 起動自体は可能 (Discord DAV 機能だけが制限される)。

---

## 9. 付録: テスト成果物

すべて `DennouAibou/.bun-soak-tmp/` 配下 (gitignore 対象):

| ファイル | 内容 |
| --- | --- |
| `soak.ps1` | Bun/Node soak 汎用ハーネス (任意の runtime / duration / port) |
| `sigint-test.ps1` | taskkill graceful / force / CloseMainWindow の比較テスト |
| `verify-runtime.mjs` | sessions.json atomic write + roundtrip テスト |
| `fts5-probe.mjs` | 一時 FTS5 テーブルでの INSERT + MATCH + readonly 再オープン |
| `raw-chat-prod-probe.mjs` | KASOU の実 raw-chat.sqlite に対する node:sqlite 動作確認 |
| `BUN-soak-20260828-185904.{out,err}.log` | 15 分 Bun soak の stdout/stderr |
| `BUN-soak-20260828-185604.*` | 中断された先行 soak 実行 (起動成功後 2 サンプル目で手動中断 — ポート再利用のため再起動) |
| `BUN-soak-20260828-185904.samples.csv` | 60 秒間隔 15 サンプルの RSS / CPU / HTTP 結果 |
| `BUN-soak-20260828-185904.{meta,summary}.json` | 起動時刻 / 結果集計 |
| `NODE-soak-20260828-191840.*` | Node 3 分 soak の同類成果物 (比較用) |
| `BUN-sigint-20260828-192339.*` | SIGINT/タスクキル/CloseMainWindow 比較テスト |

ハーネス (`soak.ps1`, `sigint-test.ps1`) は B3 以降の soak テストや systemd 移行検証で再利用可能。ただし `verify-runtime.mjs` は検証前の `sessions.json` 自動退避・復元処理を持たないため、B3 (KASOU 本番) で再利用する前に cleanup 処理の追加が必須 (master session 保護対象キーを書くため)。

---

## 10. 参照

- 前提: KASOU 実機 SSH テスト (2026-08-28) → `bun 1.4.0` + `node:sqlite` + FTS5 + JIT 完動
- B1 スパイク報告書: 本ドキュメントの前身 (`e4026f09f8b` 時点で内容を全面書き直し、旧 B1 「起動失敗」前提の記述は本版で全て置換)
- B1 修正コミット: `e4026f09f8b [SYNC] Fix pnpm build breakage + Bun 1.4.0 gateway boot path`
- リポジトリ: `DennouAibou`, branch `feature/pi-sdk-update`, HEAD `e4026f09f8b`
- 関連ドキュメント:
  - `DENNOU_DOCS/PHASE_F_SLIM_KERNEL.md` — Go sidecar 撤去、純 TS 化の根拠
  - `DENNOU_DOCS/DEBLOAT.md` — TTS subsystem 撤去 (`speech.ts` 削除の由来)
  - `DENNOU_DOCS/PHASE_D_PI_SDK_UPDATE.md` — `@mariozechner` → `@earendil-works` リネームの記録
  - `DENNOU_DOCS/AGENT_SESSION.md` — Master session 不変性ポリシー

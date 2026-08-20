# CLI が返らない問題の修正記録

## 何が起きたか

`openclaw plugins install ...` が最後に `Restart the gateway to load plugins.` まで表示したあと、ターミナルへ戻らないことがあった。

処理自体は終わっていたが、DennouAibou の常駐用 hook が通常の短命 CLI でも起動していたため、Node.js プロセスが「まだ仕事中」と判断して残っていた。

## 原因

`src/cli/run-main.ts` の CLI 共通入口で、以下の DennouAibou runtime hooks を常に起動していた。

- `initSessionMaintenanceHook()`
- `startIdlePruneWatcher()`
- `startLivenessWatchdog()`

特に `startLivenessWatchdog()` は内部で `setInterval()` を持つ。これは Gateway のような常駐プロセスには必要だが、`plugins install` や `gateway status` のような短命コマンドでは、帰るはずのターミナルを掴み続ける。

## 修正方針

短命 CLI では DennouAibou runtime hooks を起動しない。

hooks は `openclaw gateway` / `openclaw gateway run` で Gateway server が実際に起動できたあとだけ開始する。

## 実装

### 1. CLI 共通入口から hook 起動を削除

`src/cli/run-main.ts` から、DennouAibou runtime hooks の起動処理を削除した。

これにより、以下のような通常 CLI は hooks を起動しない。

- `openclaw plugins install ...`
- `openclaw plugins --help`
- `openclaw gateway stop`
- `openclaw gateway status`
- `openclaw status`

### 2. Gateway 起動後だけ hook を開始

`src/cli/gateway-cli/run.ts` に `startDennouRuntimeHooksOnce()` を追加した。

この関数は `startGatewayServer(...)` が成功したあとだけ呼ばれる。

つまり、Gateway が実際に立ち上がった条件の上でだけ、以下が動く。

- closed-session prune hook
- active-session idle prune watcher
- liveness watchdog

### 3. 二重起動を防止

`dennouRuntimeHooksStarted` で一度だけ起動する。

Gateway の in-process restart があっても、listener や interval を重ねて増やさない。

## 検証

ローカルで以下を確認した。

```bash
pnpm vitest run src/cli/run-main.test.ts
pnpm build
```

結果：成功。

短命 CLI が戻ることも確認した。

```bash
node openclaw.mjs plugins --help
node openclaw.mjs gateway status --help
```

`plugins --help` は起動自体に約20秒かかるが、永久に掴み続ける状態ではなくなった。これは別問題として扱う。

## code-reviewer 結果

code-reviewer は修正方針を承認した。

確認されたポイント：

- `run-main.ts` から短命 CLI 向けの常駐 hook 起動が消えている
- `run.ts` では `startGatewayServer()` 成功後にだけ hooks が起動する
- `dennouRuntimeHooksStarted` により in-process restart でも二重登録しない
- `protection!` は不要だったため、`{ ...protection, resolvedWorkspacePaths: wsPaths }` に修正済み

## 期待する挙動

| コマンド                       | runtime hooks            |
| ------------------------------ | ------------------------ |
| `openclaw plugins install ...` | 起動しない               |
| `openclaw plugins --help`      | 起動しない               |
| `openclaw gateway stop`        | 起動しない               |
| `openclaw gateway status`      | 起動しない               |
| `openclaw gateway`             | Gateway 起動成功後に起動 |
| `openclaw gateway run`         | Gateway 起動成功後に起動 |

## ユーザー向けの一言

今までは「用事が終わった配達員に、店番も任せていた」状態だった。今回の修正で、店番は Gateway 本体が開店したときだけ始めるようにした。

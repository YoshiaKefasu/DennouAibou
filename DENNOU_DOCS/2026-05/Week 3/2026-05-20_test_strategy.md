# DennouAibou テスト戦略

## 課題

- テスト総数: 3243 tests（1555 active、残りは設定由来の重複）
- 実行時間: 850秒（14分）
- FAIL: 149件（すべて既存・環境由来、DennouAibou の変更が原因のものはほぼなし）
- CPU: 50%常時消費

個人フォークで毎回14分待つのは現実的でない。かといってテストを捨てるのも良くない。

## 方針: 3層構成 + Bun

### 層の定義

| 層 | 対象 | ランナー | 時間 | 状況 | 使い方 |
|---|---|---|---|---|---|
| **fast** | `src/dennou-soul/**`（prune/watchdog/guard）+ 自分が触った領域のテスト | **Bun** | 〜15秒 | ✅ 実証済み（40/42 pass） | 日常の edit → test サイクル |
| **core** | vi.doMock / vi.resetModules を使わないテスト（2337ファイル） | **Bun** | 〜2分（推定） | ⚪ Bun互換性確認中 | push前の安全確認 |
| **full** | 全3243 tests（87ファイルはvitest専用API使用） | vitest | 14分 | ❌ 149既存FAILあり | ship前の最終確認、週一メンテ |

### なぜ全部Bunにしないのか

2424テストファイル中87ファイルが `vi.doMock` / `vi.resetModules` を使っており、Bun のテストランナーはこれらに対応していない。1ファイルずつ `mock.module()` に移植する必要があり、数日単位の作業になる。速度面のリターンに対してコストが大きいため、部分置換を選択する。

参考: session-tool-result-guard.test.ts は Bun で 29 tests / 12.6秒 / 全パス。vitest では数分かかっていた。

### 実行コマンド（予定）

```json
{
  "scripts": {
    "test:fast": "bun test src/dennou-soul/",
    "test": "vitest run" // 現状維持
  }
}
```

### 149既存FAILの扱い

全量を毎回確認する必要はない。fast層がパスしていれば、DennouAibou固有機能は正常。full層のFAILは以下のカテゴリに分類：

| カテゴリ | 件数（概算） | 対応 |
|---|---|---|
| ReplyRunAlreadyActiveError（テスト分離問題） | 50+ | 既知。`test.skip` で黙らせる候補 |
| session.test.ts（session.reset.mode=off の影響） | 5 | DennouAibou の変更が原因。本数が少ないので直す |
| Windowsパスセパレーター差分 | 10 | ローカル環境のみ。CIでは出ない |
| チャネル固有の設定テスト | 30+ | upstream由来。DennouAibouでは使わないチャネル |

### ステータス

- 2026-05-20: 初版作成。fast層はBunで実証済み。core層は未検証。

---

## 付録: debloat残骸テスト設定ファイル削除

### 発端

2026-04-26 の Hard Debloat で extensions 20個を削除したが、vitest の設定ファイルとパス設定が残っていた。これらが vitest のテストファイル走査範囲に含まれているため、起動時に存在しないディレクトリをスキャンしようとして時間をロスしている。

### 削除したファイル（2026-05-20）

#### 設定ファイル 12個

```
vitest.extension-bluebubbles-paths.mjs
vitest.extension-bluebubbles.config.ts
vitest.extension-feishu-paths.mjs
vitest.extension-feishu.config.ts
vitest.extension-irc-paths.mjs
vitest.extension-irc.config.ts
vitest.extension-matrix-paths.mjs
vitest.extension-matrix.config.ts
vitest.extension-whatsapp-paths.mjs
vitest.extension-whatsapp.config.ts
vitest.extension-zalo-paths.mjs
vitest.extension-zalo.config.ts
```

#### 参照元修正

`vitest.shared.config.ts` から上記12ファイルへの import / include 行を削除（6ブロック）。

#### 効果

- vitest 起動時の無駄なスキャンが減る
- テストファイル数が 3417 → 3405 に減少（12ファイル削減）
- full 層の実行時間がわずかに短縮

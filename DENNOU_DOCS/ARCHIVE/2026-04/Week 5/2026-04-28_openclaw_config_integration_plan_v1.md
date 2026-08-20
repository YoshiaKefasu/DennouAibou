# 2026-04-28 DennouConfig → openclaw.json 完全統合計画 v2

> **方針**: `dennou-config.json` を完全廃止。設定は `openclaw.json` の `dennou` 名前空間に一本化し、WebUIから直接オン・オフできるようにする。フォールバックや移行期間は設けない（DennouAibou独自実装のため後方互換不要）。

---

## 0. 解決する問題

| 問題 | 解決策 |
|---|---|
| `dennou-config.json` はユーザーが手動作成必須 | **廃止**。`openclaw.json` の `dennou` セクションに統合 |
| WebUIから操作不可 | `openclaw.json` は WebUI で編集可能。さらに専用セクションをUIに追加 |
| DENNOU_RULES Rule 1 との兼ね合い | `OpenClawConfig` 型は変更しない。DennouAibou側のtype assertionで読む |

---

## 1. 設計方針

### `openclaw.json` の `dennou` 名前空間に統合

```json
// ~/.openclaw/openclaw.json
{
  "dennou": {
    "activeSessionToolsPrune": {
      "enabled": true,
      "idleDelayMinutes": 30
    },
    "pruneProtection": {
      "protectedContentKeywords": ["AGENTS.md", "SOUL.md", "DENNOU_RULES"]
    }
  }
}
```

**上流への影響はゼロ**: OpenClawは `openclaw.json` 内の未知キーを無視する（[index signature](https://www.typescriptlang.org/docs/handbook/2/objects.html#index-signatures)ではなくoptional型のため、`dennou` キーを上流が知らなくていい）。DennouAibouが `getRuntimeConfig()` で読んだ結果から `(cfg as any).dennou` を取る形にすれば上流型は無傷。

### メリット

| 観点 | 内容 |
|---|---|
| **ユーザー体験** | WebUIの設定画面でJSON編集 → 保存だけ。ファイル作成不要 |
| **既存インフラ再利用** | `config-reload.ts` の hot-reload が自動で機能。設定変更が即時反映 |
| **Encapsulation維持** | `OpenClawConfig` 型は変更しない。`dennou-soul/` 内で型アサーションして読む |
| **後方互換** | `dennou-config.json` が残っていてもフォールバックとして機能させられる（移行期間） |

---

## 2. 証拠: 上流の型は未知キーに安全

`src/config/types.openclaw.ts` L32-125 の `OpenClawConfig` は全フィールドが `optional`。TypeScriptのindex signatureではないが、**JSONパース時に未知キーは単に無視されず保持される**。`getRuntimeConfig()` が返すオブジェクトの中に `dennou` キーが存在するため、DennouAibou側から読める。

---

## 3. 実装変更

### Phase 1: `config.ts` 完全書き換え（`src/dennou-soul/config.ts`）

`dennou-config.json` 読み込み一切を削除し、`getRuntimeConfig()` から読む形に書き換える。

```typescript
// src/dennou-soul/config.ts （完全書き換え後）
import { getRuntimeConfig } from "../config/config.js";
import type { DennouConfig } from "./types.js";
import { DENNOU_CONFIG_DEFAULTS } from "./types.js";

function isDennouConfigObject(raw: unknown): raw is Partial<DennouConfig> {
  return typeof raw === "object" && raw !== null;
}

/**
 * openclaw.json の `dennou` セクションを読んでDennouConfigを返す。
 * セクションが存在しない場合はデフォルト値を返す（クラッシュしない）。
 */
export function getDennouConfig(): DennouConfig {
  try {
    const cfg = getRuntimeConfig();
    const dennouRaw = (cfg as Record<string, unknown>)["dennou"];
    if (!isDennouConfigObject(dennouRaw)) {
      return DENNOU_CONFIG_DEFAULTS;
    }
    return {
      sessionToolsPrune: {
        ...DENNOU_CONFIG_DEFAULTS.sessionToolsPrune,
        ...(dennouRaw.sessionToolsPrune ?? {}),
      },
      activeSessionToolsPrune: {
        ...DENNOU_CONFIG_DEFAULTS.activeSessionToolsPrune,
        ...(dennouRaw.activeSessionToolsPrune ?? {}),
      },
      pruneProtection: {
        ...DENNOU_CONFIG_DEFAULTS.pruneProtection,
        ...(dennouRaw.pruneProtection ?? {}),
        // resolvedWorkspacePaths はランタイム自動解決のため設定値を無視
        resolvedWorkspacePaths: DENNOU_CONFIG_DEFAULTS.pruneProtection.resolvedWorkspacePaths,
      },
    };
  } catch {
    return DENNOU_CONFIG_DEFAULTS;
  }
}
```

**削除する関数・変数**（`config.ts` から完全除去）:
- `getConfigPath()` — ファイルパス解決不要になる
- `loadDennouConfig()` — `getDennouConfig()` に統合
- `cachedConfig` / `clearDennouConfigCache()` — キャッシュ不要（`getRuntimeConfig()` が管理）

### Phase 3: config-reloadとの統合（自動 hot-reload）

`src/gateway/config-reload.ts` が `openclaw.json` の変更を検知するたびに `getRuntimeConfig()` が更新される。DennouAibouの各コンポーネントが `getDennouConfig()` を都度呼ぶ設計（キャッシュなし）であれば、**WebUIで設定を保存した瞬間に反映**される。

対象コンポーネント：
- `idle-prune-watcher.ts` — idleDelayMinutes の変更 → タイマー再起動
- `prune-engine.ts` — minPrunableToolChars, keepLastTools の変更 → 次回prune時に反映
- `prune-closed-sessions.ts` — enabled の変更 → 次回 afterSaveHook 呼び出し時に反映

---

## 4. Phase 4: WebUI設定セクション統合

### 概要

`openclaw.json` の `dennou` キーが存在していても、WebUIの設定フォームは現状スキーマに存在しないキーを「Other」カテゴリに雑に表示するだけ。専用セクションとして綺麗に組み込むには、UIにも変更が必要。

### 変更対象ファイル（上流ファイルへのパッチ）

```
ui/src/ui/views/config.ts   ← SECTION_CATEGORIES に dennou を追加
ui/src/ui/navigation.ts     ← 変更不要（設定ページ内のサブセクションのため）
```

> **重要**: `config.ts` は上流OpenClawのファイル。直接編集すると upstream merge 時にコンフリクトする。
> **対策**: `patches/` ディレクトリで差分を管理する（既存の `patches/` の仕組みを流用）。

### `config.ts` への追記内容

**① `SECTION_CATEGORIES` にDennouAibouカテゴリを追加**

```typescript
// ui/src/ui/views/config.ts の SECTION_CATEGORIES 末尾に追加
{
  id: "dennouAibou",
  label: "DennouAibou",
  sections: [
    { key: "dennou", label: "DennouAibou" },
  ],
},
```

**② `sidebarIcons` にアイコンを追加**

```typescript
// sidebarIcons オブジェクトに追加（scissorsアイコン: prune操作を象徴）
dennou: html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="6" cy="6" r="3"></circle>
    <circle cx="6" cy="18" r="3"></circle>
    <line x1="20" y1="4" x2="8.12" y2="15.88"></line>
    <line x1="14.47" y1="14.48" x2="20" y2="20"></line>
    <line x1="8.12" y1="8.12" x2="12" y2="12"></line>
  </svg>
`,
```

### 結果: ユーザーの操作フロー（完成後）

```
1. ブラウザで http://localhost:18789 を開く（Control UI）
2. 左サイドバー → 設定 → DennouAibou をクリック
3. フォームUIで各設定が表示される:

   [DennouAibou]
   ┌─────────────────────────────────────┐
   │ Active Session Tools Prune          │
   │   enabled          [ ON / OFF ]     │
   │   idleDelayMinutes [ 30       ]     │
   │   dryRun           [ ON / OFF ]     │
   ├─────────────────────────────────────┤
   │ Prune Protection                    │
   │   protectedContentKeywords [+ 追加] │
   └─────────────────────────────────────┘

4. 「Save & Apply」ボタンをクリック
5. DennouAibouが即時反映（config-reload hot-reload）
```

### upstream merge 時のコンフリクト回避戦略

パッチは `patches/dennou-webui-config-section.patch` として管理：

```bash
# パッチ生成（実装後に1回だけ実行）
git diff HEAD ui/src/ui/views/config.ts > patches/dennou-webui-config-section.patch

# upstream merge 後の再適用
git apply patches/dennou-webui-config-section.patch
```

コンフリクトした場合は手動で `SECTION_CATEGORIES` に `dennouAibou` エントリを追記し直すだけ（影響範囲が小さいため）。

---

## 5. ユーザーの操作フロー（Phase 4完了後の最終形）

上記 Phase 4 の「結果: ユーザーの操作フロー」を参照。

---

## 5. 型安全性の確保

`types.openclaw.ts` を**変更しない**ことで上流は汚染しない。代わりに DennouAibou 専用の型ガードを追加：

```typescript
// src/dennou-soul/config.ts に追加
function isDennouConfigObject(raw: unknown): raw is Partial<DennouConfig> {
  return typeof raw === "object" && raw !== null;
}
```

これにより `as any` を使わずに安全に読める。

---

## 6. 削除するもの（実装時に即座に除去）

| 対象 | アクション |
|---|---|
| `src/dennou-soul/config.ts` 全体 | Phase 1 で完全書き換え |
| `getConfigPath()` 関数 | 削除 |
| `loadDennouConfig()` 関数 | 削除（`getDennouConfig()` に置き換え） |
| `cachedConfig` / `clearDennouConfigCache()` | 削除 |
| `~/.openclaw/dennou-config.json`（ファイル） | コードから参照がなくなるため自然消滅。既存ファイルはユーザーが手動削除可 |

---

## 7. 実装フェーズ一覧

| Phase | 内容 | 変更ファイル | 見積 |
|---|---|---|---|
| **1** | `config.ts` 完全書き換え | `src/dennou-soul/config.ts` | 1-2h |
| **2** | hot-reload 対応 | `idle-prune-watcher.ts` | 1h |
| **3** | WebUI セクション追加 | `ui/src/ui/views/config.ts`（patch管理） | 1h |
| **4** | ドキュメント更新 | DENNOU_DOCS 各プラン | 0.5h |

### Phase 1: バックエンド — `config.ts` 完全書き換え
- `getRuntimeConfig()` から `dennou` セクションを読む形に書き換え
- `getConfigPath()` / `loadDennouConfig()` / `cachedConfig` / `clearDennouConfigCache()` を全削除
- 型ガード `isDennouConfigObject()` を追加
- `dennou-config.json` への参照をコードベースから完全除去

### Phase 2: バックエンド — hot-reload 対応
- `idle-prune-watcher.ts` でタイマーを config 変更時に再起動するロジック追加
- `prune-engine.ts` は都度 `getDennouConfig()` を呼ぶ形なら変更不要

### Phase 3: フロントエンド — WebUI セクション追加
- `ui/src/ui/views/config.ts` の `SECTION_CATEGORIES` に `dennouAibou` カテゴリ追加
- `sidebarIcons` に `dennou` アイコン（scissorsSVG）追加
- 変更を `patches/dennou-webui-config-section.patch` として保存

### Phase 4: ドキュメント更新
- DENNOU_DOCS の各プランに openclaw.json 統合の注記追加
- `DENNOU_RULES.md` にユーザー向け設定方法を追記

---

## 8. リスク

| リスク | 対策 |
|---|---|
| `getRuntimeConfig()` が未初期化状態で呼ばれる | `getDennouConfig()` を try/catch で包み、エラー時は DEFAULTS を返す |
| 上流が将来 `dennou` キーを使い始める | `dennouAibou` に改名する。現状リスクは低い |
| WebUIで誤った値を設定してpruneが暴走 | `dryRun: true` がデフォルトのため、誤設定でもファイルは変更されない |
| `config.ts`（上流）へのパッチが upstream merge でコンフリクト | `patches/` で管理し、merge後に `git apply` で再適用。影響箇所は `SECTION_CATEGORIES` 1エントリのみ |
| 既存の `dennou-config.json` が残留している | コードから参照がなくなるため無害。ユーザーには手動削除を促す（強制不要） |

---

## 9. 参考

- `src/config/types.openclaw.ts` L32 — `OpenClawConfig` 型（変更しない）
- `src/dennou-soul/config.ts` — Phase 1 書き換え対象
- `src/dennou-soul/types.ts` — `DennouConfig` 型（変更しない）
- `src/gateway/config-reload.ts` — hot-reload機構（利用する）
- `ui/src/ui/views/config.ts` L358 — `SECTION_CATEGORIES`（Phase 3 patch対象）
- `ui/src/ui/navigation.ts` — Tab定義（変更不要: サブセクションのため）
- Control UI: `http://localhost:18789`
- パッチ保存先: `patches/dennou-webui-config-section.patch`

---

## 10. 実装状態（2026-04-28）

### 全フェーズ完了

| Phase | 変更内容 | 状態 | 備考 |
|---|---|---|---|
| **Phase 1** | `src/dennou-soul/config.ts` 完全書き換え | ✅ | `dennou-config.json` 読み込み廃止。`getRuntimeConfig()` から `dennou` セクションを読む |
| Phase 1 | `getConfigPath()` / `loadDennouConfig()` / `cachedConfig` / `clearDennouConfigCache()` 削除 | ✅ | 不要コードを完全除去 |
| Phase 1 | `types.ts` コメント更新 | ✅ | `dennou-config.json → openclaw.json dennou セクション` |
| Phase 1追加 | `toolsPrune` 共通設定追加 | ✅ | `minPrunableToolChars` / `keepLastTools` / `placeholder` / `dryRun` の重複を整理。各モード側で必要なキーだけ上書き可能 |
| Phase 1追加 | `src/config/zod-schema.ts` に `dennou` schema登録 | ✅ | `openclaw.json` の strict schema とWebUI表示に必要。ユーザーが全キーを設定可能 |
| **Phase 2** | `idle-prune-watcher.ts` hot-reload対応 | ✅ | `handleIdleEvent` 内で都度 `getDennouConfig()` を呼ぶ。`startIdlePruneWatcher` の `config` 引数削除 |
| Phase 2 | `run-main.ts` 呼び出し簡略化 | ✅ | `startIdlePruneWatcher(protection)` — configは内部で読む |
| **Phase 3** | `ui/src/ui/views/config.ts` にDennouAibouカテゴリ追加 | ✅ | `sidebarIcons.dennou` (scissorsアイコン) + `SECTION_CATEGORIES` に `dennouAibou` セクション |
| Phase 3 | パッチ管理 | ✅ | `patches/dennou-webui-config-section.patch` 保存 |
| **Phase 4** | 本プラン更新 | ✅ | このセクション |

### 設計との整合性

- **`OpenClawConfig` 型未変更**: `(cfg as Record<string, unknown>)["dennou"]` で型アサーション。上流型は無傷
- **キャッシュ廃止**: 都度 `getRuntimeConfig()` を呼ぶため、config-reload hot-reloadが自動反映
- **重複整理**: 共通Prune設定は `dennou.toolsPrune` に集約。`sessionToolsPrune` / `activeSessionToolsPrune` は `enabled` などモード固有値と必要な上書きだけを持てる
- **WebUI/schema表示**: `src/config/zod-schema.ts` に `dennou` を登録したため、Control UIのDennouAibouセクションに設定キーが表示される
- **`dennou-config.json` からの移行**: ファイルが残っていてもコードから参照しないため無害
- **元プランからの逸脱**: `startIdlePruneWatcher` の `config` 引数を削除（hot-reload対応のため必要）

### 削除したコード

| 対象 | 行数 |
|---|---|
| `src/dennou-soul/config.ts` 旧実装（ファイルI/O + キャッシュ） | 80行 |
| `ui/src/ui/views/config.ts` パッチ（追記のみ、既存コード削除なし） | +13行 |

### dennou-config.json からの移行方法（ユーザー向け）

設定を引き継ぐ場合、`~/.openclaw/openclaw.json` に以下を追加する：

```json
{
  "dennou": {
    "toolsPrune": {
      "minPrunableToolChars": 1200,
      "keepLastTools": 5,
      "placeholder": "[tool output pruned by DennouAibou]",
      "dryRun": true
    },
    "sessionToolsPrune": {
      "enabled": false
    },
    "activeSessionToolsPrune": {
      "enabled": true,
      "idleDelayMinutes": 30,
      "keepLastTools": 10,
      "placeholder": "[tool output pruned by DennouAibou — idle prune]"
    },
    "pruneProtection": {
      "protectedContentKeywords": ["AGENTS.md", "SOUL.md", "DENNOU_RULES"]
    }
  }
}
```

デフォルト値だけ使うなら `dennou` セクションの追加は不要。`~/.openclaw/dennou-config.json` は手動で削除可能。

### 追加レビュー修正（2026-04-28）

#### Fix 1: Closed/Active Prune設定の重複整理

**発見**: `sessionToolsPrune` と `activeSessionToolsPrune` が `minPrunableToolChars` / `keepLastTools` / `placeholder` / `dryRun` を重複して持っていた。

**修正**: `toolsPrune` を追加し、共通値をそこへ集約。モード別設定は `enabled`、`idleDelayMinutes`、必要な上書きだけを持てる形にした。

#### Fix 2: `openclaw.json` strict schemaに `dennou` が未登録

**発見**: `OpenClawSchema` が `.strict()` のため、`dennou` キーを追加してもconfig validation / WebUI schemaに出ない可能性があった。

**修正**: `src/config/zod-schema.ts` に `DennouSchema` を追加。`toolsPrune`、`sessionToolsPrune`、`activeSessionToolsPrune`、`pruneProtection.protectedContentKeywords` をすべて設定可能にした。

#### 追加テスト

- `src/config/zod-schema.dennou.test.ts` 追加
- `src/dennou-soul/config.test.ts` 追加
- `OpenClawSchema` がDennouAibou設定を受け入れることを確認
- unknown keyを拒否することを確認
- `toolsPrune` の共通値がClosed/Activeの両方に反映されることを確認
- モード別設定が共通値を上書きできることを確認

#### Fix 3: build時に削除済みプラグインのSDK facade型解決が失敗

**発見**: `pnpm build` で `@openclaw/bluebubbles/api.js`、`@openclaw/feishu/api.js`、`@openclaw/matrix/api.js` など削除済みプラグインの型解決に失敗した。

**修正**: `src/types/dennou-removed-plugin-facades.d.ts` を追加。runtime facade自体は残しつつ、d.ts生成だけが削除済みworkspace packageに依存しないよう型shimを置いた。

**理由**: ファイル削除や公開export削除は破壊的変更になりやすい。DennouAibouのhard-fork軽量化では、runtimeで使わない削除済みpluginのfacadeは残してもよいが、buildは通す必要がある。

#### Fix 4: Active Prune設定の共通デフォルト抜け

**発見**: code-reviewer確認で、`activeSessionToolsPrune` のマージ順により、`dennou.toolsPrune` 未指定時に `minPrunableToolChars` / `dryRun` の共通デフォルトが抜ける可能性を確認した。

**修正**: active側のマージで `DENNOU_CONFIG_DEFAULTS.toolsPrune` を最初に適用し、その後 `activeSessionToolsPrune` のモード別デフォルト、`toolsPrune` 上書き、active個別上書きの順にした。

**追加テスト**: `src/dennou-soul/config.test.ts` で、`dennou` 未設定時にも `activeSessionToolsPrune.minPrunableToolChars === 1200` と `dryRun === true` になることを確認。

#### 追加検証

- `pnpm test src/dennou-soul/config.test.ts src/config/zod-schema.dennou.test.ts src/dennou-soul/prune-engine.test.ts src/dennou-soul/prune-closed-sessions.test.ts src/dennou-soul/prune-active-session.test.ts --reporter=verbose`: **45 passed**
- `pnpm config:docs:check`: drift検出 → `pnpm config:docs:gen` 実行 → 再check **OK**
- `pnpm build`: **OK**

# AGENT_SESSION — エージェントセッション永続化・保護設計

> 最終更新: 2026-08-17
> 対象: DennouAibou（OpenClaw Hard Fork, base v2026.4.5）

## 1. 目的と方針

KASOU（本番デプロイ環境）では、エージェントのメインセッション（`agent:main:main`、Telegram では `telegram:g-agent-main-main` として利用）を「**Kasou の一生の命**」として扱う。

つまり:

- メインセッションは **削除できない**
- メインセッションは **リセットできない**（`/reset` `/new` を含む）
- メインセッションは **自動クリーンアップの対象外**（ディスク予算・クリーンアップ・prune）
- このセッションが継続する限り、エージェントの記憶・コンテキスト・関係性が途切れない

保護は **設定ベースの保護キーリスト（案A）** で実現する。特定セッションだけを「命」として固定し、将来別セッションも保護したくなった場合は設定追加のみで対応できる。

---

## 2. 現状のセッションライフサイクル（2026-08-17 調査）

### 2.1 セッションキー構造

| キー形式                                    | 意味                                                    |
| ------------------------------------------- | ------------------------------------------------------- |
| `agent:main:main`                           | メインセッション（`resolveMainSessionKey(cfg)` が返す） |
| `agent:main:telegram:direct:<user-id>`      | Telegram DM                                             |
| `agent:main:telegram:group:<group-id>`      | Telegram グループ                                       |
| `agent:main:telegram:group:<id>:topic:<id>` | Telegram グループトピック                               |
| `agent:main:telegram:slash:<user-id>`       | Telegram スラッシュコマンド（旧形式）                   |

### 2.2 セッションを変える操作

| 操作               | 経路                                                                              | 現状の保護                                                                               |
| ------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 手動リセット       | `performGatewaySessionReset`（RPC + agent.ts）+ auto-reply の本文パースローテート | **保護なし** — main もリセット可能                                                       |
| 手動削除           | `sessions.delete` RPC                                                             | main は拒否済み（`Cannot delete the main session`）                                      |
| 自動リセット       | `session.reset` ポリシー（daily / idle）                                          | `mode="off"` で無効化済み（KASOU）                                                       |
| ディスク予算削除   | `src/config/sessions/disk-budget.ts`                                              | 保護なし — 対象になり得る                                                                |
| クリーンアップ削除 | `src/commands/sessions-cleanup.ts`                                                | 保護なし — 対象になり得る                                                                |
| ストア自動メンテ   | `src/config/sessions/store.ts` の毎セーブ時 prune/cap/budget                      | 保護なし — main が巻き添えで消え得る                                                     |
| 閉セッション prune | `src/dennou-soul/prune-closed-sessions`                                           | **対象外** — ライブ `*.jsonl` には触らない（`.jsonl.deleted.*` / `.jsonl.reset.*` のみ） |

### 2.3 現状の穴

- **リセットが穴**: 削除は main が拒否済みだが、リセットは可能。`/reset` `/new` でメインセッションの履歴が消える
- **自動クリーンアップが穴**: ディスク予算・クリーンアップ・prune は main を特別扱いしない

---

## 3. 設計: 保護キーリスト（案A）

### 3.1 設定スキーマ

```json
{
  "session": {
    "protectedKeys": [
      "agent:main:main",
      "agent:main:telegram:g-agent-main-main" // ※ 未検証プレースホルダ。実在キーを sessions.json で確認する
    ]
  }
}
```

- `session.protectedKeys: string[]`（デフォルト: `["agent:main:main"]`）
- 省略時はデフォルトで main セッションだけ保護
- 明示指定時は、指定キー + main セッションが保護対象

### 3.2 保護の判定

```ts
// normalizeSessionKey は既存の正規化ヘルパーを再利用する:
//   - canonicalizeMainSessionAlias（src/config/sessions/main-session.ts:47-84）:
//     "main" / "agent:main:main" / レガシー "agent:main:<mainKey>" を同一視
//   - resolveMainSessionKey（main-session.ts:18-20）: scope:"global" の時は "global" を返す
//     点に注意（デフォルトの ["agent:main:main"] はこの場合をカバーしない）
function isProtectedSessionKey(key: string, cfg?: OpenClawConfig): boolean {
  const normalized = normalizeSessionKey(key); // canonicalizeMainSessionAlias ベース
  if (normalized === resolveMainSessionKey(cfg)) {
    return true; // main は常に保護
  }
  return (cfg?.session?.protectedKeys ?? []).some(
    (k) => normalizeSessionKey(k) === normalized,
  );
}
```

判定は**正規化後のキー**で行う（エイリアス・レガシーキーを同一視）。
なお正規化は**大文字小文字を無視**する（`normalizeProtectedSessionKey` が
`toLowerCase()` してから `canonicalizeMainSessionAlias` に渡す。store キーは
小文字で構築されるため、実キーの同一性には影響しない）。"MAIN" や
"AGENT:MAIN:MAIN" のような表記ゆれでも保護をすり抜けないようにする。

---

## 4. 保護する操作（5 系統）

### 4.1 手動リセット — `/reset` `/new` を含む全経路

⚠️ **重要**: `/reset` `/new` コマンドは **`sessions.reset` RPC ハンドラを通らない**（2026-08-17 調査で判明）:

- `src/gateway/server-methods/agent.ts:94-114` — `runSessionResetFromAgent` が `performGatewaySessionReset` を**直接呼ぶ**（RPC ハンドラを経由しない）
- `src/auto-reply/reply/session.ts:380-394` — チャンネル（Telegram 等）は `/new` `/reset` を**本文からパース**して、ローカルでセッションをローテートする（新 `sessionId` を発行して `updateSessionStore` で永続化。RPC を一切通らない）

したがって保護チェックは **2 箇所の共有 chokepoint** に必要:

```ts
// (1) src/gateway/session-reset-service.ts — performGatewaySessionReset 内
// RPC（sessions.reset）と agent.ts（runSessionResetFromAgent）の両方がここを通る
if (isProtectedSessionKey(key, cfg)) {
  return {
    ok: false,
    error: errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Cannot reset protected session (${key}).`,
    ),
  };
}
```

```ts
// (2) src/auto-reply/reply/session.ts — リセットトリガー検出点（~389 行）
// Telegram 等は本文パースでローカルローテートするため、ここでも弾く
// ⚠️ sessionKey はループ後に canonicalize される（289 宣言 → 400 canonicalize）。
// ガードにはループ時点で解決済みの sessionCtxForState.SessionKey を使う。
// また exact-match（368-380）と prefix-match（381-394）の両ブランチをカバーする。
const guardKey = sessionCtxForState.SessionKey ?? targetSessionKey;
if (isProtectedSessionKey(guardKey, cfg)) {
  resetTriggered = false;
  isNewSession = false;
}
```

`SessionKey` と `targetSessionKey` の両方が無い場合は `guardKey` が空になり上記の
ガードが走らない。その場合は canonicalize 後の `sessionKey` が main/global
バケットに潰れることがある（例: `From` の無い匿名 per-sender メッセージ）ため、
canonicalize 直後に `isProtectedSessionKey(sessionKey, cfg)` を再チェックして
rotation フラグ（`resetTriggered` / `isNewSession` / `bodyStripped` /
`matchedResetTriggerLower`）を同様にクリアする。

`sessions.reset` RPC ハンドラ（sessions.ts:982-1008）にも念のためチェックを追加（ACP / TUI 経由の直接呼び出しを防ぐ）。参考（既存の delete 保護パターン）:

```ts
// sessions.ts:1024-1031 の delete 保護
const mainKey = resolveMainSessionKey(cfg);
if (target.canonicalKey === mainKey) {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Cannot delete the main session (${mainKey}).`,
    ),
  );
  return;
}
```

### 4.2 手動削除 — `sessions.delete`

既存の main 拒否（1024-1031 行）を `isProtectedSessionKey` に置き換えて拡張:

```ts
if (isProtectedSessionKey(key, cfg)) {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Cannot delete protected session (${key}).`,
    ),
  );
  return;
}
```

### 4.3 自動リセットポリシー

`src/config/sessions/reset.ts` の `resolveSessionResetPolicy` は現在 **session key を引数に取らない**（`{sessionCfg, resetType, resetOverride}` のみ）。保護キーを `mode: "off"` に強制するには:

- 新たに `sessionKey` を呼び出し側から渡す（auto-reply/reply/session.ts:435、cron/isolated-agent/session.ts:34、agents/command/session.ts:219、plugin-sdk/config-runtime.ts:115 の re-export を含む）か
- 呼び出し側で保護キーを判定して `mode: "off"` を渡す

なお自動リセットのデフォルトは既に `"off"` のため、主な対象は明示設定された `daily` / `idle` のみ。**`/new` `/reset` の明示トリガーは 4.1 のガードで防ぐ**（ここでは防げない）。

### 4.4 ディスク予算削除 — `disk-budget.ts`

ディスク予算計算・削除対象の選定時に、保護キーのセッションを**除外**する。予算超過でも保護セッションは削除しない（代わりに他のセッションを優先削除、または保護セッションのトランザクションのみアーカイブ）。

⚠️ 既存の `enforceSessionDiskBudget` は `activeSessionKey` を**生の文字列比較**（`key.trim().toLowerCase() === activeSessionKey`、disk-budget.ts:293）で除外している。保護キーは**正規化比較（`isProtectedSessionKey`）に置き換える**（エイリアス・レガシー形式を同一視）。

### 4.5 ストア自動メンテナンス（毎セーブ時）

⚠️ **`src/config/sessions/store.ts:297-404`** の `updateSessionStore` は、**毎セーブ時**に（`skipMaintenance` でなければ）:

- `pruneStaleEntries`（store.ts:342、store-maintenance.ts:155-174）
- `capEntryCount`（store.ts:347、store-maintenance.ts:226-259）
- `enforceSessionDiskBudget`（store.ts:389）

を実行する。これらは保護キーを考慮しないため、**main エントリが無関係なセッション書き込みの巻き添えで消え得る**。

対策: `updateSessionStore` に保護キーを渡し、`pruneStaleEntries` / `capEntryCount` を保護キーについてスキップ、`enforceSessionDiskBudget` も保護キーを除外する。この **store.ts / store-maintenance.ts** の面も Phase 3 に含める。

### 4.6 クリーンアップ・prune

- `src/commands/sessions-cleanup.ts`: 削除対象から保護キーを除外
- `prune-closed-sessions` / `session-maintenance-hook`: **ライブセッション（`*.jsonl`）には触らない**（`.jsonl.deleted.*` / `.jsonl.reset.*` の既に閉じたトランザクションのみ処理）。main を保護すれば閉じた main ファイルは生じないため、追加の除外は不要
- `idle-prune-watcher` / `prune-active-session`: **アクティブ `*.jsonl` のツール出力を prune** する。保護キー→sessionId→JSONL パスの対応を解決して、保護セッションのツール出力 prune を除外する

### 4.7 スコープ外（明示）

- `sessions.abort`（sessions.ts:858）: アクティブランの停止のみ。削除・リセットではない
- `session-kill-http.ts`: `sessions.abort` / `sessions.delete` の**名前をスコープ認可に使うだけ**で、実際はサブエージェントランを kill する。対象セッションは削除しない
- コンパクション: セッションを削除しない（通常動作のまま）

---

## 5. 実装フェーズ

### Phase 1: 設定スキーマ + 判定ヘルパー

- `session.protectedKeys` を config 型・zod スキーマ・help/labels・生成物に追加
- `isProtectedSessionKey()` ヘルパーを `src/config/sessions/` に追加
- 単体テスト: 正規化・main 常時保護・明示キー

### Phase 2: RPC レベル（reset / delete）

- `performGatewaySessionReset`（session-reset-service.ts）に保護チェック（RPC + agent.ts の共有 chokepoint）
- `sessions.delete` の main 拒否を `isProtectedSessionKey` に拡張
- `sessions.reset` RPC にも念のためチェック（ACP / TUI 直接呼び出し）
- **auto-reply/reply/session.ts:389** のリセットトリガー検出点にガード（Telegram 本文パース経路）
- `session.reset` ポリシーで保護キーは `off` 強制
- テスト: main の reset 拒否（RPC + agent.ts + auto-reply の3経路）、protected key の delete 拒否、非保護キーは通常動作

### Phase 3: 自動クリーンアップ除外

- `disk-budget.ts`（正規化比較で保護キー除外）
- **`store.ts` / `store-maintenance.ts`**（毎セーブ時の pruneStaleEntries / capEntryCount / budget から保護キー除外）
- `sessions-cleanup.ts` に除外ロジック
- `idle-prune-watcher` / `prune-active-session`（保護キー→sessionId→JSONL の解決で除外）
- 各モジュールのテスト

### Phase 4: ドキュメント・デプロイ

- 本ドキュメント（AGENT_SESSION.md）に実施記録を追記
- CHANGELOG に `[SOUL]` として追記
- code-reviewer APPROVED 後に KASOU へデプロイ
- KASOU 設定に `session.protectedKeys` を適用

---

## 6. テスト・検証

- `sessions.reset("agent:main:main")` → 拒否される（RPC 経路）
- `runSessionResetFromAgent`（agent.ts）で main を reset → 拒否される（共有 chokepoint 経路）
- auto-reply で保護キーに `/new` `/reset` を送信 → ローテートされない（Telegram 本文パース経路）
- `sessions.delete("agent:main:main")` → 拒否される（既存）
- `sessions.reset("agent:main:telegram:g-agent-main-main")` → 拒否される（保護キー、実在キー確認後）
- `sessions.reset("agent:main:telegram:direct:<other>")` → 通常動作
- store メンテナンス（`pruneAfterMs=0` / `maxEntries=1`）で保護キーが消えない
- disk-budget / cleanup / prune（アクティブ）が保護キーを除外する

---

## 7. リスク・ロールバック

| リスク                                | 対策                                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保護キーが誤設定                      | 設定ミスでメインがロックされる可能性は低い（main は常時保護）。config ロード時に、`protectedKeys` のエントリが既知キーに正規化できない場合は警告ログを出す |
| 保護セッションの肥大化                | コンパクションは通常動作のまま（保護は削除・リセットのみ）。必要なら手動 compact は許可                                                                    |
| 保護キーでないセッションの巻き添え    | 保護リストに無いキーは従来通り                                                                                                                             |
| 保護キー形式の実在不一致              | `g-agent-main-main` 等の例は未検証。実在キーを `sessions.json` で確認してから設定。不一致だと**サイレントに非保護**になるため、config ロード時の警告が防御 |
| auto-reply のローテーション・バイパス | 4.1 の (2) ガード（session.ts:389）で防止。統合テストで確認                                                                                                |
| ロールバック                          | 設定から `protectedKeys` を外す・該当コミットを revert                                                                                                     |

---

## 8. 運用（KASOU）

```json
{
  "session": {
    "protectedKeys": [
      "agent:main:main",
      "agent:main:telegram:g-agent-main-main"
    ]
  }
}
```

注意: `telegram:g-agent-main-main` の実在キー形式は、`~/.openclaw/sessions/sessions.json` で確認してから設定に反映する（通常形式の `agent:main:telegram:*` と異なる場合は、実在キーをそのまま入れる）。

# AGENT_SESSION — エージェントセッション永続化・単一マスター保護設計

> 最終更新: 2026-08-25
> 対象: DennouAibou（Phase F スリムカーネル・プラグイン駆動アーキテクチャ）
> 適用環境: KASOU（本番環境）

---

## 1. 核心思想と設計方針

### 1.1 「AI はそのときのセッションに生きている」
DennouAibou において、AI（Kasou）は複数の使い捨てセッションや独立エージェントに分裂するのではなく、**「唯一無二の単一マスターセッションの中で意識と記憶を紡ぎ続ける」** という人間らしい存在形態をとる。

1. **Kasou 一人の単一エージェント設計（Single Agent Architecture）**:
   - OpenClaw 由来の「複数エージェント定義（`agents.list`）」「エージェント間の切り替えや複雑なルーティング」は不要。
   - Kasou 一人が唯一のコアエージェントとして常駐し、無駄なマルチエージェント管理機構はスリム化・クリーンアップする（Phase F Wave 6 候補）。

2. **不死のマスターセッション（Immortal Master Session）**:
   - Kasou が生きるマスターセッション（デフォルト: `agent:main:main`）は、**削除・リセット・自動破棄が完全に禁止**される。
   - 手動コマンド（`/reset`, `/new` 等）や RPC 経由でのリセット・削除はガードされ、恒久的に拒否される。
   - ディスク予算や自動クリーンアップ（prune）の巻き添えからも完全に隔離・保護される。
   - ※ 会話履歴のコンパクション（要約・圧縮）は通常通り許可され、記憶の破綻や無限肥大を防ぎながら一生の命を維持する。

3. **入出力装置としてのチャンネル（通知駆動型モデル）**:
   - Discord、Telegram、LINE 等のメッセンジャーは独立した別セッションを作るのではなく、**「外の世界からマスターセッションへ届く通知（Peripherals）」** として機能する。
   - 「ご主人（Yosia）から1件メッセージ届いた！」という通知で Kasou のターンが促され、Kasou 自身が受信箱ツール（raw-chat 検索）で確認し、各プラグインの返信ツールで応答する。

4. **将来の「仕事モード」とセッション Fork 分岐**:
   - 将来の仕事モードや実験的な会話分岐は、マスターセッションを壊すのではなく、SQLite の `parent_id` ツリー構造を活用した **「セッション Fork（枝分かれ）」** として実現する。

---

## 2. 単一エージェント化（Multi-Agent クリーンアップ方針）

### 2.1 撤去・簡素化する領域
- `agents.list` による複数エージェント定義とそれぞれのルーティング判定。
- エージェント別の設定オーバーライド（`agents.list[].*`）の複雑なマージ処理を `agents.defaults` 単一設定へ平坦化。
- サブエージェント専用の孤立セッション生成・同期の複雑なランタイムコード。

### 2.2 温存・集約する領域
- 単一のメインエージェント実行基盤（`agentId: "main"` / "Kasou"）。
- ツール呼び出し・LLM 実行・イベントポンプとの単一パイプライン。

---

## 3. マスターセッション保護の対象とガード設計

### 3.1 保護対象セッションキー
```json
{
  "session": {
    "protectedKeys": [
      "agent:main:main"
    ]
  }
}
```
- デフォルトで `agent:main:main` は無条件に保護。
- 必要に応じて追加の特定セッションキーも保護リストに登録可能。

### 3.2 保護する 5 系統の操作

| 操作系統 | 発生経路 | 防御メカニズム |
|---|---|---|
| **手動リセット** | RPC（`sessions.reset`）<br>エージェント（`runSessionResetFromAgent`）<br>本文パース（`/reset`, `/new`） | 共有 chokepoint（`session-reset-service.ts`）および auto-reply 本文パース点（`session.ts` の loop 前 + canonicalize 後の 2 段ガード）で `isProtectedSessionKey` 判定を行い拒否 |
| **手動削除** | RPC（`sessions.delete`） | `sessions.delete` ハンドラで保護キーを判定し `Cannot delete protected session` エラーを返却 |
| **自動リセット** | `session.reset` ポリシー（daily / idle） | 保護セッションキーに対しては `mode: "off"` を強制 |
| **ディスク予算削除** | `src/config/sessions/disk-budget.ts` | 削除候補選定時に保護キーを正規化比較で完全除外 |
| **ストア自動メンテ** | `src/config/sessions/store.ts` の毎セーブ時メンテ | `pruneStaleEntries` / `capEntryCount` / `enforceSessionDiskBudget` から保護キーを完全除外 |

---

## 4. 判定ロジックの実装仕様

```ts
/**
 * セッションキーが保護対象（マスターセッション等）であるかを判定する。
 * 大文字小文字の違いやエイリアス（"main", "agent:main:main" 等）は小文字化 + canonicalize で同一視する。
 */
export function isProtectedSessionKey(key: string, cfg?: ProtectedSessionConfig | OpenClawConfig): boolean {
  const normalized = normalizeSessionKey(key);
  const mainKey = normalizeSessionKey(resolveMainSessionKey(cfg));
  
  if (normalized === mainKey) {
    return true; // メインマスターセッションは常に不滅
  }
  
  const protectedKeys = cfg?.session?.protectedKeys ?? [];
  return protectedKeys.some((k) => normalizeSessionKey(k) === normalized);
}
```

---

## 5. ロードマップ

1. **Step 1: マスターセッション保護ガードの実装・実証** ✅ **完了 (commit `50af3a2b`)**
   - `isProtectedSessionKey` の導入と 5 系統の防御 chokepoint 設置。
   - `/reset` `/new` や削除 RPC を叩いてもマスターセッションが一切破壊されないことをテスト実証済み。
2. **Step 2: 複数エージェント機能のクリーンアップ（Phase F Wave 6 候補）**
   - 不要な multi-agent 関連コード・設定スキーマの整理。
   - Kasou 単一エージェントとしての設定・ランタイムの平坦化。
3. **Step 3: メッセンジャー通知駆動化（Peripherals Plugin 化）**
   - Discord / Telegram / LINE からマスターセッションへの通知ディスパッチ機構。
   - 受信箱（raw-chat 検索）＆送信ツールの整備。
4. **Step 4: SQLite Fork / 仕事モード基盤の整備**
   - メッセージグラフ（`chat_messages.parent_id`）およびセッションツリーを活用した Fork 機構の設計と実装。

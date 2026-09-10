# RAW_CHAT_SEARCH — 低遅延ベクトル想起 ＆ 2段階想起アーキテクチャ設計書

> **状態**: 検証済み設計（実装準備完了）  
> **対象**: DennouAibou / `extensions/raw-chat-search`  
> **適用環境**: KASOU（AMD GX-217GA / Bun 1.4.0）  
> **関連ドキュメント**:  
> - `AGENT_SESSION.md`（保存・不滅マスターセッション ＆ 整合性ガード）  
> - `COMPACTION_FEATURE.md`（片付け・大工さんのカンナくず ＆ 裏方要約）  

---

## 1. 核心思想と目的（Outcome）

Kasou が Yosia との膨大な過去の会話（数万行・数百万トークン）の中から、現在の話題に関連する過去の記憶を**人間と同じ自然な感覚で思い出す**ための想起エンジンを設計する。

### 1.1 人間の記憶の思い出し方（2段階想起モデル）
- **強い記憶（類似度 85% 以上）**:
  パッと思い出す。過去の会話（往復ミニ会話）をプロンプトへ即座に直接注入し、文脈を完全に把握した状態で対話を開始する。
- **うっすらした記憶（類似度 60% 〜 85% 未満）**:
  「そういえば昔そんな話したっけな…」と頭の片隅に浮かぶ。プロンプトを圧迫しないよう、システム注記として「〇〇の話は過去ログに○件あります [ID: ...]」と短くヒントを告知するに留める。Kasou 自身が興味を持ったり必要と判断した時だけ、ツール（`chat_search`）を使って自律的に深掘りする。
- **無関係な記憶（類似度 60% 未満）**:
  思い出さない。プロンプトへの注入・告知は一切行わず、トークンと注意力を浪費しない。

---

## 2. 確定した設計判断（Confirmed Decisions）

| 項目 | 決定事項 | 理由・背景 |
|---|---|---|
| **Embedding モデル** | **Google Gemini Embedding API** (`text-embedding-004` 等) | CPA は Embedding 非対応のため、Google AI Studio の REST API を直接呼び出す |
| **API 認証・経路** | `.env` の `GEMINI_API_KEY` を使用し Google へ直通 | プロキシ等の余計なホップを挟まず、通信レイテンシ（100〜200ms）を最小化 |
| **検索・計算エンジン** | **SQLite BLOB ＋ 純粋 TypeScript (Float32Array 最適化)** | KASOU 実機（Bun 1.4.0）で 1,000 件 **3.55ms**、2,000 件 **7.10ms** を実証。目標（15ms 以内）を大幅にクリアし、外部 C 拡張や別言語プロセスを排除（KISS 原則） |
| **インデックス単位** | **「Yosia の発言 ＋ Kasou の返答」の 1 往復ペア** | ユーザーの質問にも Kasou の解説にも両面でヒットし、最も検索精度が高いため |
| **85% 以上の注入形式** | **ヒット往復 ＋ 前後 2〜3 往復のミニ会話** | 1 発言だけでは前後の文脈が掴めないため。「…まだ続きはある」の案内と参照用短縮 ID（例: `[ID: 120-125]`）を明記し可逆性を確保 |
| **60〜85% の告知形式** | **短い検索ヒント告知のみ** | `[記憶のヒント: 〇〇に関する過去ログが N 件一致 (ID: ...)]` と 1 行添えるのみ |

---

## 3. テリトリー調査結果（Territory Findings）

1. **実機スペックと計算速度（KASOU: AMD GX-217GA / AVX2 非対応）**:
   - `sqlite-vec` 等の C 拡張は AVX 命令やランタイムバインディングの地雷（クラッシュ・ビルド複雑化）を抱える。
   - 一方、Bun 1.4.0 上で 4 並列ループアンローリングを施した `Float32Array` 内積計算は、KASOU CPU 上で **1,000 件あたり約 3.5ms** で完走。15ms の SLO（サービス水準目標）に対して十分な安全マージンを確認済み。
2. **既存データベース (`raw-chat.sqlite`)**:
   - すでに `chat_messages`（通し番号 `id`、メッセージ ID、タイムスタンプ、本文等）および `chat_messages_fts`（FTS5 全文検索）が稼働中。
   - 新規テーブル `chat_embeddings` を追加して 1 つの SQLite ファイル内でテキスト検索とベクトル検索を完全同居可能。
3. **API キーの所在**:
   - KASOU 本番の `~/.openclaw/.env` に `GEMINI_API_KEY` が既に実在し稼働可能状態。

---

## 4. アーキテクチャとデータフロー（Architecture & Data Flow）

```
[ ユーザー入力 ]
      │
      ├────────────────────────────────────────────────┐
      ▼ (リアルタイム・低遅延)                           ▼ (非同期・バックグラウンド)
1. ユーザー発言 1 件を Google API でベクトル化       [ 会話完了後 (Turn 終了時) ]
   (Gemini Embedding: 約 100〜150ms)                   │
      │                                                ▼
2. SQLite から BLOB ベクトル読込 & 内積計算         新往復ペア (User + Assistant) を
   (Float32Array SIMD ループ: 約 3.5ms)                Google API でベクトル化して
      │                                                raw-chat.sqlite に保存
      ▼
3. 類似度スコアリング判定
      │
      ├─ [ 85% 以上 ] ──────────────────────────────────────────────┐
      │  ヒット箇所 + 前後 2〜3 往復を抽出                           │
      │  「...まだ続きはある [ID: 120-125]」付きでプロンプト即時注入 │
      │                                                              ▼
      ├─ [ 60% 〜 85% 未満 ] ─────────────────────────> [ プロンプト構築 ]
      │  「記憶のヒント: 〇〇の一致 N 件 [ID: ...]」告知              │
      │                                                              ▼
      └─ [ 60% 未満 ] ─────────────────────────────────> [ Kasou が思考・返答 ]
         (何も注入しない)
```

### 4.1 データベーススキーマ拡張 (`raw-chat.sqlite`)

```sql
-- ベクトル格納テーブル
CREATE TABLE IF NOT EXISTS chat_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL UNIQUE,     -- chat_messages.id (往復の代表ID)
  session_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL,            -- 768 等
  embedding BLOB NOT NULL,                -- Float32Array (バイナリ直書き)
  text_snippet TEXT NOT NULL,             -- ベクトル化対象テキスト抜粋
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_embeddings_session ON chat_embeddings(session_id);
```

### 4.2 類似度計算エンジン仕様 (`src/vector-math.ts`)

```ts
/**
 * 4並列ループアンローリングによるコサイン類似度（内積）計算。
 * 事前に L2 正規化（単位ベクトル化）して保存することで、検索時は内積のみで類似度（0.0〜1.0）が得られる。
 */
export function cosineSimilarityBatch(
  queryVec: Float32Array,
  dbVectors: Float32Array, // 全ベクトルを連結した単一フラット配列
  count: number,
  dim: number,
  scoresOut: Float32Array,
): void {
  for (let j = 0; j < count; j++) {
    let dot0 = 0, dot1 = 0, dot2 = 0, dot3 = 0;
    const offset = j * dim;
    for (let k = 0; k < dim; k += 4) {
      dot0 += dbVectors[offset + k] * queryVec[k];
      dot1 += dbVectors[offset + k + 1] * queryVec[k + 1];
      dot2 += dbVectors[offset + k + 2] * queryVec[k + 2];
      dot3 += dbVectors[offset + k + 3] * queryVec[k + 3];
    }
    scoresOut[j] = dot0 + dot1 + dot2 + dot3;
  }
}
```

### 4.3 プロンプト注入フォーマット

#### ① 85% 以上（即時注入メッセージ）
プロンプトの直前（コンテキスト注入層）に以下の形式で差し込む：

```markdown
<recalled-memory type="verbatim" relevance="high">
[過去の記憶: 関連度 88% — ID: 120-124 より引用]
User (2026-04-08): このライブラリの設定ってどうするんだっけ？
Kasou (2026-04-08): 〇〇を設定ファイルに追加して、ポートを8317にすれば動くよ！
User (2026-04-08): 了解、やってみる。
Kasou (2026-04-08): 成功した！ログも綺麗に出てるね。
...（この会話には前後に続きがあります。詳細が必要な場合は `chat_search` ツールで ID 範囲を指定して確認できます）
</recalled-memory>
```

#### ② 60% 〜 85% 未満（ヒント告知メッセージ）
プロンプト末尾またはシステム注記として短く添える：

```markdown
<recalled-memory type="hint" relevance="medium">
[記憶のヒント: この話題に関連する過去の会話が 2 件見つかりました (ID: 342, 510)。必要に応じて `chat_search` ツールで確認できます]
</recalled-memory>
```

---

## 5. 前提条件と検証状況（Assumptions）

| 前提条件 | 分類 | 根拠 |
|---|---|---|
| KASOU 上で TypeScript 内積計算が 15ms 以内で完走する | **Verified** | KASOU 実機ベンチマークで 2,000 件が 7.10ms、1,000 件が 3.55ms を記録 |
| `GEMINI_API_KEY` が KASOU に存在し利用可能である | **Verified** | `~/.openclaw/.env` 内に実在を確認済み |
| ベクトル化対象は「会話の往復ペア」が最も適切である | **Verified** | ユーザー裁定により確定 |
| Google AI Studio Embedding のネットワーク往復が許容内（150ms 前後）である | **Reasonable** | 一般的な Google AI Studio 東京/海外リージョンの REST レスポンス速度 |

---

## 6. リスクと緩和策（Risks & Mitigations）

1. **Google Embedding API の一時障害やタイムアウト**:
   - **リスク**: Google API が遅延またはエラーになると、ユーザーへの返信全体がブロックされる。
   - **緩和策**: 埋め込み取得に厳格な **`timeout: 400ms`** を設定。タイムアウトまたはエラー時は一切ブロックせず、想起処理を静かにスキップ（フォールバック）して通常返信へ進む（フェイルオープン設計）。
2. **会話数増加による SQLite BLOB 読み込みオーバーヘッド**:
   - **リスク**: 1万件を超えた時、毎回全 BLOB を DB から読むとディスク I/O が増える。
   - **緩和策**: ベクトル配列はインデクサー更新時のみ再ロードし、普段はメモリ上の単一 `Float32Array` バッファにキャッシュする。

---

## 7. 実装ロードマップ（Sequencing）

### Phase 1: データ層と計算エンジン（`extensions/raw-chat-search`）
- `chat_embeddings` テーブルの DDL 追加とマイグレーション。
- Google Gemini Embedding API クライアント（REST / `fetch` 実装、400ms タイムアウト付き）。
- `vector-math.ts`（4並列アンローリング内積計算・コサイン類似度）と単体テスト。

### Phase 2: バックグラウンドインデクサー拡張
- 新規メッセージ書き込み時に、往復ペア（User + Assistant）を自動で抽出して非同期ベクトル化・保存するフック処理の実装。
- 既存 991 件の過去ログに対する一括初期インデックス（バックフィル）スクリプト。

### Phase 3: 2段階想起パイプライン（フック接続）
- メッセージ受信時（`before_prompt_build` またはプロンプト構築前）のクエリベクトル化と類似度スコアリング。
- 85% 以上（文脈付きミニ会話注入）と 60〜85%（ヒント告知）のフォーマッター実装。
- 単体テスト・統合テスト・実機検証。

---

## 8. 結論（Readiness Verdict）

**Ready to implement** — 設計上の主要な判断、実機パフォーマンス実証、安全弁（タイムアウトとフェイルオープン）の仕様がすべて固まり、実装を開始できる状態にある。

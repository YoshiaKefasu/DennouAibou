# 電脳アラーム (DENNOU_ALARM.md) — 自律的体内時計・タイマー ＆ スケジュール管理プラグイン設計書

> **状態**: 設計改訂（レビュー指摘 ＆ ユーザー要件反映済み）  
> **対象**: DennouAibou / `extensions/dennou-alarm`  
> **関連ドキュメント**:
>
> - `AGENT_SESSION.md`（単一不滅マスターセッション ＆ 通知モデル）
> - `PHASE_F_SLIM_KERNEL.md`（スリムカーネル ＆ 全部プラグイン化構想）
> - `DEBLOAT.md`（旧 Cron サブシステムの退役・撤去計画）

---

## 1. 背景とコア思想（Background & Core Philosophy）

### 1.1 従来の「Cron」が抱えていた課題

従来の OpenClaw 由来の Cron 機構（`src/cron/` 配下 130ファイル・実測 25,759行、うち非テスト 9,985行）は、システム管理者向けの無骨なインフラ機能であった：

- **過剰に複雑なJSON構造**:
  `schedule.kind = "every"`, `everyMs = 3600000`, `payload.kind = "agentTurn"`, `delivery.mode = "announce"`, `sessionTarget = "main"` など、数十個のパラメータを要求する。
- **Kasou が自律的に使えない**:
  会話の中で Yosia から「15分後に教えて」「毎朝9時に起こして」と頼まれても、LLM がこの複雑なスキーマを正確に構築して呼び出すのは認知負荷が高く、パラメータ生成失敗や配送漏れ（`delivery: not-requested` で無言で終わる等）が頻発していた。
- **ユーザー発言偽装（role: "user" 汚染）**:
  従来のイベントポンプやCronは、通知メッセージを「架空のユーザー発言」としてセッションにねじ込んでいたため、画面上でYosiaが喋ってもいないのにユーザー吹き出し内にシステム通知が混ざる不自然さがあった。
- **カーネル肥大化の温床**:
  タイマー監視、配信キュー、セッション分離、分離エージェント実行など、巨大なロジックがカーネル内部に居座り、Phase F の「カーネルは細く、機能はプラグインへ」の原則に反していた。

### 1.2 『電脳アラーム』の核心思想

Kasou は単なるチャットボットではなく、Yosia の生活と作業に寄り添うパートナーである。
人間が「スマホのタイマーをセットする」「手帳にリマインダーを書く」のと同じように、**Kasou 自身が自分の体内時計として直感的に扱えるシンプルなアラームツール** を提供する。

- **極限までシンプルなツール設計**:
  `action`（set/list/cancel）、`time`（15m / 18:30 / 毎日 09:00）、`task`（やること）の 3 項目だけで完結。
- **単発タイマーも、定期アラームも 1 つのツールで統一**:
  「10分後に声かけて」も「毎朝8時に今日の天気を教えて」も同じ構文。
- **通知メッセージの完全なシステムロール（role: "system"）化**:
  アラーム発火通知はユーザーの発言ではなく「体内時計からのアラーム音」としてセッションに記録。Yosiaのチャット吹き出しを一切汚さない。
- **手元のアクティブチャネル（Telegram/Discord）への自動直通配送**:
  アラームが鳴った時、Kasou は自動で目を覚まし、直近で Yosia と話していた場所（`lastChannel` / `lastTo`）へ自然に話しかけてくる。明示的な配送設定は一切不要。
- **プラグイン化と将来の一本化 (`extensions/dennou-alarm`)**:
  独立プラグインとして完結させ、安定稼働後に旧 `src/cron` を完全撤去（DEBLOAT）する。

---

## 2. ツール仕様 (`alarm`)

Kasou のツールセットに提供する単一のツール定義。

### 2.1 スキーマ定義 (TypeBox 規約準拠)

リポジトリ規約（`src/agents/schema/typebox.ts`）に準拠し、プロバイダ側で拒否される `Type.Union([Type.Literal(...)])`（anyOf コンパイル）を排除し、フラットな文字列 enum（`stringEnum`）を使用する。

```typescript
import { Type } from "typebox";
import { stringEnum } from "../../schema/typebox.js";

export const ALARM_ACTIONS = ["set", "list", "cancel"] as const;

export const AlarmToolSchema = Type.Object({
  action: stringEnum(ALARM_ACTIONS, {
    description: "操作種別: set=アラームをセット, list=一覧表示, cancel=キャンセル",
  }),
  id: Type.Optional(
    Type.String({
      description: "キャンセルするアラームのID（例: 'alarm_1'）。action='cancel' で必須。",
    }),
  ),
  time: Type.Optional(
    Type.String({
      description:
        "時間指定。相対時間（例: '30s', '5m', '1h', '2h30m'）または時刻指定（例: '18:30', '09:00'）。action='set' で必須。",
    }),
  ),
  task: Type.Optional(
    Type.String({
      description:
        "アラーム発火時にエージェントが実行するタスク内容・メッセージ。action='set' で必須。",
    }),
  ),
});
```

### 2.2 入口バリデーション規約

ツールの実行エントリポイントで相関バリデーションを行い、欠落時は LLM に親切な具体的エラーを返す：

- `action === "set"`: `time` と `task` が必須。欠落時は `Error: action='set' requires both 'time' and 'task'`
- `action === "cancel"`: `id` が必須。欠落時は `Error: action='cancel' requires 'id'`
- `action === "list"`: 追加引数は不要。現在のアラーム一覧を整然と返却。

### 2.3 サポートする時間表現 (`time`)

自然な時間文字列をプラグイン内部の軽量パーサーが自動判別する：

| 種別                 | 表記例                              | 内部解釈                             | 動作                                |
| -------------------- | ----------------------------------- | ------------------------------------ | ----------------------------------- |
| **相対タイマー**     | `"30s"`, `"15m"`, `"1h"`, `"2h30m"` | 現在時刻 ＋ 指定ミリ秒               | 1回実行して自動削除（ワンショット） |
| **当日/翌日時刻**    | `"18:30"`, `"09:00"`                | 直近のその時刻（過ぎていれば翌日）   | 1回実行して自動削除（ワンショット） |
| **特定日時**         | `"2026-10-02 10:00"`                | 指定の特定日時                       | 1回実行して自動削除（ワンショット） |
| **定期インターバル** | `"every 1h"`, `"every 30m"`         | 指定ミリ秒ごとの繰り返し（最小60秒） | 永続定期実行                        |
| **毎日定期**         | `"daily 08:30"`, `"everyday 22:00"` | 毎日指定時刻                         | 永続定期実行                        |
| **曜日指定**         | `"weekly mon 09:00"`                | 毎週特定曜日の指定時刻               | 永続定期実行                        |
| **Cron式 (上級)**    | `"0 9 * * 1-5"`                     | 標準 5/6 フィールド Cron             | 平日朝9時など高度な定期             |

※ タイムゾーンは `agents.defaults.userTimezone`（KASOU: `Asia/Jakarta`）を真実源とし、未設定時のみホストのシステムタイムゾーンにフォールバックする。全時間形式で同一のタイムゾーン解決器を使用する。

### 2.4 返却フォーマット (`list`)

`alarm({ action: "list" })` 実行時の出力形式例：

```
【現在セットされている電脳アラーム (2件)】
- [alarm_1] 18:30 (あと 45分): Adobe無料体験の解約手続き確認
- [alarm_2] 毎日 09:00 (次回: 明日 09:00): 今日の予定確認と挨拶
```

未登録時：

```
現在セットされているアラームはありません。
```

---

## 3. 発火・実行・配送アーキテクチャ（Delivery Architecture）

```
[ 時間到来 (Timer Fire) ]
          │
          ▼
1. dennou-alarm スケジューラー
   - 期限到達を検知
   - 内部DBから対象アラームを取得
   - 連続実行ガード＆重複チェック
          │
          ▼
2. イベントポンプ (event-pump / カーネル)
   - システム通知メッセージを注入:
     「【電脳アラーム発火 (ID: alarm_1)】タスク: Yosiaに3分経ったと伝える」
   - ★重要: メッセージ種別は role: "system" として注入！
     (Yosiaのユーザー発言吹き出しを汚さない)
   - 配送先オプション: heartbeat: { target: "last" } を強制指定！
     (「どこに送ればいいか分からないから捨てる」事故を構造的に排除)
   - agent:main:main のターンを自律起動
          │
          ▼
3. Kasou の自律思考 ＆ メッセージ生成
   - 「システム（体内時計）からアラームが鳴った」と正しく認識
   - 直近の会話文脈 ＋ アラームの指示に基づき、パートナーとして返答を生成
          │
          ▼
4. アウトバウンド自動配送 (Auto Delivery)
   - lastChannel (Telegram / Discord) へメッセージを直通配信！
   - Yosia の手元スマートフォンに通知が届く！
   - (ワンショットアラームの場合は内部DBから自動クリーンアップ)
```

### 3.1 「アクティブチャネル自動配送」の保証（Blocker 1 の解決）

既存の `event-pump.ts` は `heartbeat.target` が未設定の場合、`targets.ts:132` の既定値 `"none"` により `canRelayToUser = false` となりメッセージが外部チャネルに配送されない。
そのため、`dennou-alarm` からイベントポンプを起動する際は、以下のいずれかの方法で **`heartbeat: { target: "last" }` を確実に渡す** 契約とする：

- **方針 (c)**: `src/cron/service/timer.ts:1113` の確立されたパターンを踏襲し、発火契機で `runEventPumpOnce({ heartbeat: { target: "last" }, reason: "alarm:<id>" })` を明示呼び出しする。

### 3.2 メッセージの `role: "system"` 化（ユーザー要件の反映）

- アラーム発火時のテキストは、`role: "user"` のチャットメッセージとしてではなく、**`role: "system"`（システム通知 / systemEvent）** としてセッション履歴（JSONL）およびプロンプトに注入する。
- これにより、Telegram・WebUI 上で Yosia 自身の発言枠にシステムタグが表示される違和感を完全に解消し、モデル側にも「ユーザーではなくシステムからのアラーム」として正しく文脈が伝達される。

---

## 4. 内部データ構造と永続化（Storage & Persistence）

Gateway の再起動や停電が発生しても、セットしたアラームが絶対に消えない設計とする。

### 4.1 格納先

- 保存先: `~/.openclaw/agents/main/dennou-alarm.json`
- 1 アラームあたりのデータ構造：

```typescript
export interface StoredAlarm {
  id: string; // 一意なID (alarm_1, alarm_2, ...)
  label: string; // 短い識別名
  task: string; // Kasou が実行するタスク内容
  timeExpression: string; // ユーザー/Kasouが指定した元の文字列 ("15m", "daily 09:00")
  kind: "once" | "interval" | "cron";
  targetTimeMs?: number; // ワンショット時の次回発火 epoch ms
  intervalMs?: number; // インターバル時の周期 ms (最小 60_000ms)
  cronExpression?: string; // cron 時の式
  timezone?: string; // タイムゾーン (既定: Asia/Jakarta)
  createdAtMs: number;
  lastFiredAtMs?: number;
  enabled: boolean;
}
```

### 4.2 再起動時の安全保証（Catch-up ポリシーの完全定義）

Gateway 停止中に発火予定時刻を過ぎてしまったアラームの処理：

- **無効化アラーム (`enabled: false`)**:
  `action: "leave"` として無条件に現状維持（削除も再計算も行わず安全に保持）。
- **5分以内の微小遅延**:
  Gateway 起動直後に即時発火（通常通り通知）。
- **5分超〜1時間未満の中度遅延**:
  Gateway 起動直後に「少し遅れちゃったけど！」という遅延メタデータ付きで 1 回だけ発火実行。
- **1時間以上の大幅遅延**:
  - ワンショット（タイマー）: 過去の無効アラームとして安全にスキップ・削除し、ログに記録（夜間のPC停止中に溜まったタイマーが朝に連打爆発するのを防ぐ）。
  - 定期アラーム（daily / interval）: 過去の未実行分は破棄し、**次回の未来の発火時刻に再計算してセット（バースト実行を禁止）**。

### 4.3 永続化と発火の順序整合性

- イベントポンプへの投入（`enqueueSystemEvent`）が成功したことを確認した**後**にのみ、`lastFiredAtMs` を更新およびワンショット削除をディスクへフラッシュする。
- アラーム発火処理中のクラッシュによる二重発火やキュー消失を防ぐ。

---

## 5. 段階的実装ロードマップ（Phased Implementation Plan）

本機能は既存の稼働中システムを一切壊さず、安全な 3 段階で導入する：

### 🏁 Phase 1: `extensions/dennou-alarm` 新設 ＆ `alarm` ツール実装

- `extensions/dennou-alarm/` ディレクトリ新設。
- 時間パーサー（相対時間、時刻指定、cron構文の解釈、タイムゾーン解決）の実装。
- 永続化ストレージ（JSON）およびタイマースケジューラーの実装。
- `alarm` ツールの登録（TypeBox enum スキーマ、相関バリデーション）。
- 単体テストの網羅（Bun / Vitest）。

### 🏁 Phase 2: アクティブチャネル自動配送 ＆ `role: "system"` 注入

- タイマー発火時にマスターセッション（`agent:main:main`）へ `role: "system"` メッセージとして注入。
- `heartbeat: { target: "last" }` による `lastChannel`（Telegram / Discord）への自動通知パイプラインの確立。
- KASOU 実機での Telegram 疎通テスト（「3分後に声かけて」で 3 分後に Telegram に届く実機検証）。

### 🏁 Phase 3: 旧 `src/cron` の計画的 DEBLOAT ＆ 一本化

`dennou-alarm` の安定稼働確認後、旧来の無骨な `src/cron/` を安全に撤去する。
既存の cron 依存関係を以下のように電脳アラームへ完全一本化する：

| 既存の cron 依存箇所                                    | 規模・役割                     | 電脳アラームへの移行・代替方針                      |
| ------------------------------------------------------- | ------------------------------ | --------------------------------------------------- |
| `extensions/session-integrity-guard`                    | 日次整合性チェックジョブ (2件) | `dennou-alarm` の内部システム定期ジョブとして再登録 |
| `src/agents/tools/cron-tool.ts`                         | 旧 cron ツール                 | 完全撤去（`alarm` ツールへ完全一本化）              |
| `src/gateway/server-cron.ts` / `server-methods/cron.ts` | 旧 cron API / RPC              | `dennou-alarm` 向けエンドポイントへ移行または撤去   |
| `src/cli/cron-cli/*`                                    | 旧 cron CLI コマンド           | `dennou-alarm` CLI へ刷新または撤去                 |
| `ui/src/ui/{controllers,views}/cron.ts`                 | WebUI cron パネル              | 電脳アラーム管理パネルへ刷新または撤去              |
| `src/cron/` 本体 (130ファイル・約2.5万行)               | 旧スケジューラー・runner       | **完全削除（DEBLOAT）**                             |

---

## 6. まとめ

『電脳アラーム』により、Kasou は「指示待ちの受動的AI」から「自ら時間を把握し、タイミングよく話しかけてくれる本当の相棒」へと進化する。
通知がユーザー発言を汚さず、手元の Telegram に自然に届く、シンプルで人間味あふれる最高の機能設計とする。

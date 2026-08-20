# `An unknown error occurred` / fallback failure 調査レポート（訂正版）

**作成日**: 2026-05-23  
**対象**: KASOUで発生した `An unknown error occurred` とGemini→GPT‑5.4 fallbackが動かない問題

---

## 1. 問題の要約 — 平易な説明

KASOUで `gemini-3.1-pro-preview` へのリクエストが `An unknown error occurred` で終わり、fallback先の `openai-codex/gpt-5.4` に切り替わらなかった。

**正しい因果関係**：

```
Google API → 正常応答(HTTP 200)だが、finishReasonが"STOP"以外
    ↓
mapStopReasonString(google-transport-stream.ts:167) → デフォルトケースで"error"に丸める
    ↓
transport-stream-shared.ts:89-90 → "An unknown error occurred" に潰す
    ↓
classifyFailoverReason → null（どのfallback分類にも合わない）
    ↓
failover-policy.ts → continue_normal（fallback発火せず）
```

**注意**: 初版レポートでは「Gemini CLI v0.37.1 の既知のバグが原因」と書いたが、**これは誤りだった**（訂正済み）。  
OpenClawの `google-gemini-cli` プロバイダは `gemini` バイナリをAPI呼び出しに使わず、直接Google APIを叩く。

---

## 2. KASOUの環境

| 項目 | 値 |
|---|---|
| Gemini CLI バージョン | v0.37.1 (Homebrew) — **API呼び出しには未使用** |
| OpenClaw primary model | `google-gemini-cli/gemini-3.1-pro-preview` |
| Fallback候補 | `openai-codex/gpt-5.4`, `google-gemini-cli/gemini-3-flash-preview`, 他 |
| Node.js | v25.9.0 (Linuxbrew) |

---

## 3. モデル名の変更はあったか？

**結論: モデル名自体は変わっていない。**

- `gemini-3.1-pro-preview` は2026-02-19登場の有効なモデルID
- `gemini-3-pro-preview` は2026-03-09利用終了 → `gemini-3.1-pro-preview` が後継
- Google I/O 2026 (5/19) 発表:
  - **Gemini 3.5 Flash** — 新しいデフォルトモデル（3.1 Proを超える性能）
  - **Gemini 3.5 Pro** — 2026年6月公開予定
  - **Gemini Omni** — マルチモーダル新モデル
  - これらは `gemini-3.1-pro-preview` を置き換えるものではなく上位の選択肢
- Gemini CLIは組織ライセンス/API有料ユーザー向けに継続（2026-06-18に無料提供終了）

---

## 4. 本当の原因

### 4.1 OpenClawがGoogle APIエラー詳細を潰している（一次原因）

**コードで確認**：

| # | ファイル | 行 | 動作 |
|---|---------|----|------|
| 1 | `src/agents/google-transport-stream.ts` | 161-169 | `mapStopReasonString()` — デフォルトケースで全ての非`STOP` finishReasonを `"error"` に丸める |
| 2 | `src/agents/transport-stream-shared.ts` | 89-90 | `stopReason === "error"` → `throw new Error("An unknown error occurred")` |
| 3 | `src/agents/pi-embedded-helpers.ts` | `classifyFailoverReason` | `"An unknown error occurred"` → `null` を返す（テスト `pi-embedded-helpers.test.ts:663` で確認） |

**結果**: Google APIからの具体的なfinishReason（`SAFETY`, `RECITATION`, `OTHER`, 等）が失われる。

### 4.2 thinkingLevel注入は正常に動作している

誤解を避けるため：`google-stream-wrappers.ts:6-9` の `isGemini31Model()` は `gemini-3.1-pro-preview` を正しく認識する。  
`createGoogleThinkingPayloadWrapper` は `extra-params.ts:396` で適用されており、APIリクエストに `thinkingLevel` が含まれていることを確認済み。

### 4.3 考えられるシナリオ（KASOUのAPI応答が不明なため推定）

| シナリオ | 発生確率 | 根拠 |
|----------|---------|------|
| **A**: APIがHTTP 200 + finishReason=`OTHER`/`SAFETY`を返した | **高い** | ログの `failoverReason: null` はこの経路と一致 |
| **B**: APIがHTTP 400/500を返したが、`classifyFailoverReason` が分類に失敗 | 低い（400は"format"に分類されるはず） | コード上400系エラーは `"format"` になる |
| **C**: Gemini CLI v0.37.1 の `defaultModelConfigs.ts` バグ | **関連なし** | OpenClawはgemini binaryを経由しない |

シナリオAが最も可能性が高い。つまり**Google API自体が正常応答(200)を返したが、中身のfinishReasonが想定外だった**ケース。

### 4.4 参考: PR #27007 について

`fix(core): add aliases and thinking config for gemini-3.1 models` (2026-05-15 merged) —  
これはGemini CLIバイナリ自身のモデル設定を修正するものであり、**OpenClawのAPI呼び出しには直接関係しない**。  
直接 `gemini` コマンドを使う場合にのみ影響する修正。

---

## 5. Fallback が効かなかった理由（詳細）

### 5.1 ログからの証拠

KASOUログ `openclaw-2026-05-23.log:482`:
```
error: "An unknown error occurred"
failoverReason: null
```

### 5.2 コードの判定フロー

`src/agents/pi-embedded-runner/run/failover-policy.ts` の判定：

```
shouldRotateAssistant({ failoverReason: null, timedOut: false, ... })
  → false（回転不要）
↓
decision.action === "continue_normal"
  → failover発火せず、エラーをそのまま返す
```

### 5.3 対比: `"format"` として分類されれば

万一HTTP 400の場合は `classifyFailoverReason("Google Generative AI API error (400): ...")` が `"format"` を返し、  
`shouldRetry` が `true` になるためfallbackが発火する。今回そうならなかった = **200 OKが返っていた** ことを示唆する。

---

## 6. 修正案（優先順位順）

### 6A（実装済み） — `transport-stream-shared.ts` + `google-transport-stream.ts` でfinishReasonを保存する

**実際に適用した修正**:

**ファイル1**: `src/agents/google-transport-stream.ts:728-733`
finishReason が非STOP/非MAX_TOKENSの場合、`output.errorMessage` に元のfinishReasonを保存。

```typescript
if (typeof candidate?.finishReason === "string") {
    output.stopReason = mapStopReasonString(candidate.finishReason);
    if (output.content.some((block) => block.type === "toolCall")) {
      output.stopReason = "toolUse";
    }
    // DennouAibou: preserve non-STOP finishReasons for diagnostics
    if (output.stopReason === "error" && candidate.finishReason !== "STOP") {
      output.errorMessage = `Google API finishReason: ${candidate.finishReason}`;
    }
}
```

**ファイル2**: `src/agents/transport-stream-shared.ts:89-90`
`output.errorMessage` が設定されていれば、それをthrowするErrorに含める。

```typescript
// Before: throw new Error("An unknown error occurred");
// After:
if (output.stopReason === "aborted" || output.stopReason === "error") {
    const detail = output.errorMessage ? ` (${output.errorMessage})` : "";
    throw new Error(`An unknown error occurred${detail}`);
}
```

**効果**:
- `"An unknown error occurred"` → `"An unknown error occurred (Google API finishReason: SAFETY)"` に変化
- `classifyFailoverReason` の戻り値は変わらない（SAFETY/RECITATIONはfallback対象外のため）
- `lastAssistant.errorMessage` に詳細が残るようになる
- ログで原因が一目で分かる

**既存テストへの影響**: なし。テストは独自の文字列 `"An unknown error occurred"` を直接使っている。

### 6B（バンドエイド） — モデルを変更して回避

KASOUのconfigで `google-gemini-cli/gemini-3.1-pro-preview` → 代わりのモデルに変更

候補:

| モデル | メリット | デメリット |
|--------|---------|-----------|
| `gemini-2.5-pro` | 安定、確実に動く | 3.1より能力が低い |
| `gemini-3.5-flash` | I/Oで発表された最新 | まだ正式にOpenClawに未対応かも |
| `gemini-3.1-pro-preview-customtools` | 同じ3.1系、customtools最適化版 | APIキーユーザー専用、同じfinishReason問題が起きうる |

### 6C — `transport-stream-shared.ts` でエラー詳細を維持する

`src/agents/transport-stream-shared.ts:89-90`

```typescript
// 現在: "An unknown error occurred" に潰す
throw new Error("An unknown error occurred");
```

元のエラーメッセージ（あれば）を維持するように変更する。

---

## 7. Google I/O 2026 関連発表まとめ

| 発表 | 日付 | 影響 |
|------|------|------|
| Gemini 3.5 Flash 公開 | 2026-05-19 | 新しい最速モデル |
| Antigravity CLI 発表 | 2026-05-19 | Gemini CLIからの移行先 |
| Gemini CLI 無料提供終了予告 | 2026-05-19 | 2026-06-18で無料ユーザー終了。有料ユーザーは継続 |
| Gemini CLI は終了しない | 同上 | 組織ライセンス/API有料ユーザーは引き続きサポート |
| Gemini 3.5 Pro | 2026年6月予定 | 内部テスト中 |

---

## 8. 上流OpenClawの状況

`git diff v2026.4.5..origin/main — src/agents/transport-stream-shared.ts` を確認した結果：

| 項目 | 上流 main | DennouAibou (v0.6.0) |
|------|-----------|----------------------|
| `finalizeTransportStream` の `"An unknown error occurred"` | **未修正**（同コード） | **未修正**（同コード） |
| `TransportOutputShape` | `errorCode`, `errorType`, `errorBody` 追加あり | 無し |
| `assignTransportErrorDetails` | `failTransportStream` で使用 | 無し（`failTransportStream` も古い形式） |
| `extractTransportErrorDetails` | 追加済み | 無し |

上流でも `finalizeTransportStream` の `"An unknown error occurred"` 問題は**同じまま** → DennouAibouで独自に修正する判断。

---

## 9. 次のアクション（推奨）

1. **短期**: 6Aを実装 — `mapStopReasonString` の改善（DennouAibou独自の改善として）
2. **代替**: 6Bでモデルを `gemini-2.5-pro` に切り替えて急場をしのぐ
3. **中期**: `transport-stream-shared.ts` のエラー詳細維持（6C）
4. **長期**: Antigravity CLI移行の動向観察（急ぐ必要なし）

---

## 9. 訂正履歴

| 版 | 日付 | 内容 |
|----|------|------|
| 初版 | 2026-05-23 | 「Gemini CLI v0.37.1のバグが原因」と誤認 |
| 訂正版(本版) | 2026-05-23 | コードレビューで誤りを指摘され修正。真因はOpenClawのAPI応答処理にあることを追記 |

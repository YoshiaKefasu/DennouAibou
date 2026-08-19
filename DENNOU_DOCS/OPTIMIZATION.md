# OPTIMIZATION — OpenClaw Startup Improvements for DennouAibou

> 最終更新: 2026-08-17
> 対象: DennouAibou（OpenClaw Hard Fork, base v2026.4.5）

## 1. 目的

OpenClaw上流のリリースノートから、startup速度・メモリ削減・バンドル最適化に関する改善を調査し、DennouAibouへの適用可能性を文書化する。将来の実装計画のベースとする。

---

## 2. 調査対象リリース

| リリース             | 日付    | 注目度                          |
| -------------------- | ------- | ------------------------------- |
| **v2026.8.1-beta.2** | 2026-08 | ★★★★（startup改善30件以上）     |
| v2026.7.2-beta.7     | 2026-07 | ★★（lean mode、memory recall）  |
| v2026.7.1-1          | 2026-07 | ★（startup migration recovery） |
| v2026.6.34           | 2026-06 | ★（slim container tag）         |

---

## 3. v2026.8.1-beta.2 主要改善（startup関連）

### 3.1 CLI plugin listing cold-start memory reduction

- **変更内容**: state-migration runtime loading をスキップ（legacy inputs がない場合）
- **影響**: packaged cold-start memory を削減
- **DennouAibou影響**: memory-core等のplugin loadingで適用可能
- **適用難度**: ★★（plugin loadingパスの変更）

### 3.2 FTS-only memory startup

- **変更内容**: `memorySearch.provider: "none"` の場合、plugin capability discovery をスキップ
- **影響**: 不要なcold-start scanを回避
- **DennouAibou影響**: DEBLOAT後もmemory-coreが残ってる。設定でmemorySearchが不要なら適用可能
- **適用難度**: ★★（memorySearch provider判定の追加）

### 3.3 Gateway startup migrations

- **変更内容**: 設定変更時にmigration lease を即時解放（5分待機不要）。Fixes #103145
- **影響**: gateway起動速度改善、設定変更後の即時再起動が可能
- **DennouAibou影響**: gateway startup最適化。適用容易
- **適用難度**: ★（migration lease管理の変更）

### 3.4 Control UI dynamic deep links

- **変更内容**: 初回route loader結果を再利用、startup時の冗長ワークを回避
- **影響**: UIstartup改善
- **DennouAibou影響**: Control UI スタートアップ改善
- **適用難度**: ★★（route-loader実装の変更）

### 3.5 Lean mode / ツールサーフェストリミング

- **変更内容**: lean agent surfaces で media/TTS/PDF ツールを削減
- **影響**: 不要ツールのロード回避、メモリ削減
- **DennouAibou影響**: DEBLOATと組み合わせて、不要ツール削減
- **適用難度**: ★★★（ツールサーフェスの定義変更）

### 3.6 ACPX cleanup process inspection

- **変更内容**: `ps` 呼び出しのバウンド（startup cleanup ハング防止）
- **影響**: process management の堅牢化
- **DennouAibou影響**: ACPX使用時のstartup安定性
- **適用難度**: ★（process inspect のバウンド追加）

### 3.7 Gateway event dispatch lazy subscriber

- **変更内容**: lazy subscriber setup の failure を catch & log（unhandled rejection防止）
- **影響**: startup時のエラーハンドリング改善
- **DennouAibou影響**: plugin/event dispatch の堅牢化
- **適用難度**: ★★（event dispatch の error handling）

### 3.8 Plugin module identity

- **変更内容**: jiti transforms で plugin entries を重複評価しないよう、Node native module graph に載せる
- **影響**: duplicate evaluation / class identity drift の防止
- **DennouAibou影響**: plugin loading の正確性改善
- **適用難度**: ★★★（module identity管理の変更）

### 3.9 Source build portability (tsdown)

- **変更内容**: tsdown 設定を自己完結させ、unrun's temp module dir に依存しない
- **影響**: ビルドの再現性改善
- **DennouAibou影響**: ビルド環境依存の削減
- **適用難度**: ★★（tsdown設定の分離）

---

## 4. DennouAibouへの適用候補（推奨順）

| 優先度 | 項目                                    | 効果                     | 難度 |
| ------ | --------------------------------------- | ------------------------ | ---- |
| 1      | Gateway startup migration lease解放     | startup速度改善          | ★    |
| 2      | CLI plugin listing cold-start reduction | memory削減               | ★★   |
| 3      | FTS-only memory startup                 | memorySearch不要時高速化 | ★★   |
| 4      | Control UI route-loader再利用           | UI startup改善           | ★★   |
| 5      | ACPX cleanup process inspection         | 堅牢化                   | ★    |
| 6      | Gateway event dispatch lazy subscriber  | 堅牢化                   | ★★   |
| 7      | Lean mode ツールサーフェス              | メモリ削減               | ★★★  |
| 8      | Plugin module identity                  | 正確性改善               | ★★★  |
| 9      | Source build portability (tsdown)       | ビルド再現性             | ★★   |

---

## 5. 適用方針

- v2026.8.1-beta.2 のコードを直接cherry-pickせず、**DennouAibou側で独立実装**
- 上流コードを参考に、DennouAibouのコードベースに最適化を適用
- DEBLOAT済みのため、不要プロバイダーは削除済み。lean mode のようなツール削減は既に実施済み
- Phase単位で段階的に適用（startup改善 → memory削減 → build最適化）

---

## 6. 今後のアクション

1. 各改善のコードレベル調査（上流の実装を確認）
2. DennouAibouへの適用計画文档作成
3. Phase 1: Gateway startup最適ization（lease解放、migration recovery）
4. Phase 2: Memory/Plugin loading最適化（cold-start reduction）
5. Phase 3: UI/Build最適化（route-loader、tsdown）
6. 各Phaseでcode-reviewer → KASOUデプロイ

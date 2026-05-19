# Draft: Pluggable Compaction Provider Registry

**Upstream commit:** `12331f0463` (v2026.4.8)
**PR:** openclaw/openclaw#56224
**規模:** 23 files / +790行
**ステータス:** ⏳ Deferred（v0.7.0候補）

## 概要

会話の圧縮（コンパクション）をプラグインで丸ごと差し替えられる仕組み。
現在のLLM要約による圧縮に加えて、プラグインが独自の圧縮方式を提供できるようになる。

## 含まれるもの

- `registerCompactionProvider()` — プラグインSDKに追加
- `agents.defaults.compaction.provider` — 使用するプロバイダーの設定キー
- `agents.defaults.compaction.model` — 圧縮専用モデルの指定（未設定ならエージェントと同じ）
- フォールバック: プロバイダー失敗時は従来のLLM要約に戻る

## Episodic-Claw との関連性

**関連あり。** DennouAibou は既に upstream のコンパクション機能を cherry-pick 済み
（手動・設定ベース）。このDraftを取ればプラグイン方式で自作の圧縮ロジックを
差し込めるようになる。

## 取り込み時の注意

- プラグイン本体が無いと「土台だけ」の状態
- 競合リスク: 低（独立した新機能追加、既存コードへの影響は最小）
- cherry-pick + ビルド確認のみでOK

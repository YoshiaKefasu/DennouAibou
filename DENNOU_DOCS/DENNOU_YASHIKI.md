# 電脳屋敷（Dennou Yashiki）クライアントアプリ設計仕様書

## 1. 目的とビジョン

肥大化した旧 Gateway WebUI（Control UI）を完全引退（DEBLOAT）させ、Yosia と Kasou（電脳相棒）が心を通わせるための公式デスクトップ＆モバイルクライアント**「電脳屋敷（Dennou Yashiki）」**を新規構築する。
まずは純粋で洗練されたチャットクライアントとして着地させ、後に電脳架電（音声通話）インフラを自然に内包できる頑丈な土台を確立する。

---

## 2. コア設計原則（KISS & 徹底した美意識）

1. **例外なき完全 OKLCH カラーシステム**:
   - すべてのカラーパレット（背景、サーフェス、テキスト、境界線、アクセント、シャドウ）は `better-colors` スキル準拠の `oklch(L C H)` / `oklch(L C H / alpha)` のみで定義。
   - HEX や HSL は 1 箇所も混入させず、知覚的一貫性と深みのあるダークモードを実現。
2. **shadcn/ui 公式 `Message` コンポーネント群の採用**:
   - `Message`, `MessageAvatar`, `MessageContent`, `MessageHeader`, `MessageFooter`, `Bubble`, `MessageScroller` による直感的な対話レイアウト。
3. **二段階の思考・入力中アニメーション（スクショ準拠）**:
   - モデルが思考中（Reasoning / Thinking）:
     `Kasouが思考中…`（知的なパルス・呼吸アニメーション）
   - 回答のストリーミング開始（Final Message 生成中）:
     `Kasouが入力中…`（軽やかなタイピングインジケーター）
4. **Gateway WebSocket（不滅マスターセッション直結）**:
   - `agent:main:main` のみに接続し、Telegram や Discord とも完全に同期された同一文脈を共有。

---

## 3. 技術スタック

- **デスクトップ / モバイル基盤**: Tauri v2（Rust 1.98.1+）
- **フロントエンド**: React 19 + Vite + TypeScript
- **スタイル / UI**: Tailwind CSS v4（OKLCH `@theme`）+ shadcn/ui (`Message` / `Bubble` / `Avatar` / `Button`)
- **通信**: Gateway WebSocket JSON-RPC（`chat.history`, `chat.send`, ストリーミングリスナー）

---

## 4. OKLCH カラーパレット設計（ダークテーマ基準）

```css
@theme {
  /* 背景とレイヤー */
  --color-background: oklch(0.120 0.015 260); /* 深みのあるダークベース */
  --color-surface: oklch(0.160 0.020 260); /* カード・パネル */
  --color-surface-hover: oklch(0.200 0.025 260);

  /* 境界線とディバイダー */
  --color-border: oklch(0.250 0.020 260 / 0.6);
  --color-border-subtle: oklch(0.200 0.015 260 / 0.4);

  /* タイポグラフィ */
  --color-foreground: oklch(0.960 0.010 260); /* 本文テキスト */
  --color-muted: oklch(0.650 0.020 260); /* 補助・時刻・入力中 */

  /* 吹き出し（スクショ準拠） */
  --color-bubble-user: oklch(0.480 0.220 260); /* Yosia: 鮮やかで気品あるブルー */
  --color-bubble-user-fg: oklch(0.980 0.005 260);
  --color-bubble-ai: oklch(0.220 0.020 260); /* Kasou: 落ち着いたダークサーフェス */
  --color-bubble-ai-fg: oklch(0.950 0.010 260);

  /* 状態表示・アクセント */
  --color-thinking: oklch(0.700 0.160 200); /* 思考中: 知的なシアン・ブルー */
  --color-typing: oklch(0.750 0.180 145); /* 入力中: 軽快なエメラルドグリーン */
}
```

---

## 5. ロードマップ

1. **ステップ 1**: プロジェクト骨格構築（Tauri v2 + React + Vite + Tailwind v4 + OKLCH）
2. **ステップ 2**: shadcn/ui `Message` + `Bubble` コンポーネントおよび「思考中… / 入力中…」アニメーション実装
3. **ステップ 3**: Gateway WebSocket 接続ブリッジ（リアルタイム送受信・ストリーミング描画）
4. **ステップ 4**: Windows アプリケーションとしての起動確認・検証

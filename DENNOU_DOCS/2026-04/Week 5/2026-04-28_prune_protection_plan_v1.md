# 2026-04-28 Prune Protection Plan — ワークスペースファイル＆キーワード保護

> **前提**: Active Session Tools Prune (v1) 実装済み。本プランはpruneエンジンに「保護ルール」を追加する。

---

## 0. 目的

- エージェントが自分のワークスペース内ファイル（SOUL.md, AGENTS.md, DENNOU_RULES.md 等）を読み取ったツール出力がpruneされないようにする。
- コンテンツ内に特定キーワード（"AGENTS.md" 等）を含むツール出力も保護する。
- pruneエンジンの共通ロジック（`prune-engine.ts`）に保護ルールを追加し、Closed-Only v2 と Active Session Prune の両方に適用する。

---

## 1. 現状分析

### 証拠1: toolResultの構造

`src/agents/pi-embedded-runner/compact.hooks.harness.ts` L76-83 で確認済み：

```json
{
  "role": "toolResult",
  "toolCallId": "t1",
  "toolName": "exec",
  "content": [{ "type": "text", "text": "出力内容" }],
  "isError": false
}
```

**`toolName` フィールドでツール名を取得できる。** `content[].text` でコンテンツ内のキーワード検索が可能。

### 証拠2: 現在のpruneエンジンにはツール名・コンテンツの判定がない

`src/dennou-soul/prune-engine.ts` L32-36 の `isToolResultEntry()` は `role === "toolResult"` のみで判定。ツール名やコンテンツの内容は一切見ていない。

### 証拠3: ワークスペースパスはランタイムで自動取得できる

`src/agents/agent-scope.ts` L271 の `resolveAgentWorkspaceDir(cfg, agentId)` が各エージェントのワークスペースルートパスを返すpublic API。`listAgentIds(cfg)` と組み合わせれば全エージェントのワークスペースパスを動的に列挙できる。ハードコード不要。

```typescript
// ランタイムでの自動取得例
import { resolveAgentWorkspaceDir, listAgentIds } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";

const cfg = getRuntimeConfig();
const workspacePaths = listAgentIds(cfg).map(id => resolveAgentWorkspaceDir(cfg, id));
// → ["d:\\GitHub\\OpenClaw Related Repos\\DennouAibou", ...]
```

---

## 2. 設計方針

### 2層の保護ルール

| # | ルール | 判定方法 | 保護対象 |
|---|---|---|---|
| 1 | **キーワード保護** | `content[].text` に `protectedContentKeywords` のいずれかが含まれる | AGENTS.md, SOUL.md, DENNOU_RULES 等の内容を含むツール出力 |
| 2 | **ワークスペースパス保護** | `content[].text` に `resolveAgentWorkspaceDir()` で自動取得したパスが含まれる | エージェントのワークスペース内の全ファイル読み取り結果 |

**判定順序**: キーワード → ワークスペースパス → 通常のprune判定（minPrunableToolChars, keepLastTools）

### KISSを維持する設計判断

- ツール名ベースの保護リストは**使わない**（粒度が粗すぎる：`readFile` で読んだ全ファイルが保護される）
- 正規表現も**使わない**（オーバーキル。単純な部分文字列マッチで十分）
- ワークスペースパスは**ランタイムで自動解決**。`resolveAgentWorkspaceDir()` を使うため、設定ファイルへのハードコード不要。エージェント追加・ワークスペース変更時も自動追従する

---

## 3. 設定スキーマ

```typescript
// src/dennou-soul/types.ts に追加
export interface DennouPruneProtectionConfig {
  /** コンテンツにこのキーワードが含まれていればpruneしない */
  protectedContentKeywords: string[];
  /** ランタイムで自動注入されるワークスペースパス（設定ファイルには書かない） */
  resolvedWorkspacePaths: string[];
}
```

### デフォルト値

```json
// dennou-config.json に追加
{
  "pruneProtection": {
    "protectedContentKeywords": [
      "AGENTS.md",
      "SOUL.md",
      "DENNOU_RULES"
    ]
  }
}
```

> **設計判断**: `resolvedWorkspacePaths` は設定ファイルに書かない。`idle-prune-watcher.ts` の初期化時に `resolveAgentWorkspaceDir()` で自動取得し、pruneエンジンに渡す。ユーザーがワークスペースを変更しても自動追従する。

> **設計判断**:
> - `protectedContentKeywords` は大文字小文字を区別しない（case-insensitive）
> - `resolvedWorkspacePaths` はパス区切りを正規化して比較（`\\` と `/` を統一）
> - キーワードは設定ファイルで管理、ワークスペースパスはランタイム自動解決

---

## 4. pruneエンジンへの変更

### 変更箇所: `src/dennou-soul/prune-engine.ts`

```diff
 // pruneToolOutputLines() 内、文字数チェックの前に追加

+    // 保護ルール: キーワードマッチ
+    if (isProtectedByKeyword(entry, protection)) {
+      resultLines.push(line);
+      continue;
+    }
+
+    // 保護ルール: ワークスペースパスマッチ
+    if (isProtectedByWorkspacePath(entry, protection)) {
+      resultLines.push(line);
+      continue;
+    }
+
     // 文字数チェック
     const contentLength = getToolResultContentLength(entry);
```

### 新規関数

```typescript
/** コンテンツ内にprotectedContentKeywordsのいずれかが含まれるか */
function isProtectedByKeyword(
  entry: JsonlEntry,
  protection?: DennouPruneProtectionConfig,
): boolean {
  if (!protection?.protectedContentKeywords?.length) return false;
  const text = getToolResultTextContent(entry).toLowerCase();
  return protection.protectedContentKeywords.some(
    (keyword) => text.includes(keyword.toLowerCase()),
  );
}

/** コンテンツ内にワークスペースパス（ランタイム自動取得）が含まれるか */
function isProtectedByWorkspacePath(
  entry: JsonlEntry,
  protection?: DennouPruneProtectionConfig,
): boolean {
  if (!protection?.resolvedWorkspacePaths?.length) return false;
  const text = normalizePathSeparators(getToolResultTextContent(entry));
  return protection.resolvedWorkspacePaths.some(
    (wsPath) => text.includes(normalizePathSeparators(wsPath)),
  );
}

function normalizePathSeparators(s: string): string {
  return s.replace(/\\/g, "/").toLowerCase();
}
```

---

## 5. 実装フェーズ

### Phase 1: 型定義と設定読み込み（見積：小, 数時間）

- `src/dennou-soul/types.ts` に `DennouPruneProtectionConfig` 追加（`resolvedWorkspacePaths` はランタイム注入用）
- `DennouConfig` に `pruneProtection` フィールド追加（`protectedContentKeywords` のみ設定ファイル管理）
- `src/dennou-soul/config.ts` に `pruneProtection` のデフォルト値とマージロジック追加

### Phase 2: pruneエンジン改修 + ワークスペース自動解決（見積：小, 数時間）

- `src/dennou-soul/prune-engine.ts` に保護関数を追加
- `pruneToolOutputLines()` のシグネチャに `protection?: DennouPruneProtectionConfig` を追加
- `idle-prune-watcher.ts` の初期化時に `resolveAgentWorkspaceDir()` + `listAgentIds()` で全ワークスペースパスを取得し、`resolvedWorkspacePaths` に注入
- Closed-Only版 (`prune-closed-sessions.ts`) とActive版 (`prune-active-session.ts`) の呼び出し元でprotection設定を渡す

### Phase 3: テスト（見積：小, 数時間）

- `prune-engine.test.ts` に保護ルールのテストケースを追加：
  - キーワード "AGENTS.md" を含むtoolResult → pruneされない
  - ワークスペースパスを含むtoolResult → pruneされない
  - どちらも含まないtoolResult → 通常通りprune
  - キーワードの大文字小文字不一致でも保護される
  - パス区切り（`\\` vs `/`）が違っても保護される

---

## 6. ロールバック計画

- **設定のみ**: `pruneProtection.protectedContentKeywords: []` で保護を無効化（ワークスペースパスはランタイム解決のため設定不要）
- **実装全体**: `prune-engine.ts` の保護チェック2行を削除するだけ

---

## 7. 参考

- toolResult構造: `src/agents/pi-embedded-runner/compact.hooks.harness.ts` L76-83
- pruneエンジン: `src/dennou-soul/prune-engine.ts`
- ワークスペース自動解決: `src/agents/agent-scope.ts` L271 `resolveAgentWorkspaceDir()`
- エージェントID列挙: `src/agents/agent-scope.ts` L65 `listAgentIds()`
- Active Session Prune Plan: `2026-04-28_active_session_tools_prune_plan_v1.md`
 - Closed-Only Prune Plan (v2): `2026-04-26_session_prune_plan_v2.md`

---

## 8. 実装状態（2026-04-28）

### 全フェーズ完了

| Phase | ファイル | 状態 | 備考 |
|---|---|---|---|
| Phase 1 | `src/dennou-soul/types.ts` | ✅ 完了 | `DennouPruneProtectionConfig` 追加（`protectedContentKeywords` + `resolvedWorkspacePaths`） |
| Phase 1 | `src/dennou-soul/config.ts` | ✅ 完了 | `pruneProtection` デフォルト値 + マージロジック。`resolvedWorkspacePaths` は設定ファイルから上書き禁止 |
| Phase 2 | `src/dennou-soul/prune-engine.ts` | ✅ 完了 | `isProtectedByKeyword()`, `isProtectedByWorkspacePath()`, `getToolResultTextContent()` 追加。`pruneToolOutputLines()` に protection 引数追加 |
| Phase 3 | `src/dennou-soul/prune-closed-sessions.ts` | ✅ 完了 | 全関数に protection 引数を伝搬 |
| Phase 3 | `src/dennou-soul/prune-active-session.ts` | ✅ 完了 | 全関数に protection 引数を伝搬 |
| Phase 3 | `src/dennou-soul/session-maintenance-hook.ts` | ✅ 完了 | `resolveProtectionWithWorkspacePaths()` 追加。閉じたセッションでもパス保護が有効に |
| Phase 3 | `src/dennou-soul/idle-prune-watcher.ts` | ✅ 完了 | `handleIdleEvent()` と `startIdlePruneWatcher()` に protection 引数追加 |
| Phase 3 | `src/cli/run-main.ts` | ✅ 完了 | 起動時に `resolveAgentWorkspaceDir()` + `listAgentIds()` でワークスペースパスを自動解決し保護設定に注入 |
| Phase 4 | `src/dennou-soul/prune-engine.test.ts` | ✅ 完了 | 14テスト（キーワード保護、パス保護、同時適用、後方互換性） |

### 設計との整合性

- **キーワード保護**: プラン通り、`protectedContentKeywords` は case-insensitive マッチ
- **ワークスペースパス保護**: プラン通り、ランタイム自動解決（`resolveAgentWorkspaceDir()`）。パス区切りは正規化して比較
- **判定順序**: キーワード → ワークスペースパス → 通常のprune判定（文字数 → keepLastTools）。プラン通り
- **ツール名ベースの保護**: 使わない。プランの設計判断通り
- **KISS維持**: 単純な部分文字列マッチのみ、正規表現なし

### テスト結果

- `prune-engine.test.ts`: **14 passed**（新規）
- `prune-closed-sessions.test.ts`: **11 passed**（リファクタ後も既存動作維持）
- `prune-active-session.test.ts`: **13 passed**（リファクタ後も既存動作維持）
- 合計: **38 passed**

### レビュー結果（2026-04-28）

| # | 判定 | 備考 |
|---|---|---|
| ✅ | `prune-engine.ts` | 保護関数のロジック正しい。case-insensitive + パス正規化 + 判定順序も正しい |
| ✅ | 呼び出し元伝搬 | `prune-closed-sessions`, `prune-active-session`, `idle-prune-watcher` すべて正しく protection を伝搬 |
| ✅ | `session-maintenance-hook.ts` | ✅ 修正済み。`resolveProtectionWithWorkspacePaths()` で閉じたセッションでも自動解決 |
| ✅ | 後方互換性 | protection 未指定でも既存動作を維持 |
| ✅ | テスト | 14/14 全通過 |

**批判的バグ: なし**

---

## 9. v1.1 Hardening（2026-04-30）

### 目的

「workspace配下に関する出力は常に保護」を、取りこぼしが出にくい形へ強化する。

### 変更点

- 変更ファイル: `src/dennou-soul/prune-engine.ts`
- 変更関数: `isProtectedByWorkspacePath()`
- 仕様:
  - 従来どおり `message.content[].text` を判定対象にする
  - 追加で JSONL 生行 (`entry.raw`) も判定対象にする
  - `entry.raw` 側は JSON エスケープされた Windows パス（`\\\\`）を `\\` に戻してから比較する
  - どちらか一方で workspace path に一致したら保護する

### これで防げる取りこぼし

- パスが `content[].text` ではなく、別フィールドに入っている toolResult
- Windows パスが JSON エスケープされたまま保存されるケース

### トレードオフ

- 安全側（過保護）に寄せた判定。
- 部分一致なので、稀に無関係な行を保護する可能性はある。
- ただし DennouAibou の方針（誤削除回避優先）と整合するため許容。

### テスト

- 追加: `src/dennou-soul/prune-engine.test.ts`
  - `content[].text` にパスが無くても、`entry.raw` 側に workspace path があれば保護されることを検証

### 実行した検証コマンド

- `pnpm test src/dennou-soul/prune-engine.test.ts` ✅
- `pnpm test src/dennou-soul/prune-active-session.test.ts` ✅
- `pnpm test src/dennou-soul/prune-closed-sessions.test.ts` ✅

---

## 10. Bugfix: sessionsDir path doubled（2026-05-01）

### 症状

Kasou のログに以下の警告が常に出る：

```
[DennouAibou] SKIP (directory not found): /home/kasou_yoshia/.openclaw/agents/main/sessions/sessions
```

`/sessions/sessions` と sessions が2回重なっているため、存在しないディレクトリを参照し、閉じたセッションの prune が一切実行されていなかった。

### 原因

`src/dennou-soul/session-maintenance-hook.ts:54` で、
上流から渡される `storePath` の形式を誤って仮定していた。

- JSDoc コメントには `~/.openclaw/agents/{agentId}/store.json` と書かれていた。
- しかし実際に上流から渡される `storePath` は `.../sessions/sessions.json` の形式。
- `path.dirname(storePath)` で既に `sessions/` ディレクトリが得られるのに、さらに `path.join(..., "sessions")` で連結していた。

結果：`/sessions/sessions` の二重化。

### 修正

| 項目 | 内容 |
|---|---|
| 変更ファイル | `src/dennou-soul/session-maintenance-hook.ts` |
| 変更行 | 54行目（1行のみ） |
| Before | `const sessionsDir = path.join(path.dirname(storePath), "sessions");` |
| After | `const sessionsDir = path.dirname(storePath);` |
| 理由 | `storePath` は既に `.../sessions/sessions.json` なので、`dirname` が正しい |

### テスト結果

- `pnpm test src/dennou-soul/prune-closed-sessions.test.ts` ✅
- `pnpm test src/dennou-soul/prune-engine.test.ts` ✅
- `pnpm test src/dennou-soul/prune-active-session.test.ts` ✅
- 合計 39 passed

### 影響

この1行の修正で、閉じたセッションの prune が初めて実際に機能するようになる（今までは SKIP で何もできていなかった）。

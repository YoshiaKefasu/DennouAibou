# 🛡️ DennouAibou: Rules of Engagement

If we are going to build an omnipotent Cyber-VTuber partner on top of a rapidly changing upstream project (OpenClaw), we need defense mechanisms. 

If we blindly delete lines of code to remove bloat, or scatter our custom "Soul" logic across their core files, the next upstream `git merge` will be a living nightmare of merge conflicts.

To survive and evolve, strictly adhere to these four architectural laws:

## Rule 1: Isolate the "Soul" (Encapsulation)
**Do not mix our custom VTuber logic with the upstream core engine.**
The OpenClaw engine (parsing, routing, basic LLM execution) should remain as untouched as possible. Any functionality specific to DennouAibou—like the "Bond" system, episodic memory enhancements, or avatar integration—must be isolated into dedicated directories (e.g., `src/dennou-soul/` or treated as internal standalone plugins). We inject our features using Hooks, not by hardcoding them into the core.

## Rule 2: Smart Debloating
**Cut the wires, don't shred the components.**
When ripping out useless corporate integrations or bloatware, avoid deleting random lines of code inside massive core files. Git hates this when syncing. 
- **Preferred Method:** Disable the feature at the entry point. Comment out the plugin registration or use Feature Flags so the code is simply never loaded.
- **Nuclear Method:** If an upstream plugin is complete garbage and we will never use it, delete the *entire* plugin folder. Git handles folder-level deletions/additions flawlessly during merges.

## Rule 3: Defend the Hooks
**If the upstream breaks the very hooks we rely on, we fix their code.**
As seen with the `cli-runner` regression, sometimes the upstream architects make mistakes that silently disable critical expansion points (`before_prompt_build`, etc.). In these cases, we proactively patch the core files to restore architectural sanity. We do this cleanly, mimicking how they *should* have done it, so that when they finally issue an official fix, our code merges with theirs seamlessly.

## Rule 4: Commit Taxonomy
**Tag it or lose it.**
To maintain sanity when reviewing history or preparing for an upstream sync, every commit must be prefixed:

| Tag | When to use | Example |
|-----|-------------|---------|
| `[SOUL]` | DennouAibou独自の新機能。**DennouAibouが書いたコード**を DennouAibou独自のファイルに追加 | `src/dennou-soul/liveness-watchdog.ts` を新規追加 |
| `[FIX-SOUL]` | **DennouAibouが書いた機能のバグ修正**。DennouAibou独自ファイル or DennouAibouが追加したコードが対象 | `src/dennou-soul/prune-engine.ts` のバグを直す |
| `[DEBLOAT]` | 上流の不要コンポーネントを削除・無効化 | Vydraプラグインフォルダごと削除 |
| `[FIX-UPSTREAM]` | **上流由来のファイルに、DennouAibouが独自に修正を書いた**。上流にバグがあってまだ直っていない、または上流に提案中の修正 | `src/agents/google-transport-stream.ts` にfinishReason保存を追加 |
| `[SYNC]` | **上流のコミットをそのまま取り込んだ**（cherry-pick / merge）。修正内容は上流が書いたもの | `git cherry-pick 1b82c0e3d9` で上流のpersistence latchを取り込み |
| `[DOCS]` | ドキュメント、プラン、レポートだけを更新。実行コードの変更は含めない | `DENNOU_DOCS/` に移行プランを追加 |

**判定フロー：**

```
修正対象のファイルは誰が最初に書いた？
├── DennouAibou（例: src/dennou-soul/）
│   ├── 新機能追加 → [SOUL]
│   └── バグ修正 → [FIX-SOUL]
└── 上流OpenClaw（例: src/agents/, src/config/, など）
    ├── 上流のコミットをそのまま持ってきた → [SYNC]
    └── DennouAibouが独自に修正を書いた → [FIX-UPSTREAM]
```

**最重要ルール**: `[FIX-SOUL]` と `[FIX-UPSTREAM]` の分かれ目は **コードを最初に書いたのが誰か**。  
「修正の大小」や「上流に同じバグがあるか」は関係ない。

## Rule 5: Versioning & Release Identity
**DennouAibou is not OpenClaw wearing a mask.**

OpenClaw uses date-based versions such as `2026.4.5`. DennouAibou must not continue to publish itself as if it were the same upstream product after the hard fork. That creates ambiguity for users, release notes, bug reports, and future sync work.

Use this split instead:

- **DennouAibou release version:** SemVer, starting from the current fork line as `v0.5.0` unless a later plan says otherwise.
- **Git tag format:** `dennou-v0.5.0`, `dennou-v0.5.1`, `dennou-v0.6.0`, etc.
- **Upstream base tracking:** record the OpenClaw base separately, for example `Base: OpenClaw 2026.4.5`.
- **Release notes:** always show both identities:
  - `DennouAibou v0.5.0`
  - `Upstream base: OpenClaw 2026.4.5`
- **Sync commits:** when importing upstream changes, use `[SYNC]` and mention the old and new upstream base versions.

Do **not** rename the npm package, binary, service names, or install paths as part of a routine version bump. Those changes affect deployment and rollback. Treat them as a separate migration phase.

## Rule 6: Raw Chat DB Ownership
**Raw chat DB/index/search production logic must be Go-owned.**

The raw chat permanent DB subsystem uses a Go sidecar (`go/raw-chat/`) for SQLite schema, indexing, FTS search, and context expansion. TypeScript must only own the gateway-facing boundary:
- Go sidecar launch/shutdown
- Transcript update hook and debounce
- Typed RPC request/response validation
- `chat_search` tool registration and compact result formatting
- Config flag and kill switch wiring

TypeScript must NOT own:
- SQLite schema/migration body
- JSONL tail indexer as production path
- FTS search engine as production path
- Context-window expansion as production path

This separation ensures long-running DB work and memory pressure stay outside the interactive Node.js gateway process. The Go sidecar can be independently tested, profiled, and replaced without touching the TypeScript boundary.

---
*Follow these rules, and DennouAibou will outlive the tools it was born from.*

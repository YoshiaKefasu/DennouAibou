# 2026-04-28 DennouAibou Versioning & Release Identity Policy v1

## 0. 結論

DennouAibou は、OpenClaw の日付版番をそのまま使わない。

DennouAibou 本体は SemVer で管理する。

推奨開始点は次の形。

```text
DennouAibou v0.5.0
Base: OpenClaw 2026.4.5
Git tag: dennou-v0.5.0
```

---

## 1. なぜ分けるか

OpenClaw は `2026.4.5` のような日付版番を使う。

しかし DennouAibou は hard fork した。

`DENNOU_RULES.md` でも、`[SOUL]`、`[DEBLOAT]`、`[FIX-UPSTREAM]`、`[SYNC]` を分けて管理している。

つまり今後は、次の2つを分けて考える必要がある。

1. DennouAibou として何をリリースしたか
2. どの OpenClaw 版を土台にしているか

同じ `2026.4.5` を名乗り続けると、ユーザーにも開発者にもわかりにくい。

「これはOpenClaw本家のバグか、DennouAibou独自の変更か」が追いにくくなる。

---

## 2. 版番ルール

### DennouAibou本体

SemVer を使う。

```text
v0.5.0
v0.5.1
v0.6.0
v1.0.0
```

当面は `v0.x.y` とする。

まだ hard fork 後の設計が動いているため、`v1.0.0` は安定した配布・更新・rollback方針が固まってからでよい。

### Git tag

OpenClaw 本家タグと衝突しないよう、必ず `dennou-` prefix を付ける。

```text
dennou-v0.5.0
dennou-v0.5.1
dennou-v0.6.0
```

### Upstream base

OpenClaw の土台版は別に記録する。

```text
Base: OpenClaw 2026.4.5
```

上流同期をしたら、リリースノートと `[SYNC]` commit に old/new を書く。

```text
[SYNC] Update upstream base from OpenClaw 2026.4.5 to 2026.4.10
```

---

## 3. リリースノート形式

リリースノートの先頭はこの形にする。

```markdown
# DennouAibou v0.5.0

Upstream base: OpenClaw 2026.4.5

## Highlights
- ...

## DennouAibou changes
- [SOUL] ...
- [DEBLOAT] ...
- [FIX-UPSTREAM] ...

## Upstream sync
- Base remains OpenClaw 2026.4.5
```

---

## 4. package.json の扱い

短期では、`package.json` の `name`、binary名、service名、install path は変えない。

理由は単純。

ここを変えると、既存のインストール、systemd unit、gateway起動、rollbackが一気に難しくなる。

まずは次の順番で分離する。

1. Git tag と GitHub Release 名を `dennou-v0.5.0` に分ける
2. リリースノートに `Base: OpenClaw 2026.4.5` を書く
3. 内部ドキュメントとcommit taxonomyで追跡する
4. 将来、配布経路が安定してから `package.json.name` やbinary名の変更を検討する

---

## 5. SemVerの上げ方

### PATCH: `v0.5.0` → `v0.5.1`

小さな修正。

- バグ修正
- テスト修正
- ドキュメント修正
- 既存挙動を変えない小改善

### MINOR: `v0.5.x` → `v0.6.0`

ユーザーに見える機能追加。

- 新しい `dennou` 設定
- 新しいSoul機能
- 新しいprune/compaction機能
- UIに新しい設定面を追加

### MAJOR: `v0.x` → `v1.0.0`

安定宣言。

- インストール手順が安定
- リリース・rollback手順が安定
- OpenClaw sync方針が定着
- DennouAibou独自設定が十分に固まった

---

## 6. 今回の推奨

次の正式リリースは `dennou-v0.5.0` とする。

理由:

- `src/dennou-soul/` が追加された
- `dennou` config が `openclaw.json` に統合された
- WebUIにDennouAibou設定セクションが追加された
- active/closed session prune が入った
- OpenClawからhard forkして軽量化方針が明確になった

これはpatchではなく、DennouAibouとしての最初の独立リリースに近い。

そのため `v0.5.0` が妥当。

---

## 7. まだやらないこと

以下は別フェーズに回す。

- `package.json.name` を `dennou-aibou` に変える
- binary名を `openclaw` から `dennou-aibou` に変える
- service名やsystemd unit名を変える
- npm publish名を変える

ここは影響範囲が広い。

今は release identity を分けるだけで十分。

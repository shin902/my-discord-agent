# taskmd フォーマット仕様

[taskmd](https://github.com/driangle/taskmd) 互換の最小サブセット。将来サンドボックス外で
公式 CLI / Web ダッシュボードに移行できるよう、フィールド名はオリジナルに揃えている。

## ディレクトリ配置

```
/workspace/tasks/            # タスクのルート（グループごとに分離）
  001-add-auth.md
  002-fix-poller-race.md
  web/                       # サブディレクトリで分類してもよい（任意）
    010-graph-view.md
```

ファイル名は `{id}-{slug}.md`。`id` はゼロ埋め3桁の連番（`001` 〜）。`slug` は title を
小文字ハイフン化したもの。

## frontmatter スキーマ

```yaml
---
id: "001"                    # 必須。ゼロ埋め文字列。ファイル名の接頭辞と一致させる
title: "Add user authentication"  # 必須
status: pending              # 必須。pending / in_progress / blocked / done
priority: medium             # 必須。high / medium / low
effort: medium               # 任意。small / medium / large
type: feature                # 任意。feature / bug / chore / docs / refactor
dependencies: []             # 任意。先に done であるべき id の配列。例: ["002", "005"]
files: []                    # 任意。主に触るファイルパス。並列作業の衝突検出に使う
tags: []                     # 任意
created: "2026-06-23"        # 任意。YYYY-MM-DD
---
```

## 本文

frontmatter が構造、本文が人間とエージェントのための文脈。

```markdown
# Add User Authentication

## Objective
何を・なぜやるかを1〜3文で。

## Acceptance Criteria
- [ ] 完了条件を1つずつチェックボックスで
- [ ] テストが通る
- [ ] レビュー済み

## Notes
補足・設計メモ・参考リンクなど（任意）
```

## ステータスの考え方

- `status` フィールドが「タスク全体の状態」の正。
- 本文の `- [ ]` チェックボックスは「Acceptance Criteria のサブ項目」専用。
  全部チェックが付いたら `status: done` に上げる、という2層構造にすると破綻しにくい。
- 依存先がまだ done でないタスクは `blocked` 扱い（`next.py` が自動判定する）。

## ヘルパースクリプト

いずれも Python 3 標準ライブラリのみ。ゼロ依存。

```bash
python3 /workspace/SKILLS/taskmd/next.py        # 次にやるべきタスクを推奨
python3 /workspace/SKILLS/taskmd/next.py --all  # 全タスク一覧
python3 /workspace/SKILLS/taskmd/validate.py    # frontmatter とスキーマを検証
```

タスクディレクトリを変えたい場合は第1引数で渡す（既定 `/workspace/tasks`）:

```bash
python3 /workspace/SKILLS/taskmd/next.py /workspace/tasks
```

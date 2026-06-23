---
name: task-add
description: "新しいタスクを taskmd 形式で /workspace/tasks/ に作成する。ユーザーが「タスクを追加して」「これをタスクにして」「TODOに入れて」と言ったとき、または会話の中で後でやるべき作業が出てきたときに使う。プロジェクトの文脈から目的・受け入れ条件・優先度・依存を埋める。"
---

# task-add

新しいタスクを taskmd 形式の Markdown ファイルとして作成する。
フォーマットの詳細は taskmd スキルの `spec.md` を参照（有効な場合）。

依頼内容: $ARGUMENTS$

## 手順

### 1. 既存タスクを確認して id を決める
`/workspace/tasks/` を `glob` して既存ファイルを見る。最大の id +1 をゼロ埋め3桁で
採番する（最初のタスクなら `001`）。タスクが無ければディレクトリごと作る。

```bash
python3 /workspace/SKILLS/taskmd/next.py --all   # 既存の全体像（taskmd が有効なら）
```

### 2. 内容を組み立てる
依頼とプロジェクトの文脈（`AGENTS.md`・関連コード）から以下を埋める。曖昧な点は
勝手に決めつけず、重要なものだけユーザーに1つ確認する。

- **title**: 命令形で簡潔に
- **priority**: high / medium / low（不明なら medium）
- **effort**: small / medium / large（任意）
- **type**: feature / bug / chore / docs / refactor（任意）
- **dependencies**: 先に終わっているべき既存タスクの id（あれば）
- **files**: 主に触るファイルパス（分かれば。並列作業の衝突検出に使う）
- **Objective**: 何を・なぜやるか 1〜3文
- **Acceptance Criteria**: 「何をもって完了か」をチェックボックスで列挙

### 3. ファイルを書く
`/workspace/tasks/{id}-{slug}.md` に `write` で作成する。`slug` は title を
小文字ハイフン化したもの。

```markdown
---
id: "001"
title: "Add user authentication"
status: pending
priority: high
effort: medium
type: feature
dependencies: []
files: []
tags: [auth]
created: "2026-06-23"
---
# Add User Authentication

## Objective
APIレイヤーに JWT 認証を実装する。

## Acceptance Criteria
- [ ] メールとパスワードでログインできる
- [ ] JWT は24時間で失効する
- [ ] 有効なトークンが無い保護エンドポイントは 401 を返す

## Notes
```

`created` の日付は `date +%Y-%m-%d` で取得する。

### 4. 検証して報告
作成後に検証し、作った id・title・優先度を一言で報告する。

```bash
python3 /workspace/SKILLS/taskmd/validate.py
```

## 注意

- 大きすぎる依頼は、1つのタスクに押し込めず複数タスクに分割し、`dependencies` で
  順序を表現する。
- 受け入れ条件のないタスクは作らない。最低1つは書く。

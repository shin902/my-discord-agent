---
name: task-add
description: "Create a new task in taskmd format under /workspace/tasks/. Use this when the user says 「タスクを追加して」, 「これをタスクにして」, or 「TODOに入れて」, or when conversation reveals work to do later. Fill in purpose, acceptance criteria, priority, and dependencies from project context."
---

# task-add

Create a new task as a Markdown file in taskmd format.
See the taskmd skill's `spec.md` for format details (when enabled).

Request: $ARGUMENTS$

## Procedure

### 1. Inspect existing tasks and determine the id
Use `glob` on `/workspace/tasks/` to inspect existing files. Assign the maximum id + 1,
zero-padded to three digits (use `001` for the first task). If there are no tasks, create the directory as well.

```bash
python3 /workspace/SKILLS/taskmd/next.py --all   # Overview of all existing tasks (if taskmd is enabled)
```

### 2. Assemble the content
Fill in the following from the request and project context (`AGENTS.md` and related code). Do not make assumptions about ambiguous points; ask the user one question only when the ambiguity is important.

- **title**: concise and imperative
- **priority**: high / medium / low (use medium if unknown)
- **effort**: small / medium / large (optional)
- **type**: feature / bug / chore / docs / refactor (optional)
- **dependencies**: ids of existing tasks that must be completed first (if any)
- **files**: main file paths to touch, if known (used to detect conflicts in parallel work)
- **Objective**: what to do and why, in 1–3 sentences
- **Acceptance Criteria**: list checkboxes defining what counts as complete

### 3. Write the file
Create `/workspace/tasks/{id}-{slug}.md` with `write`. Make `slug` the title converted to lowercase hyphenated form.

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

Obtain the `created` date with `date +%Y-%m-%d`.

### 4. Validate and report
After creating the file, validate it and briefly report the created id, title, and priority.

```bash
python3 /workspace/SKILLS/taskmd/validate.py
```

## Notes

- If a request is too large, split it into multiple tasks instead of forcing it into one, and express their order with `dependencies`.
- Never create a task without acceptance criteria; include at least one.

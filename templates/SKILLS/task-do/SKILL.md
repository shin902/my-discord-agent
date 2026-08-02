---
name: task-do
description: "Operational protocol for executing an existing task. Use this when the user says 「このタスクをやって」, 「task 003 を進めて」, or 「次のタスクに着手して」. Move the task to in_progress, work through acceptance criteria one by one, then update it to done. Always write the task status back to the file."
---

# task-do

Protocol for carrying a task from start to completion. Because agents are ephemeral,
**always write progress back to the task file**, not only to the conversation. This is what carries the work into the next run.

Target task: $ARGUMENTS$

## Procedure

### 1. Identify the target
If an id is specified, read `{id}-*.md` from `/workspace/tasks/`. If none is specified, choose from the recommendations:

```bash
python3 /workspace/SKILLS/taskmd/next.py   # if taskmd is enabled
```

Check dependencies before starting. If any entry in `dependencies` is not `done`, do not start the task and report that fact (`next.py` excludes tasks with unresolved dependencies from its candidates).

### 2. Set the task to in progress
Before beginning work, update the frontmatter `status` to `in_progress` (using `edit`).
This lets other sessions and the next run know that someone is working on it.

### 3. Work through the acceptance criteria one by one
Implement the work needed to satisfy the body’s `## Acceptance Criteria`. Each time a criterion is met, update its checkbox in the body from `- [ ]` to `- [x]`.

- If you get stuck or a design decision is needed, add the context to `## Notes` and stop.
  This lets the next run resume with no conversational context.
- If you discover only after starting that a dependency or another task is needed, create a new task with task-add, add it to this task’s `dependencies`, and set `status` to `blocked`.

### 4. Complete the task
Once every checkbox is `- [x]`, update `status` to `done`.
Do not mark the task done before the acceptance criteria are satisfied; run any available tests first.

### 5. Validate and move on
```bash
python3 /workspace/SKILLS/taskmd/validate.py   # check consistency
python3 /workspace/SKILLS/taskmd/next.py       # next candidate
```

Report the completed id and title, along with the next candidate, in one sentence.

## Two-layer state management (important)

- The `status` field = the overall task state (pending / in_progress / blocked / done).
- A body `- [ ]` = a sub-item of the acceptance criteria.
- Keep the flow one-way — “all checks become marked → raise status to done” — to prevent the checkboxes and status from drifting out of sync and causing confusion.

## Do not

- Proceed only in conversation without writing progress to the file (it will all be lost on the next run).
- Start with unresolved dependencies.
- Mark a task done without satisfying its acceptance criteria.

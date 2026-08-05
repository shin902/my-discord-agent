---
name: taskmd
description: "Markdown-based task management for coding agents. Tasks persist as one file per task under /workspace/tasks/, with structure (status, priority, dependencies) in frontmatter and context (purpose, acceptance criteria) in the body. Use this when the user asks 「タスク一覧」, 「次に何をやる」, 「タスクの状況」, or 「やることを整理して」, or wants to manage multi-step work over time. Combine task-add for creating tasks and task-do for executing individual tasks."
---

# taskmd

[taskmd](https://github.com/driangle/taskmd)-compatible lightweight task management. Tasks are
persisted as Markdown files under `/workspace/tasks/` and survive across containers.
It uses no MCP or plugin; everything is handled with files and Python helpers.

For format details, use `read` to consult `spec.md` in the same directory.

## When to do what

### Understand the current state
Before starting work, first inspect the overall picture.

```bash
python3 /workspace/SKILLS/taskmd/next.py --all
```

This lists in-progress, not-started, dependency-blocked, and completed tasks by status.

### Choose the next task
When asked 「次は何をやるべき？」, provide a recommendation.

```bash
python3 /workspace/SKILLS/taskmd/next.py
```

It orders tasks that are `pending` and whose dependencies are all `done` by priority, then id. If any task is in progress, present it first. Do not take this output at face value; reconcile it with the user’s context (the recent conversation and urgency) to make the final decision — the deterministic ordering is a starting point, not an absolute rule.

### Create a task
For a new task, follow the `task-add` skill procedure when that skill is enabled. Otherwise, create `/workspace/tasks/{id}-{slug}.md` manually according to the schema in `spec.md`.

### Execute a task
For starting and completing an individual task, follow the `task-do` skill procedure. The key is two-layer management:
the `status` field is the overall task state, and body `- [ ]` items are acceptance-criteria sub-items.

### Check consistency
Validate after editing tasks. Detect missing required frontmatter, invalid values, nonexistent dependencies,
cyclic dependencies, and duplicate ids.

```bash
python3 /workspace/SKILLS/taskmd/validate.py
```

## Principles

- **The file is authoritative.** Write task state to the file, not the conversation history. Agents are ephemeral, so the file is all the next run can read.
- **Keep tasks small.** One task should be one cohesive unit of work. Split oversized work with dependencies.
- **Always write acceptance criteria.** Do not start a task that has no definition of done.
- **Connect dependencies by id.** For example, `dependencies: ["002"]` lets `next.py` determine automatically whether a task can start.
- **Tasks are grouped.** Because `/workspace` is separated by channel, each group has an independent task board.

## Constraints

- Python 3 is required (it is included in the sandbox). The helpers use only the standard library.
- bash times out after about 30 seconds, but this is fine because the operations target local files.

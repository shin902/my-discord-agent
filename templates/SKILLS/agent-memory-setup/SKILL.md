---
name: agent-memory-setup
description: "Explicitly initialize optional NanoClaw-style file memory in the current group workspace. Use only when the user asks to set up or initialize NanoClaw/OKF Agent Memory."
---

# Agent Memory

Initialize NanoClaw-style file memory only when the user explicitly requests it. This is an optional third memory mechanism: it does not replace, migrate, or synchronize `MEMORY.md`, `memory/SELF.md`, MemoryCore, session history, or existing memory cron jobs.

## Initialize

Run:

```bash
bash /workspace/SKILLS/agent-memory-setup/init.sh /workspace
```

The script creates only missing files:

```text
memory/
├── index.md
└── system/
    ├── index.md
    └── definition.md
```

Existing files are never overwritten. After initialization, read `memory/system/definition.md` and follow its OKF v0.1 memory doctrine. Manage the tree with the ordinary `read`, `write`, `edit`, `list`, `glob`, and `grep` tools. Never store secrets or credentials in memory.

## Bootstrap

`contextFiles` does not initialize memory, but if configured it injects the entry points into the agent's context at session start. After initialization, check whether `memory/index.md` and `memory/system/definition.md` are already visible in the current context:

- **Visible** — they were injected via `contextFiles`. Do nothing; use them as-is.
- **Not visible** — tell the user that the operator must add the following to the applicable group or channel in `config/groups.json` and restart the host:

```json
{
  "contextFiles": [
    { "path": "memory/index.md", "maxChars": 16000 },
    { "path": "memory/system/definition.md", "maxChars": 16000 }
  ]
}
```

Paths are relative to the group workspace. `contextFiles` uses a session-initial snapshot and is not added retroactively. A shared channel used for initialization keeps its existing session after a restart: start a new thread/channel with a new session ID after configuring `contextFiles` to receive the bootstrap.

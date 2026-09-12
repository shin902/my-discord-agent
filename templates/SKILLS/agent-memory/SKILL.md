---
name: agent-memory
description: "Explicitly initialize optional NanoClaw-style file memory in the current group workspace. Use only when the user asks to set up or initialize NanoClaw/OKF Agent Memory."
---

# Agent Memory

Initialize NanoClaw-style file memory only when the user explicitly requests
it. This is an optional third memory mechanism: it does not replace, migrate,
or synchronize `MEMORY.md`, `memory/SELF.md`, MemoryCore, session history, or
existing memory cron jobs.

## Initialize

Run:

```bash
bash /workspace/SKILLS/agent-memory/init.sh /workspace
```

The script creates only missing files:

```text
memory/
├── index.md
└── system/
    ├── index.md
    └── definition.md
```

Existing files are never overwritten. After initialization, read
`memory/system/definition.md` and follow its OKF v0.1 memory doctrine. Manage
the tree with the ordinary `read`, `write`, `edit`, `list`, `glob`, and `grep`
tools. Never store secrets or credentials in memory.

## Optional bootstrap

Initialization does not alter configuration, and `contextFiles` does not
initialize memory. If the user wants the entry points injected into the first
context of new sessions, tell them to add the following to the applicable
group, channel, cron job, or Bot profile and restart the host:

```json
{
  "contextFiles": [
    { "path": "memory/index.md", "maxChars": 16000 },
    { "path": "memory/system/definition.md", "maxChars": 16000 }
  ]
}
```

`contextFiles` uses a session-initial snapshot and is not added retroactively.
A shared channel used for initialization keeps its existing session after a
restart: explicitly read the workspace files there, or start a new
thread/channel with a new session ID after configuring `contextFiles`. Re-read
workspace files explicitly when their latest contents are needed during the
same session.
